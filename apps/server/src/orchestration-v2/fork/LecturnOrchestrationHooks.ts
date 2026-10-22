/**
 * Lecturn fork extension points for the V2 orchestrator.
 *
 * Upstream V2 files call this service at a few fixed sites; fork features
 * (Stave admission and runtime fence, Contextual turn preparation, team
 * provider policy, provider work admission, decisions, relay) register a
 * contribution instead of editing those files. With no contribution
 * registered every call is a no-op, so upstream behavior is unchanged.
 *
 * Contributions register at layer build time:
 *
 *   Layer.effectDiscard(Effect.gen(function* () {
 *     const hooks = yield* LecturnOrchestrationHooks;
 *     yield* hooks.register({ name: "stave", aroundCommand: ... });
 *   }))
 *
 * Registration is scoped: closing the registering layer removes it.
 * Contributions are read on every call, so a contribution may depend on
 * OrchestratorV2 itself without a construction cycle.
 */
import type {
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadContextualOption,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  ThreadImportOrigin,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { ProjectCommand } from "../ProjectCommands.ts";

/** A contribution refused the command, turn or session start. `reason` is user-facing. */
export class LecturnHookRejectedError extends Schema.TaggedError<LecturnHookRejectedError>()(
  "LecturnHookRejectedError",
  {
    hook: Schema.String,
    contribution: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export type LecturnCommandAdmissionInput =
  | {
      readonly scope: "thread";
      readonly command: OrchestrationV2ServerCommand;
    }
  | {
      readonly scope: "project";
      readonly command: ProjectCommand;
    };

export interface LecturnTurnStartInput {
  readonly thread: OrchestrationV2AppThread;
  readonly run: OrchestrationV2Run;
  /** The run's user message as stored (before any augmentation). */
  readonly message: OrchestrationV2ConversationMessage;
  /** True for a `/compact` run; augmentation is ignored for it. */
  readonly compaction: boolean;
}

export interface LecturnTurnStartDecision {
  /**
   * Provider-only context placed before the user text for this turn. Never
   * persisted as a message. Multiple contributions are joined in order.
   */
  readonly contextPrefix?: string;
}

export interface LecturnProviderSessionOpenInput {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  /** The instance's driver kind (codex, claudeAgent, ...). */
  readonly driverKind: string;
  /** The session working directory: thread worktree or project root. */
  readonly cwd: string | null;
}

/** A launch is about to provision a new per-thread worktree under a project. */
export interface LecturnWorktreeProvisionInput {
  readonly projectId: ProjectId;
  /** The project's workspace root (where the worktree's repository lives). */
  readonly workspaceRoot: string;
  readonly threadId: ThreadId;
}

/** A checkpoint rollback is about to restore files into a thread's checkout. */
export interface LecturnCheckpointRestoreInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The thread's project workspace root. */
  readonly workspaceRoot: string;
  /** The checkpoint scope's working directory (what the restore rewrites). */
  readonly scopeCwd: string;
}

export interface LecturnRunTerminalNotice {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly status: OrchestrationV2Run["status"];
  readonly sequence: number;
  /** True when a startup/runtime reconcile (not the provider) settled the run. */
  readonly reconciled: boolean;
}

export type LecturnThreadLifecycleNotice =
  | {
      readonly kind: "created";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      /** The creating send's contextual (cited context) choice, when it made one. */
      readonly contextual?: OrchestrationV2ThreadContextualOption;
    }
  | {
      readonly kind: "forked";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly sourceThreadId: ThreadId;
      readonly sourceMessageId: MessageId | null;
      /** A fork child never raises a relay alert of its own. */
      readonly relayAlert: false;
    }
  | {
      readonly kind: "imported";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly importedFrom: ThreadImportOrigin;
    }
  | {
      readonly kind: "deleted";
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "archived" | "unarchived";
      readonly threadId: ThreadId;
    };

export interface LecturnOrchestrationHooksContribution {
  /** Short owner name used in logs and rejection errors. */
  readonly name: string;
  /**
   * Wraps a command's plan-and-commit. Runs inside the thread (or project)
   * lock. Reject with LecturnHookRejectedError, or wrap `commit` in fork
   * locks (Stave space/workspace locks).
   */
  readonly aroundCommand?: <A, E, R>(
    input: LecturnCommandAdmissionInput,
    commit: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LecturnHookRejectedError, R>;
  /**
   * Called once per run start attempt, before the provider session opens and
   * before the run is marked running. May suspend (Contextual preparation).
   * A rejection fails the run with the reason as its error item.
   */
  readonly beforeTurnStart?: (
    input: LecturnTurnStartInput,
  ) => Effect.Effect<LecturnTurnStartDecision | void, LecturnHookRejectedError>;
  /** Wraps a provider session open (Stave runtime fence, team provider policy). */
  readonly aroundProviderSessionOpen?: <A, E, R>(
    input: LecturnProviderSessionOpenInput,
    open: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LecturnHookRejectedError, R>;
  /**
   * Before ThreadLaunchService commits a launch that will provision a new
   * worktree (Stave worktree admission). Reject to fail the launch before the
   * thread is created or any worktree exists.
   */
  readonly beforeWorktreeProvision?: (
    input: LecturnWorktreeProvisionInput,
  ) => Effect.Effect<void, LecturnHookRejectedError>;
  /**
   * Before a rollback restores checkpoint files (command admission and again in
   * CheckpointRollbackService). Reject to refuse the file restore; rewinding
   * without restoring files is unaffected.
   */
  readonly beforeCheckpointRestore?: (
    input: LecturnCheckpointRestoreInput,
  ) => Effect.Effect<void, LecturnHookRejectedError>;
  /** After a run reaches a terminal status. Failures are logged and ignored. */
  readonly onRunTerminal?: (notice: LecturnRunTerminalNotice) => Effect.Effect<void>;
  /** After a thread lifecycle command commits. Failures are logged and ignored. */
  readonly onThreadLifecycle?: (notice: LecturnThreadLifecycleNotice) => Effect.Effect<void>;
}

export interface LecturnOrchestrationHooksShape {
  readonly register: (
    contribution: LecturnOrchestrationHooksContribution,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly aroundCommand: <A, E, R>(
    input: LecturnCommandAdmissionInput,
    commit: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LecturnHookRejectedError, R>;
  readonly beforeTurnStart: (
    input: LecturnTurnStartInput,
  ) => Effect.Effect<LecturnTurnStartDecision, LecturnHookRejectedError>;
  readonly aroundProviderSessionOpen: <A, E, R>(
    input: LecturnProviderSessionOpenInput,
    open: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LecturnHookRejectedError, R>;
  readonly beforeWorktreeProvision: (
    input: LecturnWorktreeProvisionInput,
  ) => Effect.Effect<void, LecturnHookRejectedError>;
  readonly beforeCheckpointRestore: (
    input: LecturnCheckpointRestoreInput,
  ) => Effect.Effect<void, LecturnHookRejectedError>;
  readonly onRunTerminal: (notice: LecturnRunTerminalNotice) => Effect.Effect<void>;
  /** Derives lifecycle notices from a committed command and delivers them. */
  readonly afterCommit: (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
  }) => Effect.Effect<void>;
}

export class LecturnOrchestrationHooks extends Context.Service<
  LecturnOrchestrationHooks,
  LecturnOrchestrationHooksShape
>()("lecturn/orchestration-v2/fork/LecturnOrchestrationHooks") {}

/** Lifecycle notices a committed command produced (empty for other commands). */
export function threadLifecycleNotices(input: {
  readonly command: OrchestrationV2ServerCommand;
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
}): ReadonlyArray<LecturnThreadLifecycleNotice> {
  const { command } = input;
  switch (command.type) {
    case "thread.create":
      return [
        {
          kind: "created",
          threadId: command.threadId,
          projectId: command.projectId,
          ...(command.contextual === undefined ? {} : { contextual: command.contextual }),
        },
      ];
    case "thread.fork": {
      const created = input.storedEvents.find(
        (stored) =>
          stored.event.type === "thread.created" &&
          stored.event.threadId === command.targetThreadId,
      );
      const projectId =
        created?.event.type === "thread.created" ? created.event.payload.projectId : undefined;
      if (projectId === undefined) return [];
      return [
        {
          kind: "forked",
          threadId: command.targetThreadId,
          projectId,
          sourceThreadId: command.sourceThreadId,
          sourceMessageId: command.sourceMessageId ?? null,
          relayAlert: false,
        },
      ];
    }
    case "thread.import": {
      const imported = input.storedEvents.find(
        (stored) =>
          stored.event.type === "thread.imported" && stored.event.threadId === command.threadId,
      );
      const importedFrom =
        imported?.event.type === "thread.imported" ? imported.event.payload.importedFrom : null;
      if (importedFrom === null || importedFrom === undefined) return [];
      return [
        {
          kind: "imported",
          threadId: command.threadId,
          projectId: command.projectId,
          importedFrom,
        },
      ];
    }
    case "thread.delete":
      return [{ kind: "deleted", threadId: command.threadId }];
    case "thread.archive":
      return [{ kind: "archived", threadId: command.threadId }];
    case "thread.unarchive":
      return [{ kind: "unarchived", threadId: command.threadId }];
    default:
      return [];
  }
}

const makeShape = (
  contributions: Ref.Ref<ReadonlyArray<LecturnOrchestrationHooksContribution>>,
): LecturnOrchestrationHooksShape => {
  const current = Ref.get(contributions);
  const notify = <N>(
    hook: string,
    select: (
      contribution: LecturnOrchestrationHooksContribution,
    ) => ((notice: N) => Effect.Effect<void>) | undefined,
    notice: N,
  ) =>
    Effect.flatMap(current, (all) =>
      Effect.forEach(
        all,
        (contribution) => {
          const handler = select(contribution);
          return handler === undefined
            ? Effect.void
            : Effect.suspend(() => handler(notice)).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Lecturn orchestration hook failed", {
                    hook,
                    contribution: contribution.name,
                    cause,
                  }),
                ),
              );
        },
        { discard: true },
      ),
    );
  return {
    register: (contribution) =>
      Effect.acquireRelease(
        Ref.updateAndGet(contributions, (all) => [...all, contribution]),
        () => Ref.update(contributions, (all) => all.filter((entry) => entry !== contribution)),
      ).pipe(
        Effect.flatMap((all) =>
          Effect.logDebug("Lecturn orchestration hook registered", {
            contribution: contribution.name,
            registered: all.map((entry) => entry.name),
          }),
        ),
      ),
    // The first registered contribution is the outermost wrapper.
    aroundCommand: <A, E, R>(input: LecturnCommandAdmissionInput, commit: Effect.Effect<A, E, R>) =>
      Effect.flatMap(current, (all) =>
        all.reduceRight<Effect.Effect<A, E | LecturnHookRejectedError, R>>(
          (inner, contribution) =>
            contribution.aroundCommand === undefined
              ? inner
              : contribution.aroundCommand(input, inner),
          commit,
        ),
      ),
    beforeTurnStart: (input) =>
      Effect.flatMap(current, (all) =>
        Effect.forEach(all, (contribution) =>
          contribution.beforeTurnStart === undefined
            ? Effect.succeed(undefined)
            : contribution
                .beforeTurnStart(input)
                .pipe(
                  Effect.map((decision) =>
                    decision?.contextPrefix === undefined || decision.contextPrefix.trim() === ""
                      ? undefined
                      : decision.contextPrefix,
                  ),
                ),
        ),
      ).pipe(
        Effect.map((parts) => parts.filter((part): part is string => part !== undefined)),
        Effect.map((prefixes): LecturnTurnStartDecision =>
          prefixes.length === 0 ? {} : { contextPrefix: prefixes.join("\n\n") },
        ),
      ),
    aroundProviderSessionOpen: <A, E, R>(
      input: LecturnProviderSessionOpenInput,
      open: Effect.Effect<A, E, R>,
    ) =>
      Effect.flatMap(current, (all) =>
        all.reduceRight<Effect.Effect<A, E | LecturnHookRejectedError, R>>(
          (inner, contribution) =>
            contribution.aroundProviderSessionOpen === undefined
              ? inner
              : contribution.aroundProviderSessionOpen(input, inner),
          open,
        ),
      ),
    beforeWorktreeProvision: (input) =>
      Effect.flatMap(current, (all) =>
        Effect.forEach(
          all,
          (contribution) =>
            contribution.beforeWorktreeProvision === undefined
              ? Effect.void
              : contribution.beforeWorktreeProvision(input),
          { discard: true },
        ),
      ),
    beforeCheckpointRestore: (input) =>
      Effect.flatMap(current, (all) =>
        Effect.forEach(
          all,
          (contribution) =>
            contribution.beforeCheckpointRestore === undefined
              ? Effect.void
              : contribution.beforeCheckpointRestore(input),
          { discard: true },
        ),
      ),
    onRunTerminal: (notice) => notify("onRunTerminal", (entry) => entry.onRunTerminal, notice),
    afterCommit: (input) => {
      const notices = threadLifecycleNotices(input);
      return notices.length === 0
        ? Effect.void
        : Effect.forEach(
            notices,
            (notice) => notify("onThreadLifecycle", (entry) => entry.onThreadLifecycle, notice),
            { discard: true },
          );
    },
  };
};

const make = Effect.map(
  Ref.make<ReadonlyArray<LecturnOrchestrationHooksContribution>>([]),
  (contributions) => LecturnOrchestrationHooks.of(makeShape(contributions)),
);

/** The registry with no contributions: every hook is a no-op. Provided by runtimeLayer. */
export const layer: Layer.Layer<LecturnOrchestrationHooks> = Layer.effect(
  LecturnOrchestrationHooks,
  make,
);

/** Stateless no-op used where the service is absent (focused upstream tests). */
export const noop: LecturnOrchestrationHooksShape = {
  register: () => Effect.void,
  aroundCommand: (_input, commit) => commit,
  beforeTurnStart: () => Effect.succeed({}),
  aroundProviderSessionOpen: (_input, open) => open,
  beforeWorktreeProvision: () => Effect.void,
  beforeCheckpointRestore: () => Effect.void,
  onRunTerminal: () => Effect.void,
  afterCommit: () => Effect.void,
};

/** Resolve the hooks at layer construction; falls back to `noop` when not provided. */
export const resolve: Effect.Effect<LecturnOrchestrationHooksShape> = Effect.flatMap(
  Effect.serviceOption(LecturnOrchestrationHooks),
  Option.match({
    onNone: () =>
      Effect.logDebug("Lecturn orchestration hooks not provided; using no-op hooks").pipe(
        Effect.as(noop),
      ),
    onSome: Effect.succeed,
  }),
);
