import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@lecturn/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EARLIER = "2025-12-31T23:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "Claude",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function makeLatestTurn(
  state: OrchestrationLatestTurn["state"],
  at: string = NOW,
): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: at,
    startedAt: at,
    completedAt: state === "completed" ? at : null,
    assistantMessageId: null,
  };
}

function makeUserMessage(createdAt: string): OrchestrationThread["messages"][number] {
  return {
    id: MessageId.make("message-queued"),
    role: "user",
    text: "Continue",
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeReadModel(input: {
  readonly session?: OrchestrationSession | null;
  readonly latestTurn?: OrchestrationLatestTurn | null;
  readonly messages?: OrchestrationThread["messages"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-fable-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: input.latestTurn ?? null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: input.messages ?? [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: input.session ?? null,
      },
    ],
    updatedAt: NOW,
  };
}

function revertCommand(commandId: string) {
  return {
    type: "thread.checkpoint.revert" as const,
    commandId: CommandId.make(commandId),
    threadId: THREAD_ID,
    turnCount: 1,
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("checkpoint revert decider", (it) => {
  it.effect("requests a revert when no turn is in flight", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: revertCommand("cmd-revert-idle"),
        readModel: makeReadModel({
          session: makeSession("ready"),
          latestTurn: makeLatestTurn("completed"),
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.checkpoint-revert-requested");
    }),
  );

  // Restoring the worktree underneath a running agent corrupts the tree, and
  // the client-side guard cannot survive a direct dispatch or a click that
  // races the reactor.
  for (const status of ["running", "starting"] as const) {
    it.effect(`rejects a revert while the session is ${status}`, () =>
      Effect.gen(function* () {
        const failure = yield* decideOrchestrationCommand({
          command: revertCommand(`cmd-revert-${status}`),
          readModel: makeReadModel({ session: makeSession(status) }),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("OrchestrationCommandInvariantError");
        expect(failure.message).toContain("turn in flight");
      }),
    );
  }

  it.effect("rejects a revert while the latest turn is still running", () =>
    Effect.gen(function* () {
      const failure = yield* decideOrchestrationCommand({
        command: revertCommand("cmd-revert-turn-running"),
        readModel: makeReadModel({
          session: makeSession("ready"),
          latestTurn: makeLatestTurn("running"),
        }),
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("still allows a revert when the thread has no session at all", () =>
    Effect.gen(function* () {
      // The reactor reports the missing session with a precise activity; the
      // decider must not swallow the command first and hide that reason.
      const result = yield* decideOrchestrationCommand({
        command: revertCommand("cmd-revert-no-session"),
        readModel: makeReadModel({ session: null }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events[0]?.type).toBe("thread.checkpoint-revert-requested");
    }),
  );

  it.effect("allows a revert when a user message is queued but no turn has started", () =>
    Effect.gen(function* () {
      // `threadHasQueuedTurnStart` would call this thread busy: the newest user
      // message is recent and newer than every timestamp on the latest turn.
      // That heuristic exists for settlement, where a false positive is free.
      // As a revert gate it would reject a legitimate action on a guess, and
      // nothing is writing to the worktree until a turn actually starts.
      const result = yield* decideOrchestrationCommand({
        command: revertCommand("cmd-revert-queued-message"),
        readModel: makeReadModel({
          session: makeSession("ready"),
          // Turn finished an hour before the newest user message, which is the
          // exact shape the queued-turn heuristic reads as "busy".
          latestTurn: makeLatestTurn("completed", EARLIER),
          messages: [makeUserMessage(NOW)],
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events[0]?.type).toBe("thread.checkpoint-revert-requested");
    }),
  );
});
