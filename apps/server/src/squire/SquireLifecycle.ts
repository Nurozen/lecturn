/**
 * The Squire lifecycle state machine: `creating` and `rehoming` build a
 * home thread in the scratch workspace, `deleting` takes it all down.
 * Orchestration commits apart from Squire SQL and the filesystem, so every
 * step is idempotent and resumable: the home thread id and its command ids
 * derive from (squireId, home_generation), a replayed command returns its
 * receipt, and startup reconciliation re-runs whatever a crash interrupted.
 */
import {
  CommandId,
  ModelSelection,
  type OrchestrationV2ServerCommand,
  ProjectId,
  SquireError,
  type SquireId,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireWorkspace from "./SquireWorkspace.ts";
import { isSquireThread } from "./squireThread.ts";

export const homeThreadIdFor = (squireId: SquireId, generation: number) =>
  ThreadId.make(`thread:squire:${squireId}:home:${generation}`);

const homeCommandId = (squireId: SquireId, generation: number, step: string) =>
  CommandId.make(`server:squire:home:${squireId}:${generation}:${step}`);

/** Explicit, so the orchestrator never generates a title for a home thread. */
const homeThreadTitle = (name: string) => `Squire · ${name}`;

const isSquireError = Schema.is(SquireError);

/**
 * Passes SquireErrors through; anything else (SQL, orchestration, filesystem)
 * is logged with its cause and reported as `not_available`, since the
 * contract error carries no cause.
 */
export const orSquireError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SquireError, R> =>
    effect.pipe(
      Effect.catch((cause) =>
        isSquireError(cause)
          ? Effect.fail(cause)
          : Effect.logWarning("Squire operation failed", { operation, cause }).pipe(
              Effect.andThen(
                Effect.fail(
                  new SquireError({
                    code: "not_available",
                    message: `Could not ${operation}. Try again.`,
                  }),
                ),
              ),
            ),
      ),
    );

const decodeModel = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const sameModel = Schema.toEquivalence(ModelSelection);

export type HomeStep =
  | "archive-previous"
  | "project"
  | "workspace"
  | "thread"
  | "auto-settle"
  | "ready";
export type DeleteStep = "archive" | "workspace" | "rows";
export const HOME_STEPS: ReadonlyArray<HomeStep> = [
  "archive-previous",
  "project",
  "workspace",
  "thread",
  "auto-settle",
  "ready",
];
export const DELETE_STEPS: ReadonlyArray<DeleteStep> = ["archive", "workspace", "rows"];

// A drive re-reads the row after every step, and a concurrent update (a
// rename, a project change) only costs another pass, so this bounds a loop
// that a bug could otherwise spin forever.
const MAX_DRIVE_PASSES = 8;

export class SquireLifecycle extends Context.Service<
  SquireLifecycle,
  {
    /** Startup: resumes `creating`, `rehoming`, and `deleting`; re-syncs `ready` home threads. */
    readonly reconcileAll: Effect.Effect<void>;
    /** Runs the row to `ready`, `needs_provider`, or gone. None once deleted. */
    readonly drive: (
      squireId: SquireId,
    ) => Effect.Effect<Option.Option<SquireRepository.SquireRow>, SquireError>;
    /**
     * A new home thread in the most recently active project, at the next
     * generation; the old home is archived. Called when the home project or
     * home thread is deleted. A Lead still waiting for a provider only moves.
     */
    readonly rehome: (squireId: SquireId) => Effect.Effect<void, SquireError>;
    /**
     * One step of `creating`/`rehoming`; false when it cannot proceed yet (no
     * project left to home in). Exposed so tests can stop between steps.
     */
    readonly homeStep: (squireId: SquireId, step: HomeStep) => Effect.Effect<boolean, SquireError>;
    /** One step of `deleting`. */
    readonly deleteStep: (squireId: SquireId, step: DeleteStep) => Effect.Effect<void, SquireError>;
    /**
     * Brings a home thread's title and model to `target`. `key` makes the
     * command ids: a retried request replays instead of switching twice.
     */
    readonly syncHome: (target: {
      readonly squireId: SquireId;
      readonly threadId: ThreadId;
      readonly name: string;
      readonly modelSelection: ModelSelection;
      readonly key: string;
    }) => Effect.Effect<void, SquireError>;
    /** The most recently active non-app project, skipping `exclude`. */
    readonly homeProjectCandidate: (
      exclude?: ProjectId,
    ) => Effect.Effect<Option.Option<ProjectStore.ProjectRow>, SquireError>;
  }
>()("lecturn/squire/SquireLifecycle") {}

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const workspaces = yield* SquireWorkspace.SquireWorkspace;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // Lifecycle work is rare; one lock keeps a startup drive and an RPC drive
  // of the same Squire from interleaving their steps.
  const driving = yield* Semaphore.make(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // The command allowlist on marked threads passes only these.
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    withSquireDispatchOrigin(orchestrator.dispatch(command)).pipe(Effect.asVoid);

  const readRow = (squireId: SquireId) => repository.getSquire(squireId);

  const homeProjectCandidate: SquireLifecycle["Service"]["homeProjectCandidate"] = (exclude) =>
    Effect.gen(function* () {
      const candidates = (yield* projects.list()).filter(
        (project) => project.appBinding === undefined && project.projectId !== exclude,
      );
      if (candidates.length === 0) return Option.none();
      const snapshot = yield* projections.getShellSnapshot();
      const lastActive = new Map<ProjectId, number>();
      for (const thread of snapshot.threads) {
        if (isSquireThread(thread)) continue;
        const at = DateTime.toEpochMillis(thread.updatedAt);
        if (at > (lastActive.get(thread.projectId) ?? 0)) lastActive.set(thread.projectId, at);
      }
      const activity = (project: ProjectStore.ProjectRow) =>
        Math.max(lastActive.get(project.projectId) ?? 0, Date.parse(project.updatedAt));
      return Option.some(
        candidates.reduce((best, project) => (activity(project) > activity(best) ? project : best)),
      );
    }).pipe(orSquireError("find a project for the Squire"));

  const archiveIfLive = (squireId: SquireId, generation: number) =>
    Effect.gen(function* () {
      if (generation < 1) return;
      const threadId = homeThreadIdFor(squireId, generation);
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null || shell.archivedAt !== null) return;
      yield* dispatch({
        type: "thread.archive",
        commandId: homeCommandId(squireId, generation, "archive"),
        threadId,
      });
    });

  const syncHome: SquireLifecycle["Service"]["syncHome"] = (target) =>
    Effect.gen(function* () {
      const shell = yield* projections.getThreadShell(target.threadId);
      // A deleted home thread is the reactor's to re-home.
      if (shell === null) return;
      const title = homeThreadTitle(target.name);
      if (shell.title !== title) {
        yield* dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`server:squire:title:${target.squireId}:${target.key}`),
          threadId: target.threadId,
          title,
        });
      }
      if (!sameModel(shell.modelSelection, target.modelSelection)) {
        yield* dispatch({
          type: "provider.switch",
          commandId: CommandId.make(`server:squire:provider:${target.squireId}:${target.key}`),
          threadId: target.threadId,
          modelSelection: target.modelSelection,
        });
      }
    }).pipe(orSquireError("update the Squire's thread"));

  const updateRow = (
    row: SquireRepository.SquireRow,
    patch: Parameters<SquireRepository.SquireRepository["Service"]["updateSquire"]>[0]["patch"],
  ) =>
    Effect.gen(function* () {
      return yield* repository.updateSquire({
        id: row.id,
        expectedRevision: row.revision,
        patch,
        updatedAt: yield* nowIso,
      });
    });

  const homeStep: SquireLifecycle["Service"]["homeStep"] = (squireId, step) =>
    Effect.gen(function* () {
      const current = yield* readRow(squireId);
      if (Option.isNone(current)) return false;
      const row = current.value;
      if (row.lifecycle !== "creating" && row.lifecycle !== "rehoming") return false;
      const generation = row.home_generation;
      const threadId = homeThreadIdFor(squireId, generation);
      switch (step) {
        case "archive-previous":
          // Every earlier generation was archived before its successor began,
          // except the one a re-home is replacing.
          if (row.lifecycle === "rehoming") yield* archiveIfLive(squireId, generation - 1);
          return true;
        case "project": {
          if (Option.isSome(yield* projects.get(row.home_project_id))) return true;
          const next = yield* homeProjectCandidate(row.home_project_id);
          if (Option.isNone(next)) {
            yield* Effect.logInfo("Squire has no project to home in yet", { squireId });
            return false;
          }
          // A lost CAS means the row moved on; the next pass re-reads it.
          yield* updateRow(row, { home_project_id: next.value.projectId });
          return true;
        }
        case "workspace":
          yield* workspaces.ensure(squireId);
          return true;
        case "thread": {
          if (row.model_selection_json === null) return false;
          const modelSelection = yield* decodeModel(row.model_selection_json);
          yield* dispatch({
            type: "thread.create",
            commandId: homeCommandId(squireId, generation, "create"),
            threadId,
            projectId: row.home_project_id,
            title: homeThreadTitle(row.name),
            modelSelection,
            // RuntimePolicy forces the deny runtime on marked threads anyway.
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: yield* workspaces.pathFor(squireId),
            createdBy: "system",
            creationSource: "server",
            squire: { squireId, role: "home" },
          });
          return true;
        }
        case "auto-settle":
          yield* dispatch({
            type: "thread.auto-settle.set",
            commandId: homeCommandId(squireId, generation, "auto-settle"),
            threadId,
            enabled: false,
          });
          return true;
        case "ready": {
          const ready = yield* updateRow(row, { lifecycle: "ready", home_thread_id: threadId });
          if (Option.isNone(ready) || ready.value.model_selection_json === null) return true;
          // A rename or model change that landed while the thread was being
          // created (the create replays its first title and model).
          yield* syncHome({
            squireId,
            threadId,
            name: ready.value.name,
            modelSelection: yield* decodeModel(ready.value.model_selection_json),
            key: `sync:${ready.value.revision}`,
          });
          return true;
        }
      }
    }).pipe(orSquireError("set up the Squire's home thread"));

  const deleteStep: SquireLifecycle["Service"]["deleteStep"] = (squireId, step) =>
    Effect.gen(function* () {
      const current = yield* readRow(squireId);
      if (Option.isNone(current) || current.value.lifecycle !== "deleting") return;
      const row = current.value;
      switch (step) {
        case "archive":
          // A delete that interrupted a re-home also owns the generation before it.
          yield* archiveIfLive(squireId, row.home_generation);
          yield* archiveIfLive(squireId, row.home_generation - 1);
          return;
        case "workspace":
          yield* workspaces.remove(squireId);
          return;
        case "rows": {
          const { triggerSecretRefs } = yield* repository.deleteSquireRows(squireId);
          yield* Effect.forEach(
            triggerSecretRefs,
            (ref) =>
              secrets
                .remove(ref)
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Could not delete a Squire trigger secret", { cause }),
                  ),
                ),
            { discard: true },
          );
          return;
        }
      }
    }).pipe(orSquireError("delete the Squire"));

  const driveUnlocked = (squireId: SquireId) =>
    Effect.gen(function* () {
      for (let pass = 0; pass < MAX_DRIVE_PASSES; pass++) {
        const current = yield* readRow(squireId).pipe(orSquireError("read the Squire"));
        if (Option.isNone(current)) return Option.none<SquireRepository.SquireRow>();
        const row = current.value;
        switch (row.lifecycle) {
          case "ready":
          case "needs_provider":
            return current;
          case "deleting":
            for (const step of DELETE_STEPS) yield* deleteStep(squireId, step);
            break;
          case "creating":
          case "rehoming":
            for (const step of HOME_STEPS) {
              if (!(yield* homeStep(squireId, step))) {
                const after = yield* readRow(squireId).pipe(orSquireError("read the Squire"));
                // Stuck without a project: the row waits for the next start.
                if (Option.isSome(after) && after.value.revision === row.revision) return after;
                break;
              }
            }
            break;
        }
      }
      return yield* readRow(squireId).pipe(orSquireError("read the Squire"));
    });

  const drive: SquireLifecycle["Service"]["drive"] = (squireId) =>
    driving.withPermits(1)(driveUnlocked(squireId));

  const rehome: SquireLifecycle["Service"]["rehome"] = (squireId) =>
    driving.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readRow(squireId).pipe(orSquireError("read the Squire"));
        if (Option.isNone(current)) return;
        const row = current.value;
        if (row.lifecycle === "deleting") {
          yield* driveUnlocked(squireId);
          return;
        }
        const project = yield* projects.get(row.home_project_id).pipe(orSquireError("re-home"));
        // The home project may survive a lost home thread; re-homing still picks
        // the most recently active one, which may be the same.
        const next = yield* homeProjectCandidate(
          Option.isNone(project) ? row.home_project_id : undefined,
        );
        const homeProjectId = Option.match(next, {
          onNone: () => row.home_project_id,
          onSome: (candidate) => candidate.projectId,
        });
        if (row.lifecycle === "needs_provider") {
          yield* updateRow(row, { home_project_id: homeProjectId }).pipe(orSquireError("re-home"));
          return;
        }
        // Already re-homing: the current generation has no thread to lose yet.
        if (row.lifecycle !== "rehoming") {
          const generation = row.home_generation + 1;
          // A batch still in flight replays the old thread's receipt and
          // never reaches the new home, so its rows are delivered again there.
          const moved = yield* repository
            .transaction(
              Effect.gen(function* () {
                const advanced = yield* updateRow(row, {
                  lifecycle: "rehoming",
                  home_generation: generation,
                  home_thread_id: homeThreadIdFor(squireId, generation),
                  home_project_id: homeProjectId,
                });
                if (Option.isSome(advanced)) yield* repository.resetBatchedEvents(squireId);
                return advanced;
              }),
            )
            .pipe(orSquireError("re-home"));
          if (Option.isNone(moved)) {
            return yield* new SquireError({
              code: "revision_conflict",
              message: "The Squire changed while it was being moved. Try again.",
            });
          }
        }
        yield* driveUnlocked(squireId);
      }),
    );

  const reconcileAll: SquireLifecycle["Service"]["reconcileAll"] = Effect.gen(function* () {
    const rows = yield* repository.listSquires.pipe(orSquireError("list Squires"));
    for (const row of rows) {
      const work =
        row.lifecycle === "ready"
          ? Effect.gen(function* () {
              if (row.home_thread_id === null || row.model_selection_json === null) return;
              // An update that switched the thread and crashed before its row
              // committed: the row is the record, so the thread follows it.
              yield* syncHome({
                squireId: row.id,
                threadId: row.home_thread_id,
                name: row.name,
                modelSelection: yield* decodeModel(row.model_selection_json).pipe(
                  orSquireError("read the Squire"),
                ),
                key: `sync:${row.revision}`,
              });
            })
          : drive(row.id).pipe(Effect.asVoid);
      yield* work.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Squire reconciliation failed", {
            squireId: row.id,
            lifecycle: row.lifecycle,
            code: error.code,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Squire reconciliation could not start", { code: error.code }),
    ),
  );

  return SquireLifecycle.of({
    reconcileAll,
    drive,
    rehome,
    homeStep,
    deleteStep,
    syncHome,
    homeProjectCandidate,
  });
});

export const layer = Layer.effect(SquireLifecycle, make);
