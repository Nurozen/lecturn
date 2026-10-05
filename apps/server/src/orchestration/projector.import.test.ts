import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type ThreadImportedPayload,
} from "@lecturn/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-05-01T00:00:00.000Z";
const importAt = "2026-05-01T01:00:00.000Z";
const threadId = ThreadId.make("thread-import-projector");
const instanceId = ProviderInstanceId.make("claudeAgent");

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`evt-import-projector-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: input.type,
    occurredAt: importAt,
    commandId: CommandId.make("cmd-import-projector"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-import-projector"),
    metadata: {},
    payload: input.payload,
  } as OrchestrationEvent;
}

const importedPayload: ThreadImportedPayload = {
  threadId,
  importedFrom: {
    providerInstanceId: instanceId,
    driverKind: ProviderDriverKind.make("claudeAgent"),
    sessionId: "external-session-projector",
    cwd: "/tmp/project-import",
    title: "External session",
    importedAt: importAt,
    historyTruncated: false,
  },
  importSource: { providerInstanceId: instanceId, resumeCursor: { resume: "forked-session" } },
  history: {
    messages: [
      {
        id: MessageId.make("00000000-0000-4000-8000-000000000301"),
        role: "user",
        text: "imported ask",
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    activities: [],
    proposedPlans: [],
    turns: [],
  },
};

it.effect("thread.imported sets the origin without a latest turn, bodies or the cursor", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId,
          projectId: ProjectId.make("project-import-projector"),
          title: "External session",
          modelSelection: { instanceId, model: "claude-sonnet-4-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: importAt,
          updatedAt: importAt,
        },
      }),
    );
    const imported = yield* projectEvent(
      created,
      makeEvent({ sequence: 2, type: "thread.imported", payload: importedPayload }),
    );

    const thread = imported.threads.find((entry) => entry.id === threadId);
    expect(thread?.importedFrom).toEqual(importedPayload.importedFrom);
    expect(thread?.latestTurn).toBeNull();
    expect(thread?.updatedAt).toBe(importAt);
    // Bodies mirror post-boot hydration: not copied into the in-memory model.
    expect(thread?.messages).toEqual([]);
    expect(thread?.activities).toEqual([]);
    expect(thread).not.toHaveProperty("importSource");
  }),
);

it.effect("thread.imported on an unknown thread leaves the model unchanged", () =>
  Effect.gen(function* () {
    const projected = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "thread.imported", payload: importedPayload }),
    );
    expect(projected.threads).toEqual([]);
  }),
);
