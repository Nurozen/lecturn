import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ThreadForkedPayload,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-05-01T00:00:00.000Z";
const forkAt = "2026-05-01T01:00:00.000Z";

const childThreadId = ThreadId.make("thread-fork-child");
const sourceThreadId = ThreadId.make("thread-fork-source");
const projectId = ProjectId.make("project-fork");
const turn1 = TurnId.make("turn-1");
const turn2 = TurnId.make("turn-2");

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly occurredAt?: string;
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: childThreadId,
    occurredAt: input.occurredAt ?? now,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const linkedPullRequest = {
  projectId,
  repository: "t3tools/t3code",
  number: 7,
  url: "https://github.com/t3tools/t3code/pull/7",
};

const inheritedPlan = {
  id: "plan-child-1",
  turnId: turn1,
  planMarkdown: "# inherited plan",
  implementedAt: null,
  implementationThreadId: null,
  createdAt: now,
  updatedAt: now,
};

const forkedPayload: ThreadForkedPayload = {
  threadId: childThreadId,
  forkedFrom: {
    threadId: sourceThreadId,
    turnId: turn2,
    turnCount: 2,
    messageId: null,
  },
  forkSource: {
    providerInstanceId: ProviderInstanceId.make("codex"),
    resumeCursor: { threadId: "native-thread" },
    providerTurnRef: "prov-2",
    throughTurnOrdinal: 2,
    atEnd: true,
  },
  history: {
    messages: [
      {
        id: MessageId.make("00000000-0000-4000-8000-000000000201"),
        role: "user",
        text: "inherited ask",
        attachments: [],
        turnId: turn1,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: MessageId.make("assistant:00000000-0000-4000-8000-000000000202"),
        role: "assistant",
        text: "inherited answer",
        attachments: [],
        turnId: turn2,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    activities: [
      {
        id: EventId.make("00000000-0000-4000-8000-000000000301"),
        tone: "tool",
        kind: "tool.ran",
        summary: "ran a tool",
        payload: { tool: "bash" },
        turnId: turn1,
        createdAt: now,
      },
    ],
    proposedPlans: [inheritedPlan],
    turns: [
      {
        turnId: turn1,
        state: "completed",
        requestedAt: "2026-05-01T00:10:00.000Z",
        startedAt: "2026-05-01T00:10:05.000Z",
        completedAt: "2026-05-01T00:10:30.000Z",
        pendingMessageId: MessageId.make("00000000-0000-4000-8000-000000000201"),
        assistantMessageId: null,
        providerTurnRef: "prov-1",
      },
      {
        turnId: turn2,
        state: "completed",
        requestedAt: "2026-05-01T00:20:00.000Z",
        startedAt: "2026-05-01T00:20:05.000Z",
        completedAt: "2026-05-01T00:20:30.000Z",
        pendingMessageId: null,
        assistantMessageId: MessageId.make("assistant:00000000-0000-4000-8000-000000000202"),
        providerTurnRef: "prov-2",
      },
    ],
  },
  linkedPullRequest,
};

const seedChild = Effect.gen(function* () {
  return yield* projectEvent(
    createEmptyReadModel(now),
    makeEvent({
      sequence: 1,
      type: "thread.created",
      occurredAt: forkAt,
      payload: {
        threadId: childThreadId,
        projectId,
        title: "Parent thread (fork)",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: forkAt,
        updatedAt: forkAt,
      },
    }),
  );
});

it.effect("thread.forked sets lineage, latest turn and plans without hydrating bodies", () =>
  Effect.gen(function* () {
    const created = yield* seedChild;
    const forked = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.forked",
        occurredAt: forkAt,
        payload: forkedPayload,
      }),
    );

    const child = forked.threads.find((thread) => thread.id === childThreadId);
    expect(child).toBeDefined();
    expect(child?.forkedFrom).toEqual(forkedPayload.forkedFrom);
    expect(child?.linkedPullRequest).toEqual(linkedPullRequest);
    // Latest turn mirrors the last inherited turn row.
    expect(child?.latestTurn).toEqual({
      turnId: turn2,
      state: "completed",
      requestedAt: "2026-05-01T00:20:00.000Z",
      startedAt: "2026-05-01T00:20:05.000Z",
      completedAt: "2026-05-01T00:20:30.000Z",
      assistantMessageId: MessageId.make("assistant:00000000-0000-4000-8000-000000000202"),
    });
    expect(child?.proposedPlans).toEqual([inheritedPlan]);
    expect(child?.updatedAt).toBe(forkAt);
    // Bodies mirror post-boot hydration: not copied into the in-memory model.
    expect(child?.messages).toEqual([]);
    expect(child?.activities).toEqual([]);
    expect(child?.checkpoints).toEqual([]);
    expect(child?.session).toBeNull();
  }),
);

it.effect("thread.forked on an unknown thread leaves the model unchanged", () =>
  Effect.gen(function* () {
    const empty = createEmptyReadModel(now);
    const projected = yield* projectEvent(
      empty,
      makeEvent({
        sequence: 1,
        type: "thread.forked",
        occurredAt: forkAt,
        payload: forkedPayload,
      }),
    );
    expect(projected.threads).toEqual([]);
  }),
);
