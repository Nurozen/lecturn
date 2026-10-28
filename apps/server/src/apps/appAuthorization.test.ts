import {
  APPS_WS_METHODS as A,
  AppId,
  AppsError,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS as O,
  ProjectId,
  ThreadId,
  ThreadNoteId,
  WS_METHODS as W,
  type AppBinding,
} from "@lecturn/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@lecturn/shared/testing/symlinks";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../assets/AttachmentUpload.ts";
import {
  createAttachmentId,
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  type AppAuthorizationDeps,
  EMBED_TOKEN_SCOPES,
  canonicalPathOnDisk,
  makeWith,
} from "./appAuthorization.ts";
import * as AppsRpcHandlers from "./AppsRpcHandlers.ts";
import {
  AppAuthorization,
  AppHostContextStore,
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  HeadlessToolHost,
  ThreadCopyService,
} from "./services.ts";
import { type AppSubject, formatAppSubject, formatEmbedSubject } from "./subjects.ts";

const rocketwright = AppId.make("dev.rocketwright.app");
const otherApp = AppId.make("dev.other.app");
const rocketProject = ProjectId.make("rocket-project");
const rocketSecondProject = ProjectId.make("rocket-second-project");
const otherAppProject = ProjectId.make("other-app-project");
const normalProject = ProjectId.make("normal-project");
const rocketThread = ThreadId.make("rocket-thread");
const rocketSecondThread = ThreadId.make("rocket-second-thread");
const otherAppThread = ThreadId.make("other-app-thread");
const normalThread = ThreadId.make("normal-thread");
const missingThread = ThreadId.make("missing-thread");
/** An imported copy: its id is not an attachment segment, so its attachments name it lossily. */
const rocketCopyThread = ThreadId.make("copy:environment:sidecar:rocket-thread");
const normalCopyThread = ThreadId.make("copy:environment:other:normal-thread");

const binding = (appId: AppId, root: string): AppBinding => ({
  appId,
  workspaceRoot: root,
});

const bindings = new Map<ProjectId, AppBinding>([
  [rocketProject, binding(rocketwright, "/work/rocket")],
  [rocketSecondProject, binding(rocketwright, "/work/rocket-2")],
  [otherAppProject, binding(otherApp, "/work/other")],
]);

const threadProjects = new Map<ThreadId, ProjectId>([
  [rocketThread, rocketProject],
  [rocketSecondThread, rocketSecondProject],
  [otherAppThread, otherAppProject],
  [normalThread, normalProject],
  [rocketCopyThread, rocketProject],
  [normalCopyThread, normalProject],
]);

const rocketNote = ThreadNoteId.make("rocket-note");
const otherAppNote = ThreadNoteId.make("other-app-note");
const normalNote = ThreadNoteId.make("normal-note");
const missingNote = ThreadNoteId.make("missing-note");

const noteProjects = new Map<ThreadNoteId, ProjectId>([
  [rocketNote, rocketProject],
  [otherAppNote, otherAppProject],
  [normalNote, normalProject],
]);

const issued: Array<{ subject: string; ttl: Duration.Duration; label: string }> = [];

const fakeDeps: AppAuthorizationDeps = {
  resolveAppForProject: (projectId) =>
    Effect.succeed(Option.fromUndefinedOr(bindings.get(projectId))),
  // These apps sent resolved roots, so each project lives where its binding says.
  workspaceRootForProject: (projectId) =>
    Effect.succeed(
      Option.map(Option.fromUndefinedOr(bindings.get(projectId)), (b) => b.workspaceRoot),
    ),
  projectIdForThread: (threadId) =>
    Effect.succeed(Option.fromUndefinedOr(threadProjects.get(threadId))),
  threadIdForAttachment: (attachmentId) => {
    const segment = parseThreadSegmentFromAttachmentId(attachmentId);
    return Effect.succeed(
      Option.fromUndefinedOr(
        [...threadProjects.keys()].find(
          (threadId) => segment !== null && toSafeThreadAttachmentSegment(threadId) === segment,
        ),
      ),
    );
  },
  projectIdForNote: (noteId) => Effect.succeed(Option.fromUndefinedOr(noteProjects.get(noteId))),
  worktreePathForThread: () => Effect.succeedNone,
  // A disk with no links, where every path exists; the real one is tested on disk below.
  canonicalPath: (target, from) =>
    Effect.succeedSome(from === undefined || target.startsWith("/") ? target : `${from}/${target}`),
  issueEmbedSession: (input) =>
    Effect.sync(() => {
      issued.push(input);
      return {
        token: "embed-token",
        expiresAt: DateTime.makeUnsafe("2026-10-25T00:15:00.000Z"),
      };
    }),
  environmentId: Effect.succeed(EnvironmentId.make("env-1")),
  embedOrigin: "http://127.0.0.1:3773",
};

