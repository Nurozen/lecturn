import {
  APPS_WS_METHODS as A,
  AppId,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS as O,
  ProjectId,
  ThreadId,
  WS_METHODS as W,
  type AppBinding,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { type AppAuthorizationDeps, EMBED_TOKEN_SCOPES, makeWith } from "./appAuthorization.ts";
import * as AppsRpcHandlers from "./AppsRpcHandlers.ts";
import {
  AppAuthorization,
  AppHostContextStore,
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  AppsNotImplemented,
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
]);

const issued: Array<{ subject: string; ttl: Duration.Duration; label: string }> = [];

const fakeDeps: AppAuthorizationDeps = {
  resolveAppForProject: (projectId) =>
    Effect.succeed(Option.fromUndefinedOr(bindings.get(projectId))),
  projectIdForThread: (threadId) =>
    Effect.succeed(Option.fromUndefinedOr(threadProjects.get(threadId))),
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
      expect(yield* allowed(embedSession, W.serverGetConfig, {})).toBe(true);
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
      expect(yield* dispatch({ type: "message.dispatch", threadId: rocketThread })).toBe(true);
      expect(yield* dispatch({ type: "message.dispatch", threadId: normalThread })).toBe(false);
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
        allowed(embedSession, O.launchThread, { projectId: rocketProject, ...fields });
      expect(yield* launch({ threadId: rocketThread, reuseExistingThread: true })).toBe(true);
      expect(yield* launch({ threadId: missingThread, reuseExistingThread: true })).toBe(false);
      expect(yield* launch({ threadId: rocketThread })).toBe(false);
      expect(yield* launch({})).toBe(false);
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

  it.effect("surfaces an unfinished project lookup so the socket can explain the denial", () =>
    Effect.gen(function* () {
      const unfinished = makeWith({
        ...fakeDeps,
        resolveAppForProject: () =>
          Effect.fail(
            new AppsNotImplemented({
              service: "AppProjectService",
              method: "resolveAppForProject",
            }),
          ),
      });
      const error = yield* unfinished
        .authorizeRpc(embedSession, O.subscribeThread, { threadId: rocketThread })
        .pipe(Effect.flip);
      expect(error._tag).toBe("AppsNotImplemented");
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
