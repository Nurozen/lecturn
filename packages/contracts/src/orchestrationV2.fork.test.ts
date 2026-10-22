// Lecturn fork surfaces on the V2 orchestration contracts: thread import,
// fork extras, Stave project fields, project.refreshed, contextual launch
// option and the checkpoint revert preview.
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { ApplicationProjectEvent } from "./applicationEvent.ts";
import { MessageId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import {
  ORCHESTRATION_REVERT_PREVIEW_MAX_PATHS,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellJson,
  isImportedHistoryMessage,
} from "./orchestrationV2.ts";
import { ProjectMutation } from "./project.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeEventJson = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const decodeShellJson = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
const decodeProjectShell = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeProjectEvent = Schema.decodeUnknownSync(ApplicationProjectEvent);
const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);
const decodeLaunchInput = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput);
const decodeDispatchError = Schema.decodeUnknownSync(OrchestrationV2DispatchCommandError);
const decodeLinkedPullRequest = Schema.decodeUnknownSync(ThreadLinkedPullRequest);
const decodePreviewInput = Schema.decodeUnknownSync(
  OrchestrationV2RpcSchemas.previewCheckpointRevert.input,
);
const decodePreviewResult = Schema.decodeUnknownSync(
  OrchestrationV2RpcSchemas.previewCheckpointRevert.output,
);

const importedFrom = {
  providerInstanceId: "claudeAgent",
  driverKind: "claudeAgent",
  sessionId: "external-session-1",
  cwd: "/workspace",
  title: "",
  importedAt: "2026-01-02T00:00:00.000Z",
  historyTruncated: false,
};

const appThread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  providerInstanceId: "claudeAgent",
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
};

const shell = {
  ...appThread,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  settledOverride: null,
  settledAt: null,
};

