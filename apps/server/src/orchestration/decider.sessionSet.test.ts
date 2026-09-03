import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type OrchestrationSession,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const now = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-session"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-session"),
      title: "Project Session",
      workspaceRoot: "/tmp/project-session",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-session"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-session"),
      projectId: asProjectId("project-session"),
      title: "Thread Session",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const readySession: OrchestrationSession = {
  threadId: asThreadId("thread-session"),
  status: "ready",
  providerName: "codex",
  runtimeMode: "approval-required",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
};

it.layer(NodeServices.layer)("decider thread.session.set turn anchors", (it) => {
  it.effect("stamps the provider anchor into metadata and the turn into the payload", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: asCommandId("cmd-session-set-anchored"),
          threadId: asThreadId("thread-session"),
          session: readySession,
          providerTurnId: "resp-native-1",
          completedTurnId: asTurnId("turn-1"),
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.session-set");
      expect(event.metadata).toEqual({ providerTurnId: "resp-native-1" });
      if (event.type === "thread.session-set") {
        expect(event.payload.completedTurnId).toBe("turn-1");
        expect(event.payload.session).toEqual(readySession);
      }
    }),
  );

  it.effect("omits the anchor metadata and payload turn when the command carries none", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: asCommandId("cmd-session-set-plain"),
          threadId: asThreadId("thread-session"),
          session: readySession,
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.session-set");
      expect(event.metadata).toEqual({});
      if (event.type === "thread.session-set") {
        expect("completedTurnId" in event.payload).toBe(false);
      }
    }),
  );
});
