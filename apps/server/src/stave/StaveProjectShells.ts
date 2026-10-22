/**
 * StaveProjectShells - V2 project shells with their Stave `stave` / `notice`
 * fields attached.
 *
 * V1 attached these in ProjectionSnapshotQuery. On V2 the durable project read
 * model is `ProjectStoreV2` (`projection_projects`), which knows nothing about
 * Stave, so every Stave reader decorates rows here: the manifest at the root
 * (through the cached `StaveWorkspaceReader`, enriched with saga membership
 * when available) and the lifecycle notice from `stave_project_lifecycle`.
 * The decoration never runs inside a SQL transaction.
 *
 * @module StaveProjectShells
 */
import type { OrchestrationProjectShell, ProjectId } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  StaveLifecycleRepository,
  type StaveLifecycleRow,
} from "../persistence/StaveLifecycleRepository.ts";
import { StaveDisplayMembership } from "./StaveDisplayMembership.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

export class StaveProjectShellsError extends Schema.TaggedError<StaveProjectShellsError>()(
  "StaveProjectShellsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Stave project read '${this.operation}' failed.`;
  }
}

/** The lifecycle notice a project shell shows for its cleanup row. */
function lifecycleNotice(
  lifecycleRow: Option.Option<StaveLifecycleRow>,
): OrchestrationProjectShell["notice"] {
  return Option.match(lifecycleRow, {
    onNone: () => null,
    onSome: (row) =>
      row.disposition === "pending_archive"
        ? {
            kind: "archive_scheduled" as const,
            ...(row.archiveDeadlineAt
              ? { at: row.archiveDeadlineAt }
              : {
                  code: "archive_suggested",
                  message: "All threads are settled. Archive this space when ready.",
                }),
          }
        : row.disposition === "refused"
          ? {
              kind: "refused" as const,
              at: row.updatedAt,
              ...(row.refusalCode ? { code: row.refusalCode } : {}),
              ...(row.refusalMessage ? { message: row.refusalMessage } : {}),
            }
          : row.deleteIntentSequence !== null ||
              ["pending_destroy", "destroying", "archiving", "restoring"].includes(row.disposition)
            ? { kind: "pending_cleanup" as const, at: row.updatedAt }
            : null,
  });
}

export interface StaveProjectShellsShape {
  /** Attach `stave` / `notice` to shells; other fields pass through unchanged. */
  readonly decorate: (
    shells: ReadonlyArray<OrchestrationProjectShell>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>>;
  /** Active project shells in creation order, decorated. */
  readonly list: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, StaveProjectShellsError>;
  readonly getById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, StaveProjectShellsError>;
  /** Exact workspace-root match, like V1 `getActiveProjectByWorkspaceRoot`. */
  readonly getActiveByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, StaveProjectShellsError>;
}

export class StaveProjectShells extends Context.Service<
  StaveProjectShells,
  StaveProjectShellsShape
>()("lecturn/stave/StaveProjectShells") {}

const DECORATION_CONCURRENCY = 4;

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const reader = yield* StaveWorkspaceReader;
  const lifecycle = yield* StaveLifecycleRepository;
  const displayMembership = yield* Effect.serviceOption(StaveDisplayMembership);

  const staveForRoot = Effect.fn("StaveProjectShells.staveForRoot")(function* (
    workspaceRoot: string,
  ) {
    const info = Option.getOrNull(yield* reader.load(workspaceRoot));
    if (info === null || Option.isNone(displayMembership)) return info;
    return yield* displayMembership.value.enrich(workspaceRoot, info);
  });

  const decorate: StaveProjectShellsShape["decorate"] = (shells) =>
    Effect.gen(function* () {
      const roots = [...new Set(shells.map((shell) => shell.workspaceRoot))];
      const staveByRoot = new Map(
        yield* Effect.forEach(
          roots,
          (root) =>
            staveForRoot(root).pipe(
              Effect.orElseSucceed(() => null),
              Effect.map((stave) => [root, stave] as const),
            ),
          { concurrency: DECORATION_CONCURRENCY },
        ),
      );
      return yield* Effect.forEach(shells, (shell) =>
        lifecycle.getByProjectId(shell.id).pipe(
          Effect.orElseSucceed(() => Option.none<StaveLifecycleRow>()),
          Effect.map((row): OrchestrationProjectShell => ({
            ...shell,
            stave: staveByRoot.get(shell.workspaceRoot) ?? null,
            notice: lifecycleNotice(row),
          })),
        ),
      );
    });

  const fail = (operation: string) => (cause: unknown) =>
    new StaveProjectShellsError({ operation, cause });

  const list = projects.listShells().pipe(Effect.mapError(fail("list")), Effect.flatMap(decorate));

  const decorateOne = (shell: Option.Option<OrchestrationProjectShell>) =>
    Option.isNone(shell)
      ? Effect.succeed(shell)
      : decorate([shell.value]).pipe(
          Effect.map((decorated) => Option.fromUndefinedOr(decorated[0])),
        );

  return StaveProjectShells.of({
    decorate,
    list,
    getById: (projectId) =>
      projects
        .getShell(projectId)
        .pipe(Effect.mapError(fail("getById")), Effect.flatMap(decorateOne)),
    getActiveByWorkspaceRoot: (workspaceRoot) =>
      projects.findActiveByWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(fail("getActiveByWorkspaceRoot")),
        Effect.flatMap((row) =>
          Option.isNone(row)
            ? Effect.succeed(Option.none<OrchestrationProjectShell>())
            : projects
                .getShell(row.value.projectId)
                .pipe(
                  Effect.mapError(fail("getActiveByWorkspaceRoot")),
                  Effect.flatMap(decorateOne),
                ),
        ),
      ),
  });
});

export const layer = Layer.effect(StaveProjectShells, make);
