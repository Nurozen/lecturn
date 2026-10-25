// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off -- Promise API for hosts that run no Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { AppLiveLeaseInput, AppRegistration, type AppEmbedTarget } from "@lecturn/contracts/apps";
import {
  APP_EMBED_TOKEN_MAX_TTL_SECONDS,
  AppsEnsureWorkspaceInput,
  AppsMintEmbedTokenInput,
  AppsCoreRpcs,
  APPS_WS_METHODS,
} from "@lecturn/contracts/appsRpcCore";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
} from "@lecturn/contracts/auth";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@lecturn/contracts/environment";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import type { EmbedConnectionSource } from "../target.ts";
import { type LiveTools, makeLiveLeaseHeartbeat } from "./liveLease.ts";
import { type SidecarHandle, type SidecarOptions, startSidecar } from "./sidecar.ts";

export interface ConnectOptions {
  readonly registration: typeof AppRegistration.Encoded;
  /** Where a user's own Lecturn server would be found; unused until the user-server path lands. */
  readonly lecturnHome?: string;
  readonly sidecar: SidecarOptions;
  readonly readyTimeoutMs?: number;
}

export interface LecturnConnection extends EmbedConnectionSource {
  readonly mode: "user-server" | "sidecar";
  readonly environmentId: string;
  readonly origin: string;
  ensureWorkspace(workspaceRoot: string, title: string): Promise<{ readonly projectId: string }>;
  embedTarget(projectId: string, threadId?: string): Promise<AppEmbedTarget>;
  refreshEmbedToken(projectId: string): Promise<AppEmbedTarget>;
  /**
   * Publishes the app's live MCP endpoint and keeps its lease alive while the
   * app runs (heartbeat every 20 s, lease 60 s). Calling it again moves the
   * lease to the new endpoint.
   */
  setLiveTools(tools: LiveTools): Promise<void>;
  /** Live tools then answer that the app is closed. */
  clearLiveTools(): Promise<void>;
  /** Clears the live lease, and stops the sidecar only when this connection started it. */
  close(): Promise<void>;
}

const AppsClientGroup = RpcGroup.make(...AppsCoreRpcs);

// The longest token the server mints; the guest refreshes it before expiry.
const EMBED_TOKEN_TTL_SECONDS = APP_EMBED_TOKEN_MAX_TTL_SECONDS;

const CLOSE_CLEAR_TIMEOUT_MS = 2_000;

const decodeRegistration = Schema.decodeSync(AppRegistration);
const decodeEnsureWorkspace = Schema.decodeEffect(AppsEnsureWorkspaceInput);
const decodeMintEmbedToken = Schema.decodeEffect(AppsMintEmbedTokenInput);
const decodeLiveLease = Schema.decodeEffect(AppLiveLeaseInput);
const decodeAccessToken = Schema.decodeUnknownSync(AuthAccessTokenResult);
const decodeTicket = Schema.decodeUnknownSync(AuthWebSocketTicketResult);

/**
 * The app session, shared by every helper attached to this sidecar. Sharing
 * the session rather than the seed matters: re-exchanging the seed replaces
 * the subject's earlier `desktop-bootstrap` session, which would sign the
 * other process out.
 */
const StoredSession = Schema.Struct({
  appId: Schema.String,
  environmentId: Schema.String,
  accessToken: Schema.String,
});
type StoredSession = typeof StoredSession.Type;
const decodeStoredSession = Schema.decodeUnknownOption(Schema.fromJsonString(StoredSession));

const sidecarSessionPath = (baseDir: string) => NodePath.join(baseDir, "embed-app-session.json");

async function readStoredSession(path: string): Promise<StoredSession | null> {
  try {
    const decoded = decodeStoredSession(await NodeFSP.readFile(path, "utf8"));
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

async function writeStoredSession(path: string, session: StoredSession): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temp, JSON.stringify(session), { mode: 0o600 });
  await NodeFSP.rename(temp, path);
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return `${response.status}${text ? ` ${text.slice(0, 512)}` : ""}`;
}

/** Spends the sidecar seed at the token endpoint for the app's `apps:host` session. */
export async function exchangeSeedToken(input: {
  readonly origin: string;
  readonly seedToken: string;
  readonly clientLabel: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<{ readonly accessToken: string; readonly expiresInSeconds: number }> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  // No `scope`: `apps:host` is not a grantable scope, so asking for it is
  // refused, while omitting it grants exactly what the seed holds.
  const body = new URLSearchParams({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: input.seedToken,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
    client_label: input.clientLabel,
    client_device_type: "desktop",
  });
  const response = await fetchImpl(new URL("/oauth/token", input.origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`Lecturn refused the sidecar seed: ${await readError(response)}`);
  }
  const result = decodeAccessToken(await response.json());
  return { accessToken: result.access_token, expiresInSeconds: result.expires_in };
}

async function issueWebSocketTicket(origin: string, accessToken: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/websocket-ticket", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`Lecturn refused a socket ticket: ${await readError(response)}`);
  }
  return decodeTicket(await response.json()).ticket;
}

