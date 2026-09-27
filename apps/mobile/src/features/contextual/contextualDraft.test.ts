import { describe, expect, it } from "vite-plus/test";
import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@lecturn/contracts";
import { contextualBootstrap } from "./contextualDraft";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "../../state/thread-outbox-model";

describe("Contextual draft delivery", () => {
  it("preserves explicit off and source scope across durable outbox encoding", () => {
    const message: QueuedThreadMessage = {
      environmentId: EnvironmentId.make("host-one"),
      threadId: ThreadId.make("draft-thread"),
      commandId: CommandId.make("command-one"),
      messageId: MessageId.make("message-one"),
      text: "Use the selected project",
      attachments: [],
      createdAt: "2026-09-26T00:00:00Z",
      creation: {
        projectId: ProjectId.make("project-one"),
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
        contextual: { enabled: false, sourceIds: ["decisions:project-one", "slack-synthetic"] },
      },
    };
    const restored = decodeQueuedThreadMessage(encodeQueuedThreadMessage(message));
    expect(restored).toEqual(message);
    expect(contextualBootstrap(true, restored.creation?.contextual)).toEqual({
      contextual: { enabled: false, sourceIds: ["decisions:project-one", "slack-synthetic"] },
    });
    expect(contextualBootstrap(false, restored.creation?.contextual)).toEqual({});
  });
  it("lets untouched drafts inherit host defaults and keeps legacy queued tasks compatible", () => {
    expect(contextualBootstrap(true, undefined)).toEqual({});
    const legacy = decodeQueuedThreadMessage({
      schemaVersion: 1,
      environmentId: "host-two",
      threadId: "thread-two",
      commandId: "command-two",
      messageId: "message-two",
      text: "Older task",
      attachments: [],
      createdAt: "2026-09-26T00:00:00Z",
      creation: {
        projectId: "project-two",
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
      },
    });
    expect(legacy.creation?.contextual).toBeUndefined();
  });
});
