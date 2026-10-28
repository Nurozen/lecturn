/**
 * HTTP default deny for `app:` and `embed:` sessions. `EnvironmentAuth`
 * refuses every path that is not classified here before any handler runs;
 * the authenticated-route middleware then asks `AppAuthorization` whether a
 * thread route's thread belongs to the subject's project. List routes (shell,
 * projects) are filtered by their handlers instead.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  ThreadId,
  authScopeRequiredResponse,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import type { AppAuthorization } from "./services.ts";
import { type AppSubject, parseAppSubject } from "./subjects.ts";

export type AppHttpRoute =
  | { readonly kind: "session" }
  | { readonly kind: "socket" }
  | { readonly kind: "shell" }
  | { readonly kind: "projects" }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  /**
   * Asset reads and attachment uploads. The signed token in the path is the
   * whole grant, minted only by an RPC the subject was already authorized for.
   */
  | { readonly kind: "capability" };

type AppHttpRouteKind = AppHttpRoute["kind"];

const SESSION_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/session",
  "/api/auth/websocket-ticket",
  "/oauth/token",
]);

// The asset and upload route prefixes, spelled out because `EnvironmentAuth` imports this file
// and the asset modules sit far above it; the tests pin them to the routes' own constants.
const CAPABILITY_PREFIXES = ["/api/assets/", "/api/attachments/upload/"] as const;

const THREAD_PATH = /^\/api\/orchestration\/threads\/([^/]+)(?:\/(?:bounded|history|transcript))?$/;

/** The app credential only reaches the socket; everything it does is an RPC. */
const ROUTES_BY_SUBJECT: Record<AppSubject["kind"], ReadonlySet<AppHttpRouteKind>> = {
  app: new Set(["session", "socket"]),
  embed: new Set(["session", "socket", "shell", "projects", "thread", "capability"]),
};

const isThreadId = Schema.is(ThreadId);

const decodePathSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** `request.url` is the path plus query; neither the query nor a fragment names a route. */
export const requestPath = (url: string): string => {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
};

const classifyAppHttpPath = (path: string): AppHttpRoute | null => {
  if (SESSION_PATHS.has(path)) return { kind: "session" };
  if (path === "/ws") return { kind: "socket" };
  if (path === "/api/orchestration/shell") return { kind: "shell" };
  if (path === "/api/projects") return { kind: "projects" };
  if (CAPABILITY_PREFIXES.some((prefix) => path.startsWith(prefix))) return { kind: "capability" };
  const thread = THREAD_PATH.exec(path);
  const threadId = thread?.[1] === undefined ? null : decodePathSegment(thread[1]);
  return threadId !== null && isThreadId(threadId) && threadId === threadId.trim()
    ? { kind: "thread", threadId }
    : null;
};

export const appHttpRouteFor = (subject: AppSubject, path: string): AppHttpRoute | null => {
  const route = classifyAppHttpPath(requestPath(path));
  return route !== null && ROUTES_BY_SUBJECT[subject.kind].has(route.kind) ? route : null;
};

/**
 * The per-request hook for authenticated HTTP routes. Ordinary sessions pass
 * without any work; app and embed sessions are refused when the apps
 * services are absent, so a server built without them cannot widen access.
 */
export const authorizeAppHttpRequest = (
  apps: Option.Option<AppAuthorization["Service"]>,
  session: AuthenticatedSession,
  url: string,
): Effect.Effect<void, EnvironmentAuthorizationError> => {
  if (parseAppSubject(session.subject) === null) return Effect.void;
  return Option.match(apps, {
    onNone: () =>
      Effect.fail(
        new EnvironmentAuthorizationError({
          message: "Connected apps are not available on this server.",
          ...authScopeRequiredResponse(AuthOrchestrationReadScope),
        }),
      ),
    onSome: (authorization) => authorization.authorizeHttp(session, requestPath(url)),
  });
};