const socketUrl = (origin: string, ticket: string | null) => {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  if (ticket !== null) url.searchParams.set("wsTicket", ticket);
  return url.toString();
};

const makeAppsClient = (origin: string, accessToken: string) => {
  // Tickets are single-use, so every (re)connect fetches a fresh one. A failed
  // fetch yields a ticketless URL the server rejects, which the socket retries.
  const url = Effect.promise(() =>
    issueWebSocketTicket(origin, accessToken).then(
      (ticket) => socketUrl(origin, ticket),
      () => socketUrl(origin, null),
    ),
  );
  const protocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket()).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
      ),
    ),
  );
  // Built into the caller's scope: `Effect.provide` would close the socket as
  // soon as the client is made.
  return Layer.build(protocol).pipe(
    Effect.flatMap((context) =>
      RpcClient.make(AppsClientGroup).pipe(Effect.provideContext(context)),
    ),
  );
};

type AppsClient = Effect.Success<ReturnType<typeof makeAppsClient>>;

const silent = Logger.layer([]);

async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(silent)));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

async function resolveSession(
  handle: SidecarHandle,
  appId: string,
  label: string,
  sessionPath: string,
  deadline: number,
): Promise<string> {
  if (handle.kind === "spawned") {
    const { accessToken } = await exchangeSeedToken({
      origin: handle.origin,
      seedToken: handle.appSeedToken,
      clientLabel: label,
    });
    await writeStoredSession(sessionPath, {
      appId,
      environmentId: handle.environmentId,
      accessToken,
    });
    return accessToken;
  }
  // The owner writes the session just after it starts serving, so an
  // attacher that won the discovery race can arrive first.
  while (true) {
    const stored = await readStoredSession(sessionPath);
    if (stored !== null && stored.environmentId === handle.environmentId) {
      if (stored.appId !== appId) {
        throw new Error(`The sidecar in this baseDir belongs to the app ${stored.appId}.`);
      }
      return stored.accessToken;
    }
    if (Date.now() >= deadline) {
      throw new Error("The running sidecar in this baseDir published no app session.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Connects the app to Lecturn. This release always runs on the app's own
 * sidecar; discovering and pairing with the user's server comes later.
 */
export async function connect(options: ConnectOptions): Promise<LecturnConnection> {
  const registration = decodeRegistration(options.registration);
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const deadline = Date.now() + readyTimeoutMs;
  const handle = await startSidecar({
    registration,
    sidecar: options.sidecar,
    readyTimeoutMs,
  });
  const stopOwned = () => (handle.kind === "spawned" ? handle.stop() : Promise.resolve());

  const scope = Scope.makeUnsafe();
  const closeScope = () => run(Scope.close(scope, Exit.void));
  let client: AppsClient;
  try {
    const accessToken = await resolveSession(
      handle,
      registration.appId,
      registration.name,
      sidecarSessionPath(options.sidecar.baseDir),
      deadline,
    );
    client = await run(makeAppsClient(handle.origin, accessToken).pipe(Scope.provide(scope)));
  } catch (error) {
    await closeScope().finally(stopOwned);
    throw error;
  }

  const mint = (projectId: string, threadId?: string) =>
    run(
      decodeMintEmbedToken({
        projectId,
        ...(threadId === undefined ? {} : { threadId }),
        ttlSeconds: EMBED_TOKEN_TTL_SECONDS,
      }).pipe(Effect.flatMap((input) => client[APPS_WS_METHODS.appsMintEmbedToken](input))),
    );

  const liveLease = makeLiveLeaseHeartbeat({
    setLease: (input) =>
      run(
        decodeLiveLease(input).pipe(
          Effect.flatMap((lease) => client[APPS_WS_METHODS.appsSetLiveLease](lease)),
        ),
      ),
    clearLease: () => run(client[APPS_WS_METHODS.appsClearLiveLease]({})),
  });

  let closed: Promise<void> | undefined;
  return {
    mode: "sidecar",
    environmentId: handle.environmentId,
    origin: handle.origin,
    ensureWorkspace: (workspaceRoot, title) =>
      run(
        decodeEnsureWorkspace({ workspaceRoot, title }).pipe(
          Effect.flatMap((input) => client[APPS_WS_METHODS.appsEnsureWorkspace](input)),
        ),
      ),
    embedTarget: (projectId, threadId) => mint(projectId, threadId),
    // Embed tokens are scoped to the project; the thread only shapes the url.
    refreshEmbedToken: (projectId) => mint(projectId),
    setLiveTools: (tools) => liveLease.set(tools),
    clearLiveTools: () => liveLease.clear(),
    close: () => {
      // Clearing first lets Lecturn show the app as closed now rather than when
      // the lease lapses; a server that is already gone must not hold up close.
      closed ??= Promise.race([
        liveLease.clear(),
        new Promise((resolve) => setTimeout(resolve, CLOSE_CLEAR_TIMEOUT_MS).unref()),
      ])
        .catch(() => undefined)
        .finally(() => liveLease.stop())
        .then(closeScope)
        .finally(stopOwned);
      return closed;
    },
  };
}
