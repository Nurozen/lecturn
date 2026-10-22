/**
 * StaveOrchestration - the narrow orchestration surface Stave code needs.
 *
 * V1 Stave modules read `ProjectionSnapshotQuery`, dispatched through the V1
 * `OrchestrationEngine` (with a `staveReconciliation` bypass for commands
 * issued while a Stave operation already holds the space locks) and stopped
 * runtimes through the V1 `ProviderService`. This service keeps that surface
 * small and V1-shaped so the Stave modules and their tests stay readable.
 * `StaveOrchestrationLive.layer` implements it on V2: `ProjectService` for project commands,
 * `OrchestratorV2` for run interrupts, the V2 projections for reads, the
 * application event log for tails and `ProviderSessionManagerV2` for runtime
 * quiescence.
 *
 * @module StaveOrchestration
 */
import type {
  ApplicationStoredEvent,
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationProjectShell,
  ProjectId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class StaveOrchestrationError extends Schema.TaggedError<StaveOrchestrationError>()(
  "StaveOrchestrationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    const cause = this.cause;
    const detail =
      typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { message: unknown }).message)
        : typeof cause === "string"
          ? cause
          : undefined;
    return detail ?? `Stave orchestration operation '${this.operation}' failed.`;
  }
}

/**
 * Set while a Stave operation dispatches a command under space locks it
 * already holds. Commit admission skips lock acquisition for these commands
 * (V1 `staveReconciliation`). Commands run in the dispatching fiber, so the
 * reference reaches the admission hook.
 */
export class StaveReconciliation extends Context.Reference<boolean>(
  "lecturn/stave/StaveReconciliation",
  { defaultValue: () => false },
) {}

/** Activity stamps of one thread, used for archive scheduling. */
export interface StaveThreadLifecycleAnchor {
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt: string | null;
  readonly unsettledAt: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
}

export interface StaveThreadView {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  /** The running root run, if any (V1 `session.activeTurnId`). */
  readonly activeRunId: RunId | null;
}

export interface StaveShellSnapshot {
  readonly snapshotSequence: number;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  /** Active and archived threads of active projects. */
  readonly threads: ReadonlyArray<StaveThreadView>;
}

export interface StaveRuntimeSession {
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
  readonly cwd?: string;
  /** True while the session runs a turn. */
  readonly active: boolean;
}

export interface StaveInferenceTurnPair {
  readonly question: string;
  readonly response: string;
}

export type StaveOrchestrationCommand =
  | {
      readonly type: "project.create";
      readonly commandId: CommandId;
      readonly projectId: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
    }
  | {
      readonly type: "project.meta.update";
      readonly commandId: CommandId;
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
    }
  | {
      readonly type: "project.delete";
      readonly commandId: CommandId;
      readonly projectId: ProjectId;
      readonly force?: boolean;
    }
  | {
      readonly type: "project.refresh";
      readonly commandId: CommandId;
      readonly projectId: ProjectId;
    }
  | {
      readonly type: "thread.turn.interrupt";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    };

export interface StaveDispatchOptions {
  /** The caller already holds the Stave space locks for this command. */
  readonly staveReconciliation?: true;
}

export interface StaveOrchestrationShape {
  readonly getShellSnapshot: () => Effect.Effect<StaveShellSnapshot, StaveOrchestrationError>;
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, StaveOrchestrationError>;
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, StaveOrchestrationError>;
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<StaveThreadView>, StaveOrchestrationError>;
  readonly listThreadLifecycleAnchorsByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<StaveThreadLifecycleAnchor>, StaveOrchestrationError>;
  /** Up to three completed question/response pairs, oldest first. */
  readonly getInferenceTurnPairs: (input: {
    readonly threadId: ThreadId;
    readonly beforeMessageId?: MessageId;
  }) => Effect.Effect<ReadonlyArray<StaveInferenceTurnPair>, StaveOrchestrationError>;
  readonly dispatch: (
    command: StaveOrchestrationCommand,
    options?: StaveDispatchOptions,
  ) => Effect.Effect<{ readonly sequence: number }, StaveOrchestrationError>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<StaveRuntimeSession>,
    StaveOrchestrationError
  >;
  readonly stopSession: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, StaveOrchestrationError>;
  /** Close every live provider runtime whose workspace is under `root`. */
  readonly stopSessionsUnder: (root: string) => Effect.Effect<void, StaveOrchestrationError>;
  /**
   * Wait until the cleanup effects of the project's deleted threads (session
   * detach, terminal and attachment cleanup) have run, so Stave never removes
   * a space under a runtime that is still shutting down (V1
   * `ThreadDeletionReactor.drainThrough`).
   */
  readonly drainThreadCleanup: (input: {
    readonly projectId: ProjectId;
    readonly throughSequence: number;
  }) => Effect.Effect<void, StaveOrchestrationError>;
  readonly latestSequence: Effect.Effect<number, StaveOrchestrationError>;
  /** Project and V2 thread events after `afterSequence`, then the live tail. */
  readonly streamEvents: (
    afterSequence: number,
  ) => Stream.Stream<ApplicationStoredEvent, StaveOrchestrationError>;
}

export class StaveOrchestration extends Context.Service<
  StaveOrchestration,
  StaveOrchestrationShape
>()("lecturn/stave/StaveOrchestration") {}
