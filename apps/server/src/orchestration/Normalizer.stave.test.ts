import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type StaveProjectInfo,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as StaveAdmission from "../stave/StaveAdmission.ts";
import * as StaveWorkspaceReader from "../stave/StaveWorkspaceReader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { describeWorktreeIntent, normalizeDispatchCommand } from "./Normalizer.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const SPACE_ROOT = "/spaces/alpha";
const PLAIN_ROOT = "/projects/plain";
const spaceProjectId = ProjectId.make("project-space");
const plainProjectId = ProjectId.make("project-plain");
const spaceThreadId = ThreadId.make("thread-space");
const plainThreadId = ThreadId.make("thread-plain");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
const now = "2026-08-01T00:00:00.000Z";

const spaceInfo: StaveProjectInfo = {
  spaceId: "alpha",
  isSaga: false,
  repos: [],
  memories: [],
  state: "live",
};

const makeProjectShell = (id: ProjectId, workspaceRoot: string): OrchestrationProjectShell => ({
  id,
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const makeThreadShell = (id: ThreadId, projectId: ProjectId): OrchestrationThreadShell => ({
  id,
  projectId,
  title: "Thread",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const projects = new Map([
  [spaceProjectId, makeProjectShell(spaceProjectId, SPACE_ROOT)],
  [plainProjectId, makeProjectShell(plainProjectId, PLAIN_ROOT)],
]);
const threads = new Map([
  [spaceThreadId, makeThreadShell(spaceThreadId, spaceProjectId)],
  [plainThreadId, makeThreadShell(plainThreadId, plainProjectId)],
]);

/** Records every projection read so tests can assert the hook's cost. */
const makeTestLayer = (reads: string[]) =>
  Layer.mergeAll(
    WorkspacePaths.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-stave-" }),
    StaveAdmission.layer.pipe(
      Layer.provide(
        Layer.mock(StaveWorkspaceReader.StaveWorkspaceReader)({
          load: (root) =>
            Effect.sync(() => {
              reads.push(`manifest:${root}`);
              return root === SPACE_ROOT ? Option.some(spaceInfo) : Option.none();
            }),
        }),
      ),
    ),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getProjectShellById: (projectId) =>
        Effect.sync(() => {
          reads.push(`project:${projectId}`);
          return Option.fromNullishOr(projects.get(projectId));
        }),
      getThreadShellById: (threadId) =>
        Effect.sync(() => {
          reads.push(`thread:${threadId}`);
          return Option.fromNullishOr(threads.get(threadId));
        }),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const createThread = (
  projectId: ProjectId,
  worktreePath: string | null,
): ClientOrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make("cmd-create"),
  threadId: ThreadId.make("thread-new"),
  projectId,
  title: "New thread",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath,
  createdAt: now,
});

const metaUpdate = (
  threadId: ThreadId,
  fields: Partial<Extract<ClientOrchestrationCommand, { type: "thread.meta.update" }>>,
): ClientOrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.make("cmd-meta"),
  threadId,
  ...fields,
});

const turnStart = (
  threadId: ThreadId,
  bootstrap?: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>["bootstrap"],
): ClientOrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-turn"),
  threadId,
  message: {
    messageId: MessageId.make("message-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: now,
  ...(bootstrap ? { bootstrap } : {}),
});

const expectRefused = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(normalizeDispatchCommand(command));
    expect(error._tag).toBe("OrchestrationDispatchCommandError");
    expect(error.message).toBe(StaveAdmission.STAVE_WORKTREE_FORBIDDEN_MESSAGE);
    expect(StaveAdmission.isStaveAdmissionError(error.cause)).toBe(true);
  });

describe("normalizeDispatchCommand Stave worktree rule", () => {
  it.effect("refuses thread.create with a worktreePath under a Stave project", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      yield* expectRefused(createThread(spaceProjectId, "/wt/alpha"));
      expect(reads).toEqual([`project:${spaceProjectId}`, `manifest:${SPACE_ROOT}`]);
    }).pipe(Effect.provide(makeTestLayer(reads)));
  });

  it.effect("passes thread.create in the space root without reading the projection", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(createThread(spaceProjectId, null));
      expect(normalized.type).toBe("thread.create");
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(reads)));
  });

  it.effect("passes thread.create with a worktreePath for a non-Stave project", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(createThread(plainProjectId, "/wt/plain"));
      expect(normalized.type === "thread.create" && normalized.worktreePath).toBe("/wt/plain");
      expect(reads).toEqual([`project:${plainProjectId}`, `manifest:${PLAIN_ROOT}`]);
    }).pipe(Effect.provide(makeTestLayer(reads)));
  });

  it.effect("resolves thread.meta.update through the thread's project", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      yield* expectRefused(metaUpdate(spaceThreadId, { worktreePath: "/wt/alpha" }));
      expect(reads).toEqual([
        `thread:${spaceThreadId}`,
        `project:${spaceProjectId}`,
        `manifest:${SPACE_ROOT}`,
      ]);
      yield* normalizeDispatchCommand(metaUpdate(plainThreadId, { worktreePath: "/wt/plain" }));
      // Clearing the worktree or touching other fields never consults Stave.
      reads.length = 0;
      yield* normalizeDispatchCommand(metaUpdate(spaceThreadId, { worktreePath: null }));
      yield* normalizeDispatchCommand(metaUpdate(spaceThreadId, { title: "Renamed" }));
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(reads)));
  });

  it.effect("refuses a bootstrap turn start that prepares a worktree in a Stave project", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      yield* expectRefused(
        turnStart(ThreadId.make("thread-bootstrap"), {
          createThread: {
            projectId: spaceProjectId,
            title: "Bootstrapped",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          prepareWorktree: { projectCwd: SPACE_ROOT, baseBranch: "main" },
        }),
      );
      expect(reads).toEqual([`project:${spaceProjectId}`, `manifest:${SPACE_ROOT}`]);
    }).pipe(Effect.provide(makeTestLayer(reads)));
  });

  it.effect("refuses a bootstrap turn start whose created thread names a worktree", () =>
    expectRefused(
      turnStart(ThreadId.make("thread-bootstrap"), {
        createThread: {
          projectId: spaceProjectId,
          title: "Bootstrapped",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/wt/alpha",
          createdAt: now,
        },
      }),
    ).pipe(Effect.provide(makeTestLayer([]))),
  );

  it.effect("falls back to prepareWorktree.projectCwd when the thread is unknown", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      yield* expectRefused(
        turnStart(ThreadId.make("thread-unknown"), {
          prepareWorktree: { projectCwd: SPACE_ROOT, baseBranch: "main" },
        }),
      );
      expect(reads).toEqual([`thread:thread-unknown`, `manifest:${SPACE_ROOT}`]);
    }).pipe(Effect.provide(makeTestLayer(reads)));
  });

  it.effect("leaves a plain turn start alone", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(turnStart(spaceThreadId));
      expect(normalized.type).toBe("thread.turn.start");
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(reads)));
  });

  it("describeWorktreeIntent ignores commands that never bind a worktree", () => {
    expect(describeWorktreeIntent(createThread(spaceProjectId, null))).toBeNull();
    expect(describeWorktreeIntent(metaUpdate(spaceThreadId, { title: "x" }))).toBeNull();
    expect(describeWorktreeIntent(turnStart(spaceThreadId))).toBeNull();
    expect(
      describeWorktreeIntent({
        type: "thread.archive",
        commandId: CommandId.make("cmd-archive"),
        threadId: spaceThreadId,
      }),
    ).toBeNull();
  });
});
