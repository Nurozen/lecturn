// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off -- Promise API for hosts that run no Effect runtime.
import {
  AppLiveLeaseInput,
  type AppEmbedTarget,
  ConnectedAppThreadContinuedIn,
  type ConnectedAppThreadSummary,
  type ConnectedAppThreadsStreamEvent,
} from "@lecturn/contracts/apps";
import {
  APP_EMBED_TOKEN_MAX_TTL_SECONDS,
  AppsCoreRpcs,
  AppsEnsureWorkspaceInput,
  AppsError,
  AppsExportThreadsInput,
  AppsImportThreadsResult,
  AppsMarkThreadsCopiedInput,
  AppsMintEmbedTokenInput,
  AppsSetThreadAppDataInput,
  AppsUpdateHostContextInput,
  APPS_WS_METHODS,
} from "@lecturn/contracts/appsRpcCore";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  EnvironmentAuthorizationError,
} from "@lecturn/contracts/auth";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@lecturn/contracts/environment";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

/**
 * A copy bundle as the helper sees it: it carries the sidecar's export to the
 * user server untouched, so it never needs (or bundles) the orchestration
 * schemas the bundle embeds. The server decodes it on import.
 */
export type ThreadCopyBundle = unknown;

export type HostContextTarget = { readonly threadId: string } | { readonly projectId: string };

/** One app session on one Lecturn server, sidecar or user server alike. */
export interface ServerSession {
  readonly origin: string;
  readonly environmentId: string;
  /**
   * The server refused the bearer when the socket reconnected, so the session
   * cannot recover; its owner closes it, which ends the reconnects.
   */
  readonly credentialRejected: boolean;
  ensureWorkspace(workspaceRoot: string, title: string): Promise<{ readonly projectId: string }>;
  mintEmbedToken(projectId: string, threadId?: string): Promise<AppEmbedTarget>;
  setLiveLease(input: {
    readonly url: string;
    readonly bearer: string;
    readonly ttlSeconds: number;
  }): Promise<unknown>;
  clearLiveLease(): Promise<unknown>;
  listThreads(projectId: string): Promise<ReadonlyArray<ConnectedAppThreadSummary>>;
  /** Resubscribes across socket drops until the returned function is called or the session closes. */
  subscribeThreads(
    projectId: string,
    listener: (event: ConnectedAppThreadsStreamEvent) => void,
  ): () => void;
  setThreadAppData(
    threadId: string,
    appData: string | null,
    subtitle?: string | null,
  ): Promise<void>;
  /** Empty text clears the entry. */
  updateHostContext(target: HostContextTarget, text: string): Promise<void>;
  exportThreads(projectIds: ReadonlyArray<string>): Promise<ThreadCopyBundle>;
  importThreads(
    bundle: ThreadCopyBundle,
  ): Promise<{ readonly imported: number; readonly skipped: number }>;
  markThreadsCopied(
    entries: ReadonlyArray<{
      readonly threadId: string;
      readonly continuedIn: typeof ConnectedAppThreadContinuedIn.Encoded;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}

/** The server refused the app's bearer: it expired, or the user revoked the app. */
export class CredentialRejectedError extends Error {
  override readonly name = "CredentialRejectedError";
}

const rpcError = Schema.Union([AppsError, EnvironmentAuthorizationError]);
const AppsClientGroup = RpcGroup.make(
  ...AppsCoreRpcs,
  // The full bundle schema stays on the server (appsRpcCore.ts says why).
  Rpc.make(APPS_WS_METHODS.appsExportThreads, {
    payload: AppsExportThreadsInput,
    success: Schema.Unknown,
    error: rpcError,
  }),
  Rpc.make(APPS_WS_METHODS.appsImportThreads, {
    payload: { bundle: Schema.Unknown },
    success: AppsImportThreadsResult,
    error: rpcError,
  }),
);

// The longest token the server mints; the guest refreshes it before expiry.
const EMBED_TOKEN_TTL_SECONDS = APP_EMBED_TOKEN_MAX_TTL_SECONDS;

const decodeEnsureWorkspace = Schema.decodeEffect(AppsEnsureWorkspaceInput);
const decodeMintEmbedToken = Schema.decodeEffect(AppsMintEmbedTokenInput);
const decodeLiveLease = Schema.decodeEffect(AppLiveLeaseInput);
const decodeProjectTarget = Schema.decodeEffect(
  Schema.Struct({ projectId: AppsMintEmbedTokenInput.fields.projectId }),
);
const decodeSetThreadAppData = Schema.decodeEffect(AppsSetThreadAppDataInput);
const decodeUpdateHostContext = Schema.decodeEffect(AppsUpdateHostContextInput);
const decodeExportThreads = Schema.decodeEffect(AppsExportThreadsInput);
const decodeMarkThreadsCopied = Schema.decodeEffect(AppsMarkThreadsCopiedInput);
// A dropped socket ends the stream; the client reconnects underneath, so resubscribing is enough.
const THREADS_RESUBSCRIBE = Schedule.exponential("500 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(10))),
  ),
);
const decodeAccessToken = Schema.decodeUnknownSync(AuthAccessTokenResult);
// JSON codec: `expiresAt` arrives as an ISO string, not a DateTime.
const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult));

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