const authorization = makeWith(fakeDeps);

const session = (subject: string): AuthenticatedSession => ({
  sessionId: AuthSessionId.make("session-1"),
  subject,
  method: "bearer-access-token",
  scopes: [AuthOrchestrationReadScope],
});

const appSession = session(formatAppSubject(rocketwright));
const embedSession = session(formatEmbedSubject(rocketwright, rocketProject));

const allowed = (subject: AuthenticatedSession, method: string, payload: unknown) =>
  authorization
    .authorizeRpc(subject, method, payload)
    .pipe(
      Effect.as(true),
      Effect.catchTags({ EnvironmentAuthorizationError: () => Effect.succeed(false) }),
    );

const command = (fields: Record<string, unknown>) => ({ commandId: "command-1", ...fields });

describe("app RPC allowlist", () => {
  it.effect("lets the app credential reach only its own projects and threads", () =>
    Effect.gen(function* () {
      expect(yield* allowed(appSession, A.appsListThreads, { projectId: rocketProject })).toBe(
        true,
      );
      expect(yield* allowed(appSession, A.appsListThreads, { projectId: otherAppProject })).toBe(
        false,
      );
      expect(yield* allowed(appSession, A.appsListThreads, { projectId: normalProject })).toBe(
        false,
      );
      expect(
        yield* allowed(appSession, A.appsSetThreadAppData, {
          threadId: rocketThread,
          appData: null,
        }),
      ).toBe(true);
      expect(
        yield* allowed(appSession, A.appsSetThreadAppData, {
          threadId: normalThread,
          appData: null,
        }),
      ).toBe(false);
      expect(
        yield* allowed(appSession, A.appsUpdateHostContext, {
          target: { threadId: otherAppThread },
          text: "",
        }),
      ).toBe(false);
      expect(
        yield* allowed(appSession, A.appsMarkThreadsCopied, {
          entries: [{ threadId: rocketThread }, { threadId: otherAppThread }],
        }),
      ).toBe(false);
      expect(yield* allowed(appSession, A.appsExportThreads, {})).toBe(true);
      expect(yield* allowed(appSession, A.appsEnsureWorkspace, { workspaceRoot: "/x" })).toBe(true);
    }),
  );

  it.effect("denies the app credential every method that is not an app method", () =>
    Effect.gen(function* () {
      for (const [method, payload] of [
        [O.subscribeThread, { threadId: rocketThread }],
        [O.subscribeShell, {}],
        [A.appsCreateEmbedThread, { projectId: rocketProject }],
        [A.appsList, {}],
        [W.projectsWriteFile, { cwd: "/work/rocket" }],
        [W.serverProbe, {}],
      ] as const) {
        expect(yield* allowed(appSession, method, payload)).toBe(false);
      }
    }),
  );

  it.effect("keeps an embed token on its own project", () =>
    Effect.gen(function* () {
      expect(yield* allowed(embedSession, O.subscribeThread, { threadId: rocketThread })).toBe(
        true,
      );
      // Same app, but not the project the token was minted for.
      expect(
        yield* allowed(embedSession, O.subscribeThread, { threadId: rocketSecondThread }),
      ).toBe(false);
      expect(yield* allowed(embedSession, O.getTurnDiff, { threadId: otherAppThread })).toBe(false);
      expect(yield* allowed(embedSession, O.getThreadProjection, { threadId: normalThread })).toBe(
        false,
      );
      expect(yield* allowed(embedSession, O.searchThread, { threadId: missingThread })).toBe(false);
      expect(
        yield* allowed(embedSession, A.appsCreateEmbedThread, { projectId: rocketProject }),
      ).toBe(true);
      expect(
        yield* allowed(embedSession, A.appsCreateEmbedThread, { projectId: rocketSecondProject }),
      ).toBe(false);
      const setDefault = (subject: AuthenticatedSession, projectId: ProjectId) =>
        allowed(subject, A.appsSetEmbedDefaultModel, { projectId, modelSelection: null });
      expect(yield* setDefault(embedSession, rocketProject)).toBe(true);
      expect(yield* setDefault(embedSession, rocketSecondProject)).toBe(false);
      expect(yield* setDefault(embedSession, normalProject)).toBe(false);
      expect(yield* setDefault(appSession, rocketProject)).toBe(false);
      // The providers panel reads status from the config stream and may ask for a recheck.
      expect(yield* allowed(embedSession, W.serverRefreshProviders, {})).toBe(true);
      expect(yield* allowed(embedSession, W.providerInstallSubscribe, {})).toBe(true);
      expect(yield* allowed(embedSession, W.providerAuthStart, {})).toBe(false);
      expect(yield* allowed(embedSession, W.providerInstallStart, {})).toBe(false);
      expect(yield* allowed(embedSession, W.serverUpdateSettings, { patch: {} })).toBe(false);
      expect(yield* allowed(embedSession, W.serverGetConfig, {})).toBe(true);
      expect(yield* allowed(embedSession, W.subscribeServerConfig, {})).toBe(true);
      expect(yield* allowed(embedSession, W.serverProbe, {})).toBe(true);
      const card = { itemId: "item-1", uri: "ui://ex/counter-card" };
      expect(
        yield* allowed(embedSession, W.mcpAppsReadResource, { ...card, threadId: rocketThread }),
      ).toBe(true);
      expect(
        yield* allowed(embedSession, W.mcpAppsReadResource, { ...card, threadId: normalThread }),
      ).toBe(false);
      expect(yield* allowed(embedSession, A.appsMintEmbedToken, { projectId: rocketProject })).toBe(
        false,
      );
      expect(yield* allowed(embedSession, W.terminalOpen, {})).toBe(false);
    }),
  );

  it.effect("lets an embed operate threads but never create one or touch projects", () =>
    Effect.gen(function* () {
      const dispatch = (fields: Record<string, unknown>) =>
        allowed(embedSession, O.dispatchCommand, command(fields));
      const message = { type: "message.dispatch", dispatchMode: { type: "start_immediately" } };
      expect(yield* dispatch({ ...message, threadId: rocketThread })).toBe(true);
      expect(yield* dispatch({ ...message, threadId: normalThread })).toBe(false);
      expect(yield* dispatch({ type: "runtime-request.respond", threadId: rocketThread })).toBe(
        true,
      );
      expect(yield* dispatch({ type: "run.interrupt", threadId: rocketThread })).toBe(true);
      expect(yield* dispatch({ type: "thread.create", threadId: rocketThread })).toBe(false);
      expect(yield* dispatch({ type: "thread.delete", threadId: rocketThread })).toBe(false);
      expect(
        yield* dispatch({ type: "thread.metadata.update", threadId: rocketThread, title: "Fins" }),
      ).toBe(true);
      expect(
        yield* dispatch({
          type: "thread.metadata.update",
          threadId: rocketThread,
          worktreePath: "/elsewhere",
        }),
      ).toBe(false);
      expect(
        yield* allowed(embedSession, W.projectsMutate, {
          type: "project.delete",
          projectId: rocketProject,
        }),
      ).toBe(false);

      const launch = (fields: Record<string, unknown>) =>
        allowed(embedSession, O.launchThread, {
          projectId: rocketProject,
          workspaceStrategy: { type: "root" },
          ...fields,
        });
      expect(yield* launch({ threadId: rocketThread, reuseExistingThread: true })).toBe(true);
      expect(yield* launch({ threadId: missingThread, reuseExistingThread: true })).toBe(false);
      expect(yield* launch({ threadId: rocketThread })).toBe(false);
      expect(yield* launch({})).toBe(false);
    }),
  );

  it.effect("keeps an embed's threads on their project's own workspace", () =>
    Effect.gen(function* () {
      const elsewhere = { type: "existing_worktree", worktreePath: "/work/other" };
      const newWorktree = { type: "worktree", baseRef: "main" };
      const onBranch = { type: "root", branch: "feature" };

      const launch = (workspaceStrategy: Record<string, unknown>) =>
        allowed(embedSession, O.launchThread, {
          projectId: rocketProject,
          threadId: rocketThread,
          reuseExistingThread: true,
          workspaceStrategy,
        });
      expect(yield* launch({ type: "root" })).toBe(true);
      expect(yield* launch(elsewhere)).toBe(false);
      expect(yield* launch(newWorktree)).toBe(false);
      expect(yield* launch(onBranch)).toBe(false);

      const send = (dispatchMode: Record<string, unknown>) =>
        allowed(
          embedSession,
          O.dispatchCommand,
          command({
            type: "message.dispatch",
            threadId: rocketThread,
            attachments: [],
            dispatchMode,
          }),
        );
      expect(yield* send({ type: "start_immediately" })).toBe(true);
      expect(yield* send({ type: "defer_start" })).toBe(true);
      expect(yield* send({ type: "defer_start", workspaceStrategy: { type: "root" } })).toBe(true);
      expect(yield* send({ type: "defer_start", workspaceStrategy: elsewhere })).toBe(false);
      expect(yield* send({ type: "defer_start", workspaceStrategy: newWorktree })).toBe(false);
      expect(yield* send({ type: "defer_start", workspaceStrategy: onBranch })).toBe(false);
    }),
  );

  it.effect("checks a launch's initial attachments as it checks a dispatch's", () =>
    Effect.gen(function* () {
      const attachment = (id: string) => ({
        type: "file",
        id,
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      });
      const launch = (id: string) =>
        allowed(embedSession, O.launchThread, {
          projectId: rocketProject,
          threadId: rocketThread,
          reuseExistingThread: true,
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Read this", attachments: [attachment(id)] },
        });
      const stored = (threadId: ThreadId) => createAttachmentId(threadId, "pdf") ?? "unparseable";
      expect(yield* launch(createPendingAttachmentId(".pdf"))).toBe(true);
      expect(yield* launch(stored(rocketThread))).toBe(true);
      expect(yield* launch(stored(rocketSecondThread))).toBe(false);
      expect(yield* launch(stored(otherAppThread))).toBe(false);
      expect(yield* launch(stored(normalThread))).toBe(false);
    }),
  );

  it.effect("serves an embed asset URLs for its own threads and project files only", () =>
    Effect.gen(function* () {
      const asset = (resource: Record<string, unknown>) =>
        allowed(embedSession, W.assetsCreateUrl, { resource });
      const attachment = (threadId: ThreadId) =>
        asset({ _tag: "attachment", attachmentId: createAttachmentId(threadId, "html") });
      expect(yield* attachment(rocketThread)).toBe(true);
      expect(yield* attachment(rocketSecondThread)).toBe(false);
      expect(yield* attachment(otherAppThread)).toBe(false);
      expect(yield* attachment(normalThread)).toBe(false);
      expect(yield* attachment(rocketCopyThread)).toBe(true);
      expect(yield* attachment(normalCopyThread)).toBe(false);
      expect(
        yield* asset({ _tag: "attachment", attachmentId: createPendingAttachmentId(".png") }),
      ).toBe(false);
      expect(yield* asset({ _tag: "attachment", attachmentId: "rocket-thread" })).toBe(false);

      const image = (threadId: ThreadId) =>
        asset({ _tag: "tool-output-image", threadId, itemId: "item-1", index: 0 });
      expect(yield* image(rocketThread)).toBe(true);
      expect(yield* image(otherAppThread)).toBe(false);
      expect(yield* image(normalThread)).toBe(false);

      const media = (threadId: ThreadId, path: string) =>
        asset({ _tag: "media-file", threadId, path });
      expect(yield* media(rocketThread, "/work/rocket/plots/apogee.png")).toBe(true);
      expect(yield* media(rocketThread, "plots/apogee.png")).toBe(true);
      expect(yield* media(rocketThread, "/work/rocket-2/apogee.png")).toBe(false);
      expect(yield* media(rocketThread, "/work/other/apogee.png")).toBe(false);
      expect(yield* media(rocketThread, "/work/rocket/../other/apogee.png")).toBe(false);
      expect(yield* media(rocketThread, "../other/apogee.png")).toBe(false);
      expect(yield* media(rocketThread, "~/apogee.png")).toBe(false);
      expect(yield* media(otherAppThread, "plots/apogee.png")).toBe(false);
      expect(yield* media(normalThread, "plots/apogee.png")).toBe(false);

      const draft = (cwd: string, path: string) =>
        asset({ _tag: "draft-workspace-file", cwd, path });
      expect(yield* draft("/work/rocket", "plots/apogee.png")).toBe(true);
      expect(yield* draft("/work/rocket", "/etc/hosts")).toBe(false);
      expect(yield* draft("/work/other", "plots/apogee.png")).toBe(false);

      const favicon = (cwd: string) => asset({ _tag: "project-favicon", cwd });
      expect(yield* favicon("/work/rocket")).toBe(true);
      expect(yield* favicon("/work/other")).toBe(false);
      expect(yield* favicon("/work/normal")).toBe(false);

      expect(yield* asset({ _tag: "native-app-icon", app: { _tag: "app-id", appId: "x" } })).toBe(
        true,
      );
      expect(
        yield* asset({ _tag: "github-media", cwd: "/work/rocket", url: "https://github.com/x" }),
      ).toBe(false);
      expect(
        yield* allowed(appSession, W.assetsCreateUrl, {
          resource: { _tag: "tool-output-image", threadId: rocketThread, itemId: "i", index: 0 },
        }),
      ).toBe(false);
    }),
  );

  it.effect("gives the embed chat view its project's status, notes and Contextual reads", () =>
    Effect.gen(function* () {
      expect(yield* allowed(embedSession, W.subscribeServerLifecycle, {})).toBe(true);
      expect(yield* allowed(appSession, W.subscribeServerLifecycle, {})).toBe(false);

      const vcs = (cwd: string) => allowed(embedSession, W.subscribeVcsStatus, { cwd });
      expect(yield* vcs("/work/rocket")).toBe(true);
      expect(yield* vcs("/work/rocket-2")).toBe(false);
      expect(yield* vcs("/work/other")).toBe(false);
      expect(yield* vcs("/work/normal")).toBe(false);

      const notes = (input: Record<string, unknown>) =>
        allowed(embedSession, W.threadNotesList, input);
      expect(yield* notes({ projectId: rocketProject })).toBe(true);
      expect(yield* notes({ projectId: otherAppProject })).toBe(false);
      expect(yield* notes({ projectId: normalProject })).toBe(false);
      expect(yield* notes({})).toBe(false);

      for (const method of [
        W.contextualStatus,
        W.contextualDisclosures,
        W.contextualConflicts,
      ] as const) {
        expect(yield* allowed(embedSession, method, { threadId: rocketThread })).toBe(true);
        expect(yield* allowed(embedSession, method, { threadId: otherAppThread })).toBe(false);
        expect(yield* allowed(embedSession, method, { threadId: normalThread })).toBe(false);
        expect(yield* allowed(appSession, method, { threadId: rocketThread })).toBe(false);
      }
      for (const [method, payload] of [
        [W.contextualUpdateThreadSettings, { threadId: rocketThread }],
        [W.contextualRefresh, { threadId: rocketThread }],
        [W.contextualExclude, { threadId: rocketThread }],
        [W.contextualProjectSettings, { projectId: rocketProject }],
        [W.contextualSubscribe, { afterSequence: 0, threadId: rocketThread }],
        [W.contextualSources, {}],
      ] as const) {
        expect(yield* allowed(embedSession, method, payload)).toBe(false);
      }
    }),
  );

  it.effect("lets an embed keep notes on its own threads only", () =>
    Effect.gen(function* () {
      const create = (threadId: ThreadId) =>
        allowed(embedSession, W.threadNotesCreate, { id: "new-note", threadId });
      expect(yield* create(rocketThread)).toBe(true);
      expect(yield* create(rocketSecondThread)).toBe(false);
      expect(yield* create(otherAppThread)).toBe(false);
      expect(yield* create(normalThread)).toBe(false);
      expect(yield* create(missingThread)).toBe(false);

      for (const method of [W.threadNotesUpdate, W.threadNotesDelete] as const) {
        const note = (id: ThreadNoteId) => allowed(embedSession, method, { id, comment: null });
        expect(yield* note(rocketNote)).toBe(true);
        expect(yield* note(otherAppNote)).toBe(false);
        expect(yield* note(normalNote)).toBe(false);
        expect(yield* note(missingNote)).toBe(false);
        expect(yield* allowed(appSession, method, { id: rocketNote, comment: null })).toBe(false);
      }
      expect(yield* allowed(appSession, W.threadNotesCreate, { threadId: rocketThread })).toBe(
        false,
      );
    }),
  );

  it.effect("lets an embed upload attachments that only its own threads can claim", () =>
    Effect.gen(function* () {
      const upload = { name: "plot.png", mimeType: "image/png", sizeBytes: 10 };
      const stored = (threadId: ThreadId) => createAttachmentId(threadId, "png") ?? "unparseable";
      expect(yield* allowed(embedSession, W.attachmentsCreateUploadUrl, upload)).toBe(true);
      expect(yield* allowed(appSession, W.attachmentsCreateUploadUrl, upload)).toBe(false);

      const remove = (attachmentId: string) =>
        allowed(embedSession, W.attachmentsDelete, { attachmentId });
      expect(yield* remove(createPendingAttachmentId(".png"))).toBe(true);
      expect(yield* remove(stored(rocketThread))).toBe(false);
      expect(yield* remove(stored(normalThread))).toBe(false);
      expect(
        yield* allowed(appSession, W.attachmentsDelete, {
          attachmentId: createPendingAttachmentId(".png"),
        }),
      ).toBe(false);

      const attachment = (id: string) => ({
        type: "image",
        id,
        name: "plot.png",
        mimeType: "image/png",
        sizeBytes: 10,
      });
      const send = (fields: Record<string, unknown>) =>
        allowed(
          embedSession,
          O.dispatchCommand,
          command({
            type: "message.dispatch",
            threadId: rocketThread,
            dispatchMode: { type: "start_immediately" },
            ...fields,
          }),
        );
      expect(yield* send({ attachments: [attachment(createPendingAttachmentId(".png"))] })).toBe(
        true,
      );
      expect(yield* send({ attachments: [attachment(stored(rocketThread))] })).toBe(true);
      expect(yield* send({ attachments: [attachment(stored(normalThread))] })).toBe(false);
      expect(yield* send({ attachments: [attachment(stored(otherAppThread))] })).toBe(false);
      expect(yield* send({ senderThreadId: normalThread })).toBe(false);
      expect(yield* send({ sourcePlanRef: { threadId: otherAppThread, planId: "plan-1" } })).toBe(
        false,
      );
      expect(yield* send({ sourcePlanRef: { threadId: rocketThread, planId: "plan-1" } })).toBe(
        true,
      );

      const edit = (id: string) =>
        allowed(
          embedSession,
          O.dispatchCommand,
          command({
            type: "queued-run.edit",
            threadId: rocketThread,
            runId: "run-1",
            text: "",
            attachments: [attachment(id)],
          }),
        );
      expect(yield* edit(stored(rocketThread))).toBe(true);
      expect(yield* edit(stored(normalThread))).toBe(false);

      const respond = (id: string) =>
        allowed(
          embedSession,
          O.dispatchCommand,
          command({
            type: "runtime-request.respond",
            threadId: rocketThread,
            requestId: "request-1",
            attachmentsByQuestionId: { q1: [attachment(id)] },
          }),
        );
      expect(yield* respond(createPendingAttachmentId(".png"))).toBe(true);
      expect(yield* respond(stored(otherAppThread))).toBe(false);
    }),
  );

  it.effect("lets an embed mark its threads read and resume their queues", () =>
    Effect.gen(function* () {
      for (const type of [
        "thread.visit",
        "thread.mark-unread",
        "queue.resume",
        "thread.user-input.dismiss",
      ]) {
        const dispatch = (threadId: ThreadId) =>
          allowed(embedSession, O.dispatchCommand, command({ type, threadId }));
        expect(yield* dispatch(rocketThread)).toBe(true);
        expect(yield* dispatch(otherAppThread)).toBe(false);
        expect(yield* dispatch(normalThread)).toBe(false);
      }
    }),
  );

  it.effect("names a refused command's type", () =>
    Effect.gen(function* () {
      const error = yield* authorization
        .authorizeRpc(
          embedSession,
          O.dispatchCommand,
          command({ type: "thread.archive", threadId: rocketThread }),
        )
        .pipe(Effect.flip);
      expect(error.message).toBe(
        `This connected app cannot call ${O.dispatchCommand} (thread.archive) here.`,
      );
    }),
  );

  it.effect("limits embed file search to the project root", () =>
    Effect.gen(function* () {
      const search = (cwd: string) =>
        allowed(embedSession, W.projectsSearchEntries, { cwd, query: "", limit: 10 });
      expect(yield* search("/work/rocket")).toBe(true);
      expect(yield* search("/work/rocket/")).toBe(true);
      expect(yield* search("/work/rocket-2")).toBe(false);
      expect(yield* search("/")).toBe(false);
    }),
  );

  it.effect(
    "checks an embed's paths against its project's resolved root, not the app's spelling",
    () =>
      Effect.gen(function* () {
        // ensureWorkspace keeps `/work/./rocket` as the app's identity; the project lives at `/work/rocket`.
        const spelled = makeWith({
          ...fakeDeps,
          resolveAppForProject: (projectId) =>
            Effect.succeed(
              projectId === rocketProject
                ? Option.some(binding(rocketwright, "/work/./rocket"))
                : Option.none(),
            ),
        });
        const allowedHere = (method: string, payload: unknown) =>
          spelled
            .authorizeRpc(embedSession, method, payload)
            .pipe(
              Effect.as(true),
              Effect.catchTags({ EnvironmentAuthorizationError: () => Effect.succeed(false) }),
            );
        const asset = (resource: Record<string, unknown>) =>
          allowedHere(W.assetsCreateUrl, { resource });
        expect(
          yield* allowedHere(W.projectsSearchEntries, {
            cwd: "/work/rocket",
            query: "",
            limit: 10,
          }),
        ).toBe(true);
        expect(yield* allowedHere(W.subscribeVcsStatus, { cwd: "/work/rocket" })).toBe(true);
        expect(yield* asset({ _tag: "project-favicon", cwd: "/work/rocket" })).toBe(true);
        expect(
          yield* asset({ _tag: "draft-workspace-file", cwd: "/work/rocket", path: "plots/a.png" }),
        ).toBe(true);
        expect(
          yield* asset({
            _tag: "media-file",
            threadId: rocketThread,
            path: "/work/rocket/plots/a.png",
          }),
        ).toBe(true);
        expect(
          yield* allowedHere(W.projectsSearchEntries, {
            cwd: "/work/rocket-2",
            query: "",
            limit: 10,
          }),
        ).toBe(false);
      }),
  );

  it.effect("denies a call whose project lookup fails", () =>
    Effect.gen(function* () {
      const failing = makeWith({
        ...fakeDeps,
        resolveAppForProject: () =>
          Effect.fail(new AppsError({ code: "unavailable", message: "lookup failed" })),
      });
      const error = yield* failing
        .authorizeRpc(embedSession, O.subscribeThread, { threadId: rocketThread })
        .pipe(Effect.flip);
      expect(error._tag).toBe("EnvironmentAuthorizationError");
    }),
  );

  it.effect("passes ordinary sessions without consulting any lookup", () =>
    Effect.gen(function* () {
      const untouched = makeWith({
        ...fakeDeps,
        resolveAppForProject: () => Effect.die("looked up"),
        projectIdForThread: () => Effect.die("looked up"),
      });
      yield* untouched.authorizeRpc(session("owner"), W.projectsWriteFile, {});
      yield* untouched.authorizeHttp(session("owner"), "/api/projects/mutate");
    }),
  );
});

