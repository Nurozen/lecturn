/**
 * Project create/move workspace-locks every affected root so a Stave operation never races a
 * project claiming its tree. Thread intents in a space hold the space lock shared: they exclude
 * Stave operations, never each other. Commands from a Stave operation already holding the locks
 * carry `StaveReconciliation` and pass straight through.
 */
import type { OrchestrationV2ServerCommand, ProjectId, ThreadId } from "@lecturn/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  LecturnHookRejectedError,
  type LecturnCommandAdmissionInput,
  LecturnOrchestrationHooks,
  type LecturnOrchestrationHooksContribution,
} from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import type { ProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { StaveAdmission, type StaveAdmissionInput } from "./StaveAdmission.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";
import { StaveReconciliation } from "./StaveOrchestration.ts";
import { StaveRuntimeFence, StaveRuntimeFenced } from "./StaveRuntimeFence.ts";
import { isPathUnder, StaveSpaceLock } from "./StaveSpaceLock.ts";
import { STAVE_MANIFEST_FILE_NAME } from "./staveManifest.ts";

const CONTRIBUTION = "stave";

/**
 * Short Stave operations finish well inside this; creating, archiving or restoring a space can take
 * minutes, and a send should be told to retry rather than hang. Also bounds how long an automatic
 * sender (and its effect worker slot) can wait.
 */
export const STAVE_ADMISSION_WAIT = Duration.seconds(5);

const SPACE_BUSY_REASON = "A Stave operation is changing this space. Retry when it finishes.";

/** What a thread command asks of a space, and where to find its project. */
export interface StaveThreadIntent {
  readonly intent: StaveAdmissionInput["intent"];
  readonly projectId?: ProjectId;
  /** Thread whose project (and, unless overridden, worktree) owns the command. */
  readonly threadId?: ThreadId;
  /** Worktree the command binds; `undefined` = the thread's current worktree. */
  readonly worktreePath?: string | null;
  readonly prepareWorktree?: boolean;
}

/** Thread commands that need Stave admission (V1 commit admission + intake rule). */
export function describeStaveThreadIntent(
  command: OrchestrationV2ServerCommand,
): StaveThreadIntent | null {
  switch (command.type) {
    case "thread.create":
      return {
        intent: "thread.create",
        projectId: command.projectId,
        // Lecturn: a Squire home runs in its scratch workspace under userdata,
        // not a worktree of the space, so the worktree rule does not apply.
        worktreePath: command.squire?.role === "home" ? null : command.worktreePath,
      };
    case "thread.import":
      // An import creates a thread, so it answers to the creation rule.
      return {
        intent: "thread.create",
        projectId: command.projectId,
        worktreePath: command.worktreePath,
      };
    case "thread.metadata.update":
      return command.worktreePath === undefined || command.worktreePath === null
        ? null
        : {
            intent: "thread.meta.update",
            threadId: command.threadId,
            worktreePath: command.worktreePath,
          };
    case "message.dispatch":
      return { intent: "thread.turn.start", threadId: command.threadId };
    case "thread.fork":
      return command.workspace === "new-worktree"
        ? { intent: "thread.fork", threadId: command.sourceThreadId, prepareWorktree: true }
        : { intent: "thread.fork", threadId: command.sourceThreadId };
    case "delegated_task.request":
      // A delegated task creates a child thread in the parent's project and
      // workspace, so it answers to the creation rule for that workspace. A
      // worktree-isolated child is provisioned after this commits, so admit
      // the new worktree here, under the space lock, before any checkout exists.
      return command.workspaceStrategy?.type === "worktree"
        ? { intent: "thread.create", threadId: command.parentThreadId, prepareWorktree: true }
        : { intent: "thread.create", threadId: command.parentThreadId };
    case "thread.merge_back":
      // Merge-back moves a fork's context into its parent, which runs the
      // next turn: the fork rule applies to the receiving thread.
      return { intent: "thread.fork", threadId: command.targetThreadId };
    case "thread.unsettle":
      return { intent: "thread.unsettle", threadId: command.threadId };
    case "thread.pin":
      return { intent: "thread.pin", threadId: command.threadId };
    case "thread.unarchive":
      return { intent: "thread.unarchive", threadId: command.threadId };
    default:
      return null;
  }
}

const reject = (reason: string, cause?: unknown, hook = "aroundCommand") =>
  new LecturnHookRejectedError({
    hook,
    contribution: CONTRIBUTION,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Lecturn: a thread command still refused after `STAVE_ADMISSION_WAIT`, because
 * a long Stave operation holds the space. That refusal alone is transient: the
 * same command passes once the operation lets go.
 */
export const isStaveSpaceBusy = (error: LecturnHookRejectedError) =>
  error.contribution === CONTRIBUTION && error.reason === SPACE_BUSY_REASON;

/** Lecturn: the refusal `isStaveSpaceBusy` recognizes, for a stand-in admission hook. */
export const staveSpaceBusyRejection = () =>
  reject(SPACE_BUSY_REASON, undefined, "aroundThreadLock");

const isRuntimeFenced = Schema.is(StaveRuntimeFenced);

const make = Effect.gen(function* () {
  const admission = yield* StaveAdmission;
  const locks = yield* StaveSpaceLock;
  const fence = yield* StaveRuntimeFence;
  const reader = yield* StaveWorkspaceReader;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** Every `.stave.yaml` root at or above `start`. */
  const manifestAncestors = Effect.fn("StaveOrchestrationHooks.manifestAncestors")(function* (
    start: string,
  ) {
    const roots: string[] = [];
    let candidate = path.resolve(start);
    while (true) {
      if (
        yield* fs
          .exists(path.join(candidate, STAVE_MANIFEST_FILE_NAME))
          .pipe(Effect.orElseSucceed(() => false))
      )
        roots.push(candidate);
      const parent = path.dirname(candidate);
      if (parent === candidate) return roots;
      candidate = parent;
    }
  });

  const aroundProjectCommand = <A, E, R>(
    command: ProjectCommand,
    commit: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | LecturnHookRejectedError, R> => {
    if (command.type !== "project.create" && command.type !== "project.meta.update") return commit;
    if (command.workspaceRoot === undefined) return commit;
    const destination = command.workspaceRoot;
    return Effect.gen(function* () {
      const existing = Option.getOrUndefined(
        yield* projects
          .get(command.projectId)
          .pipe(
            Effect.mapError((cause) =>
              reject("Could not verify the Stave workspace before this change.", cause),
            ),
          ),
      );
      if (command.type === "project.meta.update" && existing?.workspaceRoot === destination)
        return yield* commit;
      const roots = [destination, ...(existing ? [existing.workspaceRoot] : [])];
      const active = yield* projects
        .list()
        .pipe(
          Effect.mapError((cause) =>
            reject("Could not verify the Stave workspace before this change.", cause),
          ),
        );
      for (const project of active) {
        if (yield* isPathUnder(project.workspaceRoot, destination))
          roots.push(project.workspaceRoot);
      }
      roots.push(...(yield* manifestAncestors(destination)));
      const result = yield* locks.tryWithWorkspaceLocks(roots, commit);
      if (Option.isNone(result))
        return yield* reject(
          "A Stave operation is changing this workspace or its ancestor. Retry when it finishes.",
        );
      return result.value;
    });
  };

  const resolveIntent = Effect.fn("StaveOrchestrationHooks.resolveIntent")(function* (
    intent: StaveThreadIntent,
  ) {
    const thread =
      intent.threadId === undefined ? null : yield* threads.getThreadShell(intent.threadId);
    const projectId = intent.projectId ?? thread?.projectId;
    if (projectId === undefined) return null;
    const project = yield* projects.get(projectId);
    if (Option.isNone(project)) return null;
    const input: StaveAdmissionInput = {
      projectRoot: project.value.workspaceRoot,
      projectId,
      intent: intent.intent,
      worktreePath:
        intent.worktreePath !== undefined
          ? intent.worktreePath
          : // Lecturn: see `describeStaveThreadIntent`; a Squire home is not a space worktree.
            thread?.squire?.role === "home"
            ? null
            : (thread?.worktreePath ?? null),
      ...(intent.prepareWorktree === undefined ? {} : { prepareWorktree: intent.prepareWorktree }),
      lockHeld: true,
    };
    return input;
  });

  /**
   * Waits for the space before the thread lock: waiting under it would deadlock with an operation
   * that holds the space and dispatches a reconciliation command to the same thread. The project
   * read here is only a hint; `aroundThreadCommand` resolves again under the thread lock.
   */
  const aroundThreadLock = <A, E, R>(
    command: OrchestrationV2ServerCommand,
    dispatch: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | LecturnHookRejectedError, R> => {
    const intent = describeStaveThreadIntent(command);
    if (intent === null) return dispatch;
    return Effect.gen(function* () {
      if (yield* StaveReconciliation) return yield* dispatch;
      const input = yield* resolveIntent(intent).pipe(Effect.orElseSucceed(() => null));
      if (input === null) return yield* dispatch;
      const result = yield* locks.withSharedSpaceLock(
        input.projectRoot,
        dispatch,
        STAVE_ADMISSION_WAIT,
      );
      if (Option.isNone(result))
        return yield* reject(SPACE_BUSY_REASON, undefined, "aroundThreadLock");
      return result.value;
    });
  };

  const aroundThreadCommand = <A, E, R>(
    command: OrchestrationV2ServerCommand,
    commit: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | LecturnHookRejectedError, R> => {
    const intent = describeStaveThreadIntent(command);
    if (intent === null) return commit;
    return Effect.gen(function* () {
      // An unknown thread or project is left to the orchestrator's own rejection.
      const input = yield* resolveIntent(intent).pipe(
        Effect.mapError((cause) =>
          reject("Could not resolve the command's project for Stave admission.", cause),
        ),
      );
      if (input === null) return yield* commit;
      const checked = admission.check(input).pipe(
        Effect.mapError((error) => reject(error.message, error)),
        Effect.andThen(commit),
      );
      // Usually already held by aroundThreadLock. Otherwise (the project moved
      // in between, or a caller without that hook) it must not wait here,
      // under the thread lock.
      const result = yield* locks.withSharedSpaceLock(input.projectRoot, checked, Duration.zero);
      if (Option.isNone(result)) return yield* reject(SPACE_BUSY_REASON);
      return result.value;
    });
  };

  // Wraps every dispatched command; the dispatch owns the span.
  const aroundCommand = Effect.fnUntraced(function* <A, E, R>(
    input: LecturnCommandAdmissionInput,
    commit: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | LecturnHookRejectedError, R> {
    if (yield* StaveReconciliation) return yield* commit;
    return yield* input.scope === "project"
      ? aroundProjectCommand(input.command, commit)
      : aroundThreadCommand(input.command, commit);
  });

  const contribution: LecturnOrchestrationHooksContribution = {
    name: CONTRIBUTION,
    aroundCommand,
    aroundThreadLock,
    aroundProviderSessionOpen: (input, open) =>
      input.cwd === null
        ? open
        : fence.withStart(input.cwd, open).pipe(
            Effect.mapError((error) =>
              isRuntimeFenced(error)
                ? new LecturnHookRejectedError({
                    hook: "aroundProviderSessionOpen",
                    contribution: CONTRIBUTION,
                    reason: error.message,
                    cause: error,
                  })
                : (error as Exclude<typeof error, StaveRuntimeFenced>),
            ),
          ),
    // A "worktree" launch provisions before thread.create commits, so the
    // command hook only sees the later binding; admit the worktree up front.
    beforeWorktreeProvision: (input) =>
      admission
        .check({
          projectRoot: input.workspaceRoot,
          projectId: input.projectId,
          intent: "thread.create",
          worktreePath: null,
          prepareWorktree: true,
        })
        .pipe(Effect.mapError((error) => reject(error.message, error, "beforeWorktreeProvision"))),
    // Restoring checkpoint files would rewrite a space's member checkouts.
    beforeCheckpointRestore: (input) =>
      reader
        .load(input.workspaceRoot)
        .pipe(
          Effect.flatMap((space) =>
            Option.isSome(space)
              ? Effect.fail(
                  reject(
                    "Checkpoints are unavailable for Stave spaces.",
                    undefined,
                    "beforeCheckpointRestore",
                  ),
                )
              : Effect.void,
          ),
        ),
  };
  return contribution;
});

/**
 * Registers the Stave contribution. Provide it together with the orchestrator
 * layer that outputs `LecturnOrchestrationHooks` (same registry instance).
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks;
    yield* hooks.register(yield* make);
  }),
);