export async function issueWebSocketTicket(
  origin: string,
  accessToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const response = await fetchImpl(new URL("/api/auth/websocket-ticket", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    credentials: "omit",
  });
  if (response.status === 401 || response.status === 403) {
    throw new CredentialRejectedError(
      `Lecturn refused the app's credential: ${await readError(response)}`,
    );
  }
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

const makeAppsClient = (origin: string, accessToken: string, onRejected: () => void) => {
  // Tickets are single-use, so every (re)connect fetches a fresh one. A failed
  // fetch yields a ticketless URL the server rejects, which the socket retries.
  const url = Effect.promise(() =>
    issueWebSocketTicket(origin, accessToken).then(
      (ticket) => socketUrl(origin, ticket),
      (error: unknown) => {
        if (error instanceof CredentialRejectedError) onRejected();
        return socketUrl(origin, null);
      },
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

const silent = Logger.layer([]);

async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(silent)));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/**
 * Opens the app's socket to one server. With `verify`, the bearer is checked
 * first, so a revoked or expired credential fails here with
 * `CredentialRejectedError` instead of the socket retrying forever.
 */
export async function openServerSession(input: {
  readonly origin: string;
  readonly environmentId: string;
  readonly accessToken: string;
  readonly verify?: boolean;
}): Promise<ServerSession> {
  const { origin, accessToken } = input;
  if (input.verify === true) await issueWebSocketTicket(origin, accessToken);
  const scope = Scope.makeUnsafe();
  const closeScope = () => run(Scope.close(scope, Exit.void));
  let credentialRejected = false;
  let client: Effect.Success<ReturnType<typeof makeAppsClient>>;
  try {
    client = await run(
      makeAppsClient(origin, accessToken, () => {
        credentialRejected = true;
      }).pipe(Scope.provide(scope)),
    );
  } catch (error) {
    await closeScope();
    throw error;
  }

  const threadSubscriptions = new Set<Fiber.Fiber<unknown, unknown>>();
  let closed: Promise<void> | undefined;

  return {
    origin,
    environmentId: input.environmentId,
    get credentialRejected() {
      return credentialRejected;
    },
    ensureWorkspace: (workspaceRoot, title) =>
      run(
        decodeEnsureWorkspace({ workspaceRoot, title }).pipe(
          Effect.flatMap((payload) => client[APPS_WS_METHODS.appsEnsureWorkspace](payload)),
        ),
      ),
    mintEmbedToken: (projectId, threadId) =>
      run(
        decodeMintEmbedToken({
          projectId,
          ...(threadId === undefined ? {} : { threadId }),
          ttlSeconds: EMBED_TOKEN_TTL_SECONDS,
        }).pipe(Effect.flatMap((payload) => client[APPS_WS_METHODS.appsMintEmbedToken](payload))),
      ),
    setLiveLease: (lease) =>
      run(
        decodeLiveLease(lease).pipe(
          Effect.flatMap((payload) => client[APPS_WS_METHODS.appsSetLiveLease](payload)),
        ),
      ),
    clearLiveLease: () => run(client[APPS_WS_METHODS.appsClearLiveLease]({})),
    listThreads: (projectId) =>
      run(
        decodeProjectTarget({ projectId }).pipe(
          Effect.flatMap((payload) => client[APPS_WS_METHODS.appsListThreads](payload)),
        ),
      ),
    subscribeThreads: (projectId, listener) => {
      const fiber = Effect.runFork(
        decodeProjectTarget({ projectId }).pipe(
          Effect.flatMap((payload) =>
            client[APPS_WS_METHODS.appsSubscribeThreads](payload).pipe(
              Stream.runForEach((event) => Effect.sync(() => listener(event))),
              // A refusal (wrong project, revoked app) will not change by asking again.
              Effect.retry({
                schedule: THREADS_RESUBSCRIBE,
                while: (error) =>
                  error._tag !== "AppsError" && error._tag !== "EnvironmentAuthorizationError",
              }),
            ),
          ),
          Effect.provide(silent),
        ),
      );
      threadSubscriptions.add(fiber);
      return () => {
        if (!threadSubscriptions.delete(fiber)) return;
        Effect.runFork(Fiber.interrupt(fiber));
      };
    },
    setThreadAppData: (threadId, appData, subtitle) =>
      run(
        decodeSetThreadAppData({
          threadId,
          appData,
          ...(subtitle === undefined ? {} : { subtitle }),
        }).pipe(
          Effect.flatMap((payload) => client[APPS_WS_METHODS.appsSetThreadAppData](payload)),
          Effect.asVoid,
        ),
      ),
    updateHostContext: (target, text) =>
      run(
        decodeUpdateHostContext({ target, text }).pipe(
          Effect.flatMap((payload) => client[APPS_WS_METHODS.appsUpdateHostContext](payload)),
          Effect.asVoid,
        ),
      ),
    exportThreads: (projectIds) =>
      run(
        decodeExportThreads({ projectIds: [...projectIds] }).pipe(
          Effect.flatMap((payload) => client[APPS_WS_METHODS.appsExportThreads](payload)),
        ),
      ),
    importThreads: (bundle) => run(client[APPS_WS_METHODS.appsImportThreads]({ bundle })),
    markThreadsCopied: (entries) =>
      run(
        decodeMarkThreadsCopied({ entries: [...entries] }).pipe(
          Effect.flatMap((payload) => client[APPS_WS_METHODS.appsMarkThreadsCopied](payload)),
          Effect.asVoid,
        ),
      ),
    close: () => {
      closed ??= (async () => {
        const fibers = [...threadSubscriptions];
        threadSubscriptions.clear();
        await run(Fiber.interruptAll(fibers));
        await closeScope();
      })();
      return closed;
    },
  };
}
