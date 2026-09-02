import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ThreadForkHistory,
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

const now = "2026-05-01T00:00:00.000Z";
const forkAt = "2026-05-01T01:00:00.000Z";

const projectId = asProjectId("project-fork");
const otherProjectId = asProjectId("project-fork-other");
const sourceThreadId = asThreadId("thread-fork-source");
const otherProjectThreadId = asThreadId("thread-fork-other-project");
const existingThreadId = asThreadId("thread-fork-existing");
const childThreadId = asThreadId("thread-fork-child");

const forkTurnId = TurnId.make("turn-fork-1");

const linkedPullRequest = {
  projectId,
  repository: "t3tools/t3code",
  number: 7,
  url: "https://github.com/t3tools/t3code/pull/7",
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const threadCreatedEvent = (input: {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) => ({
  sequence: input.sequence,
  eventId: asEventId(`evt-create-${input.threadId}`),
  aggregateKind: "thread" as const,
  aggregateId: input.threadId,
  type: "thread.created" as const,
  occurredAt: now,
  commandId: asCommandId(`cmd-create-${input.threadId}`),
  causationEventId: null,
  correlationId: asCommandId(`cmd-create-${input.threadId}`),
  metadata: {},
  payload: {
    threadId: input.threadId,
    projectId: input.projectId,
    title: `Thread ${input.threadId}`,
    modelSelection,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required" as const,
    branch: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now,
  },
});

const seedReadModel = Effect.gen(function* () {
  let readModel = createEmptyReadModel(now);
  for (const project of [projectId, otherProjectId]) {
    readModel = yield* projectEvent(readModel, {
      sequence: project === projectId ? 1 : 2,
      eventId: asEventId(`evt-project-${project}`),
      aggregateKind: "project",
      aggregateId: project,
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId(`cmd-project-${project}`),
      causationEventId: null,
      correlationId: asCommandId(`cmd-project-${project}`),
      metadata: {},
      payload: {
        projectId: project,
        title: `Project ${project}`,
        workspaceRoot: `/tmp/${project}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  readModel = yield* projectEvent(
    readModel,
    threadCreatedEvent({ sequence: 3, threadId: sourceThreadId, projectId }),
  );
  readModel = yield* projectEvent(
    readModel,
    threadCreatedEvent({
      sequence: 4,
      threadId: otherProjectThreadId,
      projectId: otherProjectId,
    }),
  );
  readModel = yield* projectEvent(
    readModel,
    threadCreatedEvent({ sequence: 5, threadId: existingThreadId, projectId }),
  );
  // The source carries a linked pull request the fork must inherit.
  readModel = yield* projectEvent(readModel, {
    sequence: 6,
    eventId: asEventId("evt-meta-linked-pr"),
    aggregateKind: "thread",
    aggregateId: sourceThreadId,
    type: "thread.meta-updated",
    occurredAt: now,
    commandId: asCommandId("cmd-meta-linked-pr"),
    causationEventId: null,
    correlationId: asCommandId("cmd-meta-linked-pr"),
    metadata: {},
    payload: {
      threadId: sourceThreadId,
      linkedPullRequest,
      updatedAt: now,
    },
  });
  return readModel;
});

const history: ThreadForkHistory = {
  messages: [
    {
      id: MessageId.make("00000000-0000-4000-8000-000000000101"),
      role: "user",
      text: "inherited ask",
      attachments: [],
      turnId: forkTurnId,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: MessageId.make("assistant:00000000-0000-4000-8000-000000000102"),
      role: "assistant",
      text: "inherited answer",
      attachments: [],
      turnId: forkTurnId,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  activities: [],
  proposedPlans: [],
  turns: [
    {
      turnId: forkTurnId,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      pendingMessageId: MessageId.make("00000000-0000-4000-8000-000000000101"),
      assistantMessageId: MessageId.make("assistant:00000000-0000-4000-8000-000000000102"),
      providerTurnRef: "prov-fork-1",
    },
  ],
};

const forkSource = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  resumeCursor: { threadId: "native-thread" },
  providerTurnRef: "prov-fork-1",
  throughTurnOrdinal: 1,
  atEnd: true,
};

function makeForkCommand(
  overrides?: Partial<Extract<OrchestrationCommand, { type: "thread.fork" }>>,
): OrchestrationCommand {
  return {
    type: "thread.fork",
    commandId: asCommandId("cmd-thread-fork"),
    threadId: childThreadId,
    sourceThreadId,
    throughTurnId: forkTurnId,
    createdAt: forkAt,
    thread: {
      projectId,
      title: "Thread thread-fork-source (fork)",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
    },
    forkedFrom: {
      threadId: sourceThreadId,
      turnId: forkTurnId,
      turnCount: 1,
      messageId: null,
    },
    forkSource,
    history,
    ...overrides,
  };
}

it.layer(NodeServices.layer)("decider thread.fork", (it) => {
  it.effect("emits thread.created then thread.forked on the child aggregate", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const command = makeForkCommand();
      const result = yield* decideOrchestrationCommand({ command, readModel });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(2);
      const [created, forked] = events;

      expect(created?.type).toBe("thread.created");
      expect(created?.aggregateKind).toBe("thread");
      expect(created?.aggregateId).toBe(childThreadId);
      expect(created?.occurredAt).toBe(forkAt);
      expect(created?.causationEventId).toBeNull();
      expect(created?.payload).toEqual({
        threadId: childThreadId,
        projectId,
        title: "Thread thread-fork-source (fork)",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: forkAt,
        updatedAt: forkAt,
      });

      expect(forked?.type).toBe("thread.forked");
      expect(forked?.aggregateKind).toBe("thread");
      expect(forked?.aggregateId).toBe(childThreadId);
      expect(forked?.occurredAt).toBe(forkAt);
      expect(forked?.causationEventId).toBe(created?.eventId);
      expect(forked?.correlationId).toBe(command.commandId);
      expect(forked?.payload).toEqual({
        threadId: childThreadId,
        forkedFrom: {
          threadId: sourceThreadId,
          turnId: forkTurnId,
          turnCount: 1,
          messageId: null,
        },
        forkSource,
        history,
        // Inherited from the read model's source thread, not the command.
        linkedPullRequest,
      });
    }),
  );

  it.effect("rejects a fork whose history was never materialized", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const rawClientShape = {
        type: "thread.fork",
        commandId: asCommandId("cmd-thread-fork-raw"),
        threadId: childThreadId,
        sourceThreadId,
        throughTurnId: forkTurnId,
        sourceMessageId: undefined,
        title: "Raw fork",
        workspace: "inherit",
        createdAt: forkAt,
      } as unknown as OrchestrationCommand;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: rawClientShape, readModel }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("materialized");
    }),
  );

  it.effect("rejects a source thread from another project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeForkCommand({ sourceThreadId: otherProjectThreadId }),
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("project");
    }),
  );

  it.effect("rejects a child id that already exists", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeForkCommand({ threadId: existingThreadId }),
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a throughTurnId missing from the materialized history", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeForkCommand({ throughTurnId: TurnId.make("turn-not-in-history") }),
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects an unknown source thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeForkCommand({ sourceThreadId: asThreadId("thread-fork-missing") }),
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