const projectShell = {
  id: "project-1",
  title: "Project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

const projectEventBase = {
  sequence: 4,
  eventId: "event-project-1",
  aggregateKind: "project",
  aggregateId: "project-1",
  occurredAt: "2026-01-02T00:00:00.000Z",
  commandId: "cmd-project-1",
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

describe("external session import", () => {
  it("decodes a thread.import command; interaction mode and session are required", () => {
    const base = {
      type: "thread.import",
      createdBy: "user",
      creationSource: "web",
      commandId: "cmd-import-1",
      threadId: "thread-imported",
      projectId: "project-1",
      providerInstanceId: "claudeAgent",
      sessionId: "external-session-1",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    };
    const command = decodeCommand(base);
    if (command.type !== "thread.import") throw new Error(`Unexpected ${command.type}`);
    expect(command.sessionId).toBe("external-session-1");
    expect(command.title).toBeUndefined();

    const { sessionId: _sessionId, ...withoutSession } = base;
    expect(() => decodeCommand(withoutSession)).toThrow();
  });

  it("decodes thread.imported as an app-thread event in runtime and JSON forms", () => {
    const event = decodeEvent({
      id: "event-import-1",
      threadId: "thread-1",
      type: "thread.imported",
      occurredAt: now,
      payload: { ...appThread, importedFrom },
    });
    if (event.type !== "thread.imported") throw new Error(`Unexpected ${event.type}`);
    expect(event.payload.importedFrom?.sessionId).toBe("external-session-1");

    const json = decodeEventJson({
      id: "event-import-1",
      threadId: "thread-1",
      type: "thread.imported",
      occurredAt: "2026-04-20T00:00:00.000Z",
      payload: {
        ...appThread,
        importedFrom,
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
      },
    });
    expect(json.type).toBe("thread.imported");
  });

  it("carries import and fork origin on shells and keeps upstream-shaped shells decoding", () => {
    const plain = decodeShell(shell);
    expect(plain.importedFrom).toBeUndefined();
    expect(plain.forkOrigin).toBeUndefined();

    const forkOrigin = { threadId: "thread-parent", messageId: "message-7" };
    const decoded = decodeShell({
      ...shell,
      lineage: {
        parentThreadId: "thread-parent",
        relationshipToParent: "fork",
        rootThreadId: "thread-parent",
      },
      importedFrom,
      forkOrigin,
    });
    expect(decoded.importedFrom).toEqual({
      ...importedFrom,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
    });
    expect(decoded.forkOrigin).toEqual({
      threadId: ThreadId.make("thread-parent"),
      messageId: MessageId.make("message-7"),
    });

    const json = decodeShellJson({
      ...shell,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      importedFrom,
      forkOrigin: { threadId: "thread-parent", messageId: null },
    });
    expect(json.forkOrigin?.messageId).toBeNull();
    expect(json.importedFrom?.importedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("bounds imported history by importedAt, not the thread's creation", () => {
    const forkedChild = {
      importedFrom: {
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        driverKind: ProviderDriverKind.make("claudeAgent"),
        sessionId: "external-session-1",
        cwd: "/workspace",
        title: "",
        importedAt: "2026-01-02T00:00:00.000Z",
        historyTruncated: false,
      },
    };
    const atImport = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
    expect(isImportedHistoryMessage(forkedChild, { runId: null, createdAt: atImport })).toBe(true);
    expect(
      isImportedHistoryMessage(forkedChild, {
        runId: null,
        createdAt: "2026-01-02T00:00:00.001Z",
      }),
    ).toBe(false);
    expect(isImportedHistoryMessage(forkedChild, { runId: "run-1", createdAt: atImport })).toBe(
      false,
    );
    expect(
      isImportedHistoryMessage({ importedFrom: null }, { runId: null, createdAt: atImport }),
    ).toBe(false);
  });

  it("reports why an import could not be materialized on the dispatch error", () => {
    const error = decodeDispatchError({
      _tag: "OrchestrationV2DispatchCommandError",
      commandId: "cmd-import-1",
      commandType: "thread.import",
      message: "Session not found.",
      threadImportFailure: "session-not-found",
    });
    expect(error.threadImportFailure).toBe("session-not-found");
  });
});

describe("thread.fork Lecturn extras", () => {
  const fork = {
    type: "thread.fork",
    createdBy: "user",
    creationSource: "web",
    commandId: "cmd-fork-1",
    sourceThreadId: "thread-parent",
    targetThreadId: "thread-child",
    sourcePoint: { type: "latest_stable" },
  };

  it("keeps upstream-shaped forks decoding without the extras", () => {
    const command = decodeCommand(fork);
    if (command.type !== "thread.fork") throw new Error(`Unexpected ${command.type}`);
    expect(command.workspace).toBeUndefined();
    expect(command.sourceMessageId).toBeUndefined();
  });

  it("decodes a fork cut at a user message into a new worktree", () => {
    const command = decodeCommand({
      ...fork,
      sourcePoint: { type: "run", runId: "run-2" },
      sourceMessageId: "message-2",
      workspace: "new-worktree",
      prepareWorktree: {
        projectCwd: "/tmp/workspace",
        baseBranch: "main",
        branch: "lecturn/fork",
        startFromOrigin: true,
        requireWorktree: true,
      },
    });
    if (command.type !== "thread.fork") throw new Error(`Unexpected ${command.type}`);
    expect(command.sourceMessageId).toBe("message-2");
    expect(command.workspace).toBe("new-worktree");
    expect(command.prepareWorktree?.branch).toBe("lecturn/fork");
    expect(() => decodeCommand({ ...fork, workspace: "somewhere-else" })).toThrow();
  });
});

describe("contextual option on thread creation", () => {
  it("accepts the contextual choice on launchThread and thread.create, bounded to 256 sources", () => {
    const launch = decodeLaunchInput({
      commandId: "cmd-launch-1",
      projectId: "project-1",
      title: "New thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      contextual: { enabled: true, sourceIds: ["source-1"] },
    });
    expect(launch.contextual).toEqual({ enabled: true, sourceIds: ["source-1"] });

    const create = decodeCommand({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: "cmd-create-1",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      contextual: { enabled: false, sourceIds: [] },
    });
    if (create.type !== "thread.create") throw new Error(`Unexpected ${create.type}`);
    expect(create.contextual?.enabled).toBe(false);

    expect(() =>
      decodeLaunchInput({
        commandId: "cmd-launch-2",
        projectId: "project-1",
        title: "New thread",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        contextual: {
          enabled: true,
          sourceIds: Array.from({ length: 257 }, (_, index) => `source-${index}`),
        },
      }),
    ).toThrow();
  });
});

describe("linked pull requests", () => {
  it("keeps the source-control host of non-GitHub pull requests", () => {
    const gitlab = decodeLinkedPullRequest({
      projectId: "project-1",
      repository: "team/repo",
      host: "gitlab.example.com",
      number: 42,
      url: "https://gitlab.example.com/team/repo/-/merge_requests/42",
    });
    expect(gitlab.host).toBe("gitlab.example.com");
    const github = decodeLinkedPullRequest({
      projectId: "project-1",
      repository: "nurozen/lecturn",
      number: 7,
      url: "https://github.com/nurozen/lecturn/pull/7",
    });
    expect(github.host).toBeUndefined();
  });
});

describe("checkpoint revert preview", () => {
  it("targets the same scope and checkpoint a rollback names", () => {
    expect(ORCHESTRATION_V2_WS_METHODS.previewCheckpointRevert).toBe(
      "orchestration.previewCheckpointRevert",
    );
    expect(ORCHESTRATION_REVERT_PREVIEW_MAX_PATHS).toBe(200);
    const input = decodePreviewInput({
      threadId: "thread-1",
      scopeId: "scope-1",
      checkpointId: "checkpoint-1",
    });
    expect(input.checkpointId).toBe("checkpoint-1");
    const result = decodePreviewResult({ removedPaths: ["notes.txt"], truncated: false });
    expect(result.removedPaths).toEqual(["notes.txt"]);
  });
});

describe("Stave projects", () => {
  it("decodes project shells from pre-Stave servers without stave or notice", () => {
    const decoded = decodeProjectShell(projectShell);
    expect(decoded.stave).toBeUndefined();
    expect(decoded.notice).toBeUndefined();
  });

  it("decodes Stave project info and drops unknown state and notice kinds", () => {
    const stave = {
      spaceId: "feature-x",
      isSaga: false,
      repos: [{ name: "lecturn", mode: "edit", path: "lecturn", base: "main" }],
      memories: [{ name: "notes", provider: "marmot", id: "mem-1", owned: true }],
      state: "live",
    };
    const live = decodeProjectShell({
      ...projectShell,
      stave,
      notice: { kind: "archive_scheduled", at: "2026-01-08T00:00:00.000Z" },
    });
    expect(live.stave?.state).toBe("live");
    expect(live.stave?.repos[0]?.mode).toBe("edit");
    expect(live.notice?.kind).toBe("archive_scheduled");

    const skewed = decodeProjectShell({
      ...projectShell,
      stave: { ...stave, state: "hibernated" },
      notice: { kind: "something_new", message: "from a newer server" },
    });
    expect(skewed.stave?.state).toBeUndefined();
    expect(skewed.stave?.spaceId).toBe("feature-x");
    expect(skewed.notice?.kind).toBeUndefined();
    expect(skewed.notice?.message).toBe("from a newer server");

    const nullified = decodeProjectShell({ ...projectShell, stave: null, notice: null });
    expect(nullified.stave).toBeNull();
    expect(nullified.notice).toBeNull();
  });

  it("carries saga teardown consent on project.delete and its event", () => {
    const staveSagaTeardown = {
      expectedSagaReview: "review-1",
      target: "archive",
      force: false,
      memory: "keep",
    };
    const mutation = decodeProjectMutation({
      type: "project.delete",
      commandId: "cmd-delete-1",
      projectId: "project-1",
      staveSagaRemoveConfirmed: true,
      staveSagaTeardown,
    });
    if (mutation.type !== "project.delete") throw new Error(`Unexpected ${mutation.type}`);
    expect(mutation.staveSagaTeardown?.target).toBe("archive");

    const deleted = decodeProjectEvent({
      ...projectEventBase,
      type: "project.deleted",
      payload: {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        staveSpaceId: "feature-x",
        staveCreatedAt: "2026-01-01T00:00:00.000Z",
        staveSagaRemoveConfirmed: true,
        staveSagaTeardown,
        deletedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    if (deleted.type !== "project.deleted") throw new Error(`Unexpected ${deleted.type}`);
    expect(deleted.payload.staveSpaceId).toBe("feature-x");

    const upstreamShaped = decodeProjectEvent({
      ...projectEventBase,
      type: "project.deleted",
      payload: { projectId: "project-1", deletedAt: "2026-01-02T00:00:00.000Z" },
    });
    if (upstreamShaped.type !== "project.deleted") throw new Error("Unexpected event");
    expect(upstreamShaped.payload.workspaceRoot).toBeUndefined();
  });

  it("decodes project.refreshed as a project event", () => {
    const refreshed = decodeProjectEvent({
      ...projectEventBase,
      type: "project.refreshed",
      payload: { projectId: "project-1" },
    });
    expect(refreshed.type).toBe("project.refreshed");
  });
});
