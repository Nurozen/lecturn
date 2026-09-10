/**
 * StaveAdmission - Effect service that fences mutations which would break a
 * Stave space's invariants, consulted before a command or RPC is dispatched.
 *
 * A Stave project is a project whose workspace root carries a `.stave.yaml`
 * manifest (as reported by `StaveWorkspaceReader`). Threads in a space always
 * run in the space root, so the worktree rule refuses every intent that would
 * create or bind a per-thread worktree there: `thread.create` /
 * `thread.meta.update` with a non-null `worktreePath`, a bootstrap turn start
 * that prepares a worktree, a fork that would inherit a worktree, and the
 * worktree-producing git RPCs. Thread creation and turn start also check
 * current incarnation and lifecycle leases, even for local threads.
 *
 * @module StaveAdmission
 */
import type { ProjectId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { StaveLifecycleRepository } from "../persistence/Services/StaveLifecycleRepository.ts";
import { StaveSpaceLock } from "./StaveSpaceLock.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

// ---------------------------------------------------------------------------
// Errors
//
// One class per refusal so callers (and clients matching on `_tag`) can tell
// them apart. Worktree, archived and transitioning refusals share a closed
// error channel.
// ---------------------------------------------------------------------------

export const StaveAdmissionIntent = Schema.Literals([
  "thread.create",
  "thread.meta.update",
  "thread.turn.start",
  "thread.fork",
  "thread.unsettle",
  "thread.pin",
  "thread.unarchive",
  "vcs.createWorktree",
  "pr.prepare",
]);
export type StaveAdmissionIntent = typeof StaveAdmissionIntent.Type;

export const STAVE_WORKTREE_FORBIDDEN_MESSAGE =
  "Stave spaces run threads in the space root; worktrees are not used";

export class StaveWorktreeForbiddenError extends Schema.TaggedErrorClass<StaveWorktreeForbiddenError>()(
  "StaveWorktreeForbiddenError",
  {
    projectRoot: Schema.String,
    intent: StaveAdmissionIntent,
    message: Schema.String,
  },
) {}

export class StaveArchivedProjectError extends Schema.TaggedErrorClass<StaveArchivedProjectError>()(
  "StaveArchivedProjectError",
  { projectRoot: Schema.String, intent: StaveAdmissionIntent, message: Schema.String },
) {}
export class StaveSpaceTransitioningError extends Schema.TaggedErrorClass<StaveSpaceTransitioningError>()(
  "StaveSpaceTransitioningError",
  { projectRoot: Schema.String, intent: StaveAdmissionIntent, message: Schema.String },
) {}
export type StaveAdmissionError =
  | StaveWorktreeForbiddenError
  | StaveArchivedProjectError
  | StaveSpaceTransitioningError;

export const isStaveAdmissionError: (cause: unknown) => cause is StaveAdmissionError = Schema.is(
  Schema.Union([
    StaveWorktreeForbiddenError,
    StaveArchivedProjectError,
    StaveSpaceTransitioningError,
  ]),
);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface StaveAdmissionInput {
  /** Workspace root of the project the mutation targets (exact root, not a cwd inside it). */
  readonly projectRoot: string;
  readonly projectId?: ProjectId;
  readonly intent: StaveAdmissionIntent;
  /** Worktree the command would bind the thread to; `null`/absent means the project root. */
  readonly worktreePath?: string | null;
  /** Whether the command carries a `bootstrap.prepareWorktree` step. */
  readonly prepareWorktree?: boolean;
  /** Internal commit recheck already holds the shared space mutex. */
  readonly lockHeld?: boolean;
}

export class StaveAdmission extends Context.Service<
  StaveAdmission,
  {
    /**
     * Succeeds when the intent is admissible for the project; fails with the
     * typed refusal otherwise. Never fails for a non-Stave root.
     */
    readonly check: (input: StaveAdmissionInput) => Effect.Effect<void, StaveAdmissionError>;
  }
>()("t3/stave/StaveAdmission") {}

/** Intents that exist only to create a worktree, regardless of the payload. */
const WORKTREE_PRODUCING_INTENTS: ReadonlySet<StaveAdmissionIntent> = new Set([
  "vcs.createWorktree",
  "pr.prepare",
]);

/**
 * Pure worktree rule: does the intent create or use a per-thread worktree?
 * The manifest is only read when this is true.
 */
export const intentUsesWorktree = (input: StaveAdmissionInput): boolean =>
  WORKTREE_PRODUCING_INTENTS.has(input.intent) ||
  input.prepareWorktree === true ||
  (input.worktreePath !== undefined && input.worktreePath !== null);

export const make = Effect.fn("StaveAdmission.make")(function* () {
  const reader = yield* StaveWorkspaceReader;

  const lifecycle = yield* Effect.serviceOption(StaveLifecycleRepository);
  const lock = yield* Effect.serviceOption(StaveSpaceLock);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const checkUnderLock = Effect.fn("StaveAdmission.checkUnderLock")(function* (
    input: StaveAdmissionInput,
  ) {
    const transition = () =>
      new StaveSpaceTransitioningError({
        projectRoot: input.projectRoot,
        intent: input.intent,
        message: "This Stave space is transitioning. Try again after the operation finishes.",
      });
    const space = yield* reader.load(input.projectRoot);
    if (Option.isSome(lifecycle)) {
      const canonicalRoot = Option.isSome(fs)
        ? yield* fs.value
            .realPath(input.projectRoot)
            .pipe(Effect.orElseSucceed(() => input.projectRoot))
        : input.projectRoot;
      const rootRow = yield* lifecycle.value
        .getByWorkspaceRoot(canonicalRoot)
        .pipe(Effect.mapError(transition));
      // A lease belongs to the physical root, even if another project id was
      // re-added while the previous owner was running.
      const now = yield* Clock.currentTimeMillis;
      if (
        Option.isSome(rootRow) &&
        rootRow.value.ownerToken !== null &&
        rootRow.value.leaseUntil !== null &&
        Date.parse(rootRow.value.leaseUntil) > now
      )
        return yield* transition();
      if (
        Option.isSome(rootRow) &&
        ["archiving", "restoring", "destroying", "destroyed"].includes(rootRow.value.disposition) &&
        (Option.isNone(space) ||
          (rootRow.value.spaceId === space.value.spaceId &&
            (rootRow.value.manifestCreatedAt === null ||
              space.value.createdAt === undefined ||
              rootRow.value.manifestCreatedAt === space.value.createdAt)))
      )
        return yield* transition();
      const row =
        input.projectId === undefined
          ? rootRow
          : yield* lifecycle.value
              .getByProjectId(input.projectId)
              .pipe(Effect.mapError(transition));
      if (Option.isSome(row)) {
        const sameIncarnation =
          Option.isNone(space) ||
          (row.value.spaceId === space.value.spaceId &&
            (row.value.manifestCreatedAt === null ||
              space.value.createdAt === undefined ||
              row.value.manifestCreatedAt === space.value.createdAt));
        if (
          sameIncarnation &&
          ["archiving", "restoring", "destroying", "destroyed"].includes(row.value.disposition)
        )
          return yield* transition();
        if (Option.isNone(space) && row.value.disposition === "archived")
          return yield* new StaveArchivedProjectError({
            projectRoot: input.projectRoot,
            intent: input.intent,
            message: "Unarchive this Stave space before starting a thread.",
          });
        // The manifest's location determines archived state. A completed
        // external restore may legitimately leave an old archived row.
      }
    }
    if (Option.isNone(space)) return;
    if (space.value.state === "archived")
      return yield* new StaveArchivedProjectError({
        projectRoot: input.projectRoot,
        intent: input.intent,
        message: "Unarchive this Stave space before starting a thread.",
      });
    if (intentUsesWorktree(input))
      return yield* new StaveWorktreeForbiddenError({
        projectRoot: input.projectRoot,
        intent: input.intent,
        message: STAVE_WORKTREE_FORBIDDEN_MESSAGE,
      });
  });
  const check = (input: StaveAdmissionInput) =>
    input.lockHeld || Option.isNone(lock)
      ? checkUnderLock(input)
      : lock.value.withSpaceLock(input.projectRoot, checkUnderLock(input));

  return StaveAdmission.of({ check });
});

export const layer = Layer.effect(StaveAdmission, make());

/** Admission that admits everything — for tests whose projects are never spaces. */
export const layerNoop = Layer.succeed(
  StaveAdmission,
  StaveAdmission.of({
    check: () => Effect.void,
  }),
);