describe("embed media paths on disk", () => {
  const diskProject = ProjectId.make("disk-project");
  const diskThread = ThreadId.make("disk-thread");
  const diskWorktreeThread = ThreadId.make("disk-worktree-thread");

  /** A workspace whose links point out of it, and a worktree thread beside it. */
  const plant = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-embed-root-" });
    const worktree = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-embed-worktree-" });
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-embed-outside-" });
    yield* fs.makeDirectory(path.join(root, "plots"));
    yield* fs.writeFileString(path.join(root, "plots", "apogee.png"), "plot");
    yield* fs.writeFileString(path.join(worktree, "drag.png"), "plot");
    yield* fs.writeFileString(path.join(outside, "private.pdf"), "private");
    yield* fs.symlink(path.join(outside, "private.pdf"), path.join(root, "link.pdf"));
    yield* fs.symlink(outside, path.join(root, "linked"));
    yield* fs.symlink(path.join(outside, "private.pdf"), path.join(worktree, "link.pdf"));
    yield* fs.symlink(path.join(root, "missing.pdf"), path.join(root, "dangling.pdf"));
    const onDisk = makeWith({
      ...fakeDeps,
      resolveAppForProject: (projectId) =>
        Effect.succeed(
          projectId === diskProject ? Option.some(binding(rocketwright, root)) : Option.none(),
        ),
      projectIdForThread: (threadId) =>
        Effect.succeed(
          threadId === diskThread || threadId === diskWorktreeThread
            ? Option.some(diskProject)
            : Option.none(),
        ),
      workspaceRootForProject: (projectId) =>
        Effect.succeed(projectId === diskProject ? Option.some(root) : Option.none()),
      worktreePathForThread: (threadId) =>
        Effect.succeed(threadId === diskWorktreeThread ? Option.some(worktree) : Option.none()),
      canonicalPath: yield* canonicalPathOnDisk,
    });
    const asset = (resource: Record<string, unknown>) =>
      onDisk
        .authorizeRpc(session(formatEmbedSubject(rocketwright, diskProject)), W.assetsCreateUrl, {
          resource,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTags({ EnvironmentAuthorizationError: () => Effect.succeed(false) }),
        );
    return { root, worktree, asset, join: path.join };
  });

  it.effect.skipIf(!symlinksSupported)(
    "refuses project paths whose links lead outside the workspace they are read from",
    () =>
      Effect.gen(function* () {
        const { root, worktree, asset, join } = yield* plant;
        const media = (threadId: ThreadId, path: string) =>
          asset({ _tag: "media-file", threadId, path });
        expect(yield* media(diskThread, join(root, "plots", "apogee.png"))).toBe(true);
        expect(yield* media(diskThread, "plots/apogee.png")).toBe(true);
        expect(yield* media(diskThread, join(root, "link.pdf"))).toBe(false);
        expect(yield* media(diskThread, "link.pdf")).toBe(false);
        expect(yield* media(diskThread, join(root, "linked", "private.pdf"))).toBe(false);
        expect(yield* media(diskThread, "linked/private.pdf")).toBe(false);
        // A path that cannot be resolved cannot be shown to stay inside.
        expect(yield* media(diskThread, "dangling.pdf")).toBe(false);
        expect(yield* media(diskThread, "plots/missing.png")).toBe(false);

        // A worktree thread reads relative paths from its worktree, never through its links.
        expect(yield* media(diskWorktreeThread, "drag.png")).toBe(true);
        expect(yield* media(diskWorktreeThread, "link.pdf")).toBe(false);
        expect(yield* media(diskWorktreeThread, join(worktree, "drag.png"))).toBe(false);

        const draft = (path: string) => asset({ _tag: "draft-workspace-file", cwd: root, path });
        expect(yield* draft("plots/apogee.png")).toBe(true);
        expect(yield* draft(join(root, "plots", "apogee.png"))).toBe(true);
        expect(yield* draft(join(root, "link.pdf"))).toBe(false);
        expect(yield* draft(join(root, "linked", "private.pdf"))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("app HTTP authorization", () => {
  const httpAllowed = (subject: AuthenticatedSession, path: string) =>
    authorization
      .authorizeHttp(subject, path)
      .pipe(
        Effect.as(true),
        Effect.catchTags({ EnvironmentAuthorizationError: () => Effect.succeed(false) }),
      );

  it.effect("serves an embed only its own threads and the filtered lists", () =>
    Effect.gen(function* () {
      expect(yield* httpAllowed(embedSession, `/api/orchestration/threads/${rocketThread}`)).toBe(
        true,
      );
      expect(
        yield* httpAllowed(embedSession, `/api/orchestration/threads/${rocketThread}/history`),
      ).toBe(true);
      expect(
        yield* httpAllowed(embedSession, `/api/orchestration/threads/${normalThread}/transcript`),
      ).toBe(false);
      expect(yield* httpAllowed(embedSession, "/api/orchestration/shell")).toBe(true);
      expect(yield* httpAllowed(embedSession, "/api/projects")).toBe(true);
      expect(yield* httpAllowed(embedSession, "/api/projects/mutate")).toBe(false);
      expect(yield* httpAllowed(embedSession, "/api/auth/clients")).toBe(false);
    }),
  );

  it.effect("lets an embed load the signed asset and upload URLs it was issued", () =>
    Effect.gen(function* () {
      const asset = `${ASSET_ROUTE_PREFIX}/signed-token/card.html`;
      const upload = `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/signed-token`;
      expect(yield* httpAllowed(embedSession, asset)).toBe(true);
      expect(yield* httpAllowed(embedSession, upload)).toBe(true);
      expect(yield* httpAllowed(appSession, asset)).toBe(false);
      expect(yield* httpAllowed(appSession, upload)).toBe(false);
      expect(yield* httpAllowed(embedSession, ASSET_ROUTE_PREFIX)).toBe(false);
      expect(yield* httpAllowed(embedSession, "/api/assetsx/signed-token")).toBe(false);
    }),
  );

  it.effect("keeps the app credential to the socket and ticket routes", () =>
    Effect.gen(function* () {
      expect(yield* httpAllowed(appSession, "/api/auth/websocket-ticket")).toBe(true);
      expect(yield* httpAllowed(appSession, "/ws")).toBe(true);
      expect(yield* httpAllowed(appSession, `/api/orchestration/threads/${rocketThread}`)).toBe(
        false,
      );
      expect(yield* httpAllowed(appSession, "/api/orchestration/shell")).toBe(false);
    }),
  );
});

describe("embed tokens", () => {
  it.effect("mints a short-lived embed session for the app's own project", () =>
    Effect.gen(function* () {
      issued.length = 0;
      const target = yield* authorization.mintEmbedToken(rocketwright, {
        projectId: rocketProject,
        threadId: rocketThread,
        ttlSeconds: 900,
      });
      expect(target).toEqual({
        url: "http://127.0.0.1:3773/embed/env-1/rocket-project/rocket-thread",
        token: "embed-token",
        expiresAt: "2026-10-25T00:15:00.000Z",
      });
      expect(issued).toEqual([
        {
          subject: "embed:dev.rocketwright.app:rocket-project",
          ttl: Duration.seconds(900),
          label: rocketwright,
        },
      ]);
      expect(EMBED_TOKEN_SCOPES).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "filesystem:read",
      ]);
    }),
  );

  it.effect("refuses another app's project and a thread from another project", () =>
    Effect.gen(function* () {
      issued.length = 0;
      for (const input of [
        { projectId: otherAppProject, ttlSeconds: 60 },
        { projectId: normalProject, ttlSeconds: 60 },
        { projectId: rocketProject, threadId: rocketSecondThread, ttlSeconds: 60 },
      ]) {
        const error = yield* authorization.mintEmbedToken(rocketwright, input).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AppsError", code: "not-found" });
      }
      expect(issued).toEqual([]);
    }),
  );
});

describe("apps.createEmbedThread", () => {
  const created: Array<string> = [];
  const handlers = (subject: AuthenticatedSession) =>
    AppsRpcHandlers.make(subject).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(AppRegistryService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({}),
          Layer.mock(HeadlessToolHost)({}),
          Layer.mock(AppLeaseService)({}),
          Layer.mock(AppHostContextStore)({}),
          Layer.mock(ThreadCopyService)({}),
          Layer.succeed(AppAuthorization)(authorization),
          Layer.mock(AppProjectService)({
            createEmbedThread: (embed: AppSubject) =>
              Effect.sync(() => {
                created.push(embed.kind);
                return { threadId: rocketThread };
              }),
          }),
        ),
      ),
    );

  it.effect("refuses a cookie-only session, which never acts as the embed", () =>
    Effect.gen(function* () {
      created.length = 0;
      const cookieSession: AuthenticatedSession = {
        ...session("owner"),
        method: "browser-session-cookie",
      };
      const owner = yield* handlers(cookieSession);
      const error = yield* owner[A.appsCreateEmbedThread]({ projectId: rocketProject }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "AppsError", code: "forbidden" });

      const embedHandlers = yield* handlers(embedSession);
      expect(yield* embedHandlers[A.appsCreateEmbedThread]({ projectId: rocketProject })).toEqual({
        threadId: rocketThread,
      });
      expect(created).toEqual(["embed"]);
    }),
  );
});
