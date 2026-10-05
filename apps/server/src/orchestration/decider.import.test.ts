import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ThreadForkHistory,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-05-01T00:00:00.000Z";
const importAt = "2026-05-01T01:00:00.000Z";

const projectId = ProjectId.make("project-import");
const existingThreadId = ThreadId.make("thread-import-existing");
const importedThreadId = ThreadId.make("thread-import-new");

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-5",
};

const seedReadModel = Effect.gen(function* () {
  let readModel = createEmptyReadModel(now);
  readModel = yield* projectEvent(readModel, {
    sequence: 1,
    eventId: EventId.make("evt-project-import"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-project-import"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-import"),
    metadata: {},
    payload: {
      projectId,
      title: "Project import",
      workspaceRoot: "/tmp/project-import",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  readModel = yield* projectEvent(readModel, {
    sequence: 2,
    eventId: EventId.make("evt-create-existing"),
    aggregateKind: "thread",
    aggregateId: existingThreadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-create-existing"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-create-existing"),
    metadata: {},
    payload: {
      threadId: existingThreadId,
      projectId,
      title: "Existing thread",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return readModel;
});

const history: ThreadForkHistory = {
  messages: [
    {
      id: MessageId.make("00000000-0000-4000-8000-000000000201"),
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
};

const importedFrom = {
  providerInstanceId: modelSelection.instanceId,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  sessionId: "external-session-1",
  cwd: "/tmp/project-import",
  title: "External session",
  importedAt: importAt,
  historyTruncated: false,
};

const importSource = {
  providerInstanceId: modelSelection.instanceId,
  resumeCursor: { resume: "forked-session-1" },
};

type ThreadImportCommand = Extract<OrchestrationCommand, { type: "thread.import" }>;

function makeImportCommand(overrides?: Partial<ThreadImportCommand>): ThreadImportCommand {
  return {
    type: "thread.import",
    commandId: CommandId.make("cmd-thread-import"),
    threadId: importedThreadId,
    createdAt: importAt,
    thread: {
      projectId,
      title: "External session",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
    },
    importedFrom,
    importSource,
    history,
    ...overrides,
  };
}

it.layer(NodeServices.layer)("decider thread.import", (it) => {
  it.effect("emits thread.created then thread.imported on the new aggregate", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const command = makeImportCommand();
      const result = yield* decideOrchestrationCommand({ command, readModel });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual(["thread.created", "thread.imported"]);
      const [created, imported] = events;

      expect(created?.aggregateId).toBe(importedThreadId);
      expect(created?.causationEventId).toBeNull();
      expect(created?.payload).toEqual({
        threadId: importedThreadId,
        projectId,
        title: "External session",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: importAt,
        updatedAt: importAt,
      });

      expect(imported?.aggregateKind).toBe("thread");
      expect(imported?.aggregateId).toBe(importedThreadId);
      expect(imported?.occurredAt).toBe(importAt);
      expect(imported?.causationEventId).toBe(created?.eventId);
      expect(imported?.correlationId).toBe(command.commandId);
      expect(imported?.payload).toEqual({
        threadId: importedThreadId,
        importedFrom,
        importSource,
        history,
      });
    }),
  );

  it.effect("rejects an import that was never materialized", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const rawClientShape = {
        type: "thread.import",
        commandId: CommandId.make("cmd-thread-import-raw"),
        threadId: importedThreadId,
        projectId,
        providerInstanceId: modelSelection.instanceId,
        sessionId: "external-session-1",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: importAt,
      } as unknown as OrchestrationCommand;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: rawClientShape, readModel }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("materialized");
    }),
  );

  it.effect("rejects an unknown project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const command = makeImportCommand();
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...command,
            thread: { ...command.thread, projectId: ProjectId.make("project-import-missing") },
          },
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a thread id that already exists", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeImportCommand({ threadId: existingThreadId }),
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
