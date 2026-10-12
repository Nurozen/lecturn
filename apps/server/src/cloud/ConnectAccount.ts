import {
  ConnectAccount as AccountSchema,
  ConnectAccountError,
  type ConnectAccountBeginResult,
  type ConnectAccountStatus,
  type ConnectAccountTokenResult,
} from "@lecturn/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { beginOutOfBandOAuthLogin, refreshOAuthToken } from "./CliTokenManager.ts";
import { cloudCliOAuthConfig, hostedAppUrlConfig, relayUrlConfig } from "./publicConfig.ts";

// Same permission-protected store as CLI credentials; encryption at rest is
// provided by the Android disk boundary, not by a separate application key.
const SECRET = "connect-phone-account";
const LOGIN_TTL_MS = 10 * 60 * 1000;
const StoredAccount = Schema.fromJsonString(
  Schema.Struct({
    account: AccountSchema,
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAtEpochMs: Schema.Number,
    issuer: Schema.String,
    clientId: Schema.String,
    relayUrl: Schema.String,
  }),
);
type StoredAccount = typeof StoredAccount.Type;
const decodeStoredAccount = Schema.decodeUnknownEffect(StoredAccount);
const encodeStoredAccount = Schema.encodeEffect(StoredAccount);
export interface ConnectAccountOwner {
  readonly sessionId: string;
  readonly subject: string;
}
const error = (reason: ConnectAccountError["reason"], message: string) =>
  new ConnectAccountError({ reason, message });
const invalidRequest = () =>
  error("invalid_request", "This sign-in request is no longer available. Start again.");

export class ConnectAccount extends Context.Service<
  ConnectAccount,
  {
    readonly status: Effect.Effect<ConnectAccountStatus, ConnectAccountError>;
    readonly begin: (
      owner: ConnectAccountOwner,
    ) => Effect.Effect<ConnectAccountBeginResult, ConnectAccountError>;
    readonly complete: (
      owner: ConnectAccountOwner,
      requestId: string,
      code: string,
    ) => Effect.Effect<ConnectAccountStatus, ConnectAccountError>;
    readonly cancel: (
      owner: ConnectAccountOwner,
      requestId: string,
    ) => Effect.Effect<ConnectAccountStatus, ConnectAccountError>;
    readonly token: (
      accountId: string,
    ) => Effect.Effect<ConnectAccountTokenResult, ConnectAccountError>;
    readonly logout: Effect.Effect<ConnectAccountStatus, ConnectAccountError>;
  }
>()("lecturn/cloud/ConnectAccount") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const oauthServices = Context.make(Crypto.Crypto, crypto).pipe(
    Context.add(HttpClient.HttpClient, httpClient),
  );
  const configuration = yield* Effect.gen(function* () {
    const oauth = yield* cloudCliOAuthConfig;
    yield* hostedAppUrlConfig;
    const relayUrl = yield* relayUrlConfig;
    return { ...oauth, relayUrl };
  }).pipe(Effect.option);
  const config = Option.getOrNull(configuration);
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  type Login = Effect.Success<typeof beginOutOfBandOAuthLogin>;
  let pending: {
    owner: ConnectAccountOwner;
    requestId: string;
    expiresAt: number;
    login: Login;
    completing: boolean;
  } | null = null;
  let lastError: string | undefined;

  const requireConfig = () =>
    config === null
      ? Effect.fail(error("not_configured", "Lecturn Connect is not configured on this phone."))
      : Effect.succeed(config);
  const expire = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (pending && pending.expiresAt <= now) {
      pending = null;
      lastError = "Sign-in expired. Start again.";
    }
  });
  const read = Effect.fn("ConnectAccount.read")(
    function* () {
      const bytes = yield* secrets.get(SECRET);
      if (Option.isNone(bytes)) return null;
      const stored = yield* decodeStoredAccount(new TextDecoder().decode(bytes.value));
      if (
        !config ||
        stored.issuer !== config.tokenEndpoint ||
        stored.clientId !== config.clientId ||
        stored.relayUrl !== config.relayUrl
      ) {
        return yield* error(
          "credential_unavailable",
          "Connect configuration changed. Sign out and sign in again.",
        );
      }
      return stored;
    },
    Effect.mapError(() =>
      error(
        "credential_unavailable",
        "Could not read the local Connect account. Sign out and sign in again.",
      ),
    ),
  );
  const persist = (stored: StoredAccount) =>
    encodeStoredAccount(stored).pipe(
      Effect.flatMap((value) => secrets.set(SECRET, new TextEncoder().encode(value))),
      Effect.mapError(() =>
        error("credential_unavailable", "Could not save the local Connect account."),
      ),
    );
  const snapshot = Effect.gen(function* (): Effect.fn.Return<
    ConnectAccountStatus,
    ConnectAccountError
  > {
    yield* expire;
    if (!config)
      return {
        configured: false,
        state: "signed-out",
        account: null,
        relayUrl: null,
        error: "Lecturn Connect is not configured on this phone.",
      };
    const stored = yield* read().pipe(
      Effect.catch((failure) => {
        lastError = failure.message;
        return Effect.succeed(null);
      }),
    );
    return {
      configured: true,
      state: pending ? "authorizing" : lastError ? "error" : stored ? "signed-in" : "signed-out",
      account: stored?.account ?? null,
      relayUrl: config.relayUrl,
      ...(lastError ? { error: lastError } : {}),
    };
  });
  const userinfo = Effect.fn("ConnectAccount.userinfo")(
    function* (accessToken: string) {
      const metadata = yield* requireConfig();
      // Only the configured issuer authenticates this identity. Never decode a JWT as proof.
      const response = yield* HttpClientRequest.get(
        new URL("/oauth/userinfo", metadata.tokenEndpoint),
      ).pipe(
        HttpClientRequest.bearerToken(accessToken),
        httpClient.execute,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.filterOrFail(
          (response) => response.status === 200,
          () => error("authorization_failed", "Could not verify the Connect account."),
        ),
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(
            Schema.Struct({
              sub: AccountSchema.fields.id,
              email: Schema.optionalKey(Schema.String),
            }),
          ),
        ),
      );
      return { id: response.sub, ...(response.email ? { email: response.email } : {}) };
    },
    Effect.timeout("30 seconds"),
    Effect.mapError(() => error("authorization_failed", "Could not verify the Connect account.")),
  );

  const begin = Effect.fn("ConnectAccount.begin")(function* (owner: ConnectAccountOwner) {
    yield* requireConfig();
    yield* expire;
    if (pending)
      return yield* error("login_in_progress", "A Connect sign-in is already in progress.");
    if (yield* read())
      return yield* error("already_signed_in", "Sign out before choosing another Connect account.");
    const login = yield* beginOutOfBandOAuthLogin.pipe(
      Effect.provide(oauthServices),
      Effect.mapError(() => error("authorization_failed", "Could not start Connect sign-in.")),
    );
    const requestId = Encoding.encodeBase64Url(
      yield* crypto
        .randomBytes(24)
        .pipe(
          Effect.mapError(() => error("authorization_failed", "Could not start Connect sign-in.")),
        ),
    );
    const expiresAt = (yield* Clock.currentTimeMillis) + LOGIN_TTL_MS;
    pending = { owner, requestId, expiresAt, login, completing: false };
    lastError = undefined;
    return {
      requestId,
      authorizationUrl: login.authorizeUrl,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
    };
  }, locked);
  const findPending = Effect.fn("ConnectAccount.findPending")(function* (
    owner: ConnectAccountOwner,
    requestId: string,
  ) {
    yield* expire;
    if (
      !pending ||
      pending.requestId !== requestId ||
      pending.owner.sessionId !== owner.sessionId ||
      pending.owner.subject !== owner.subject
    ) {
      return yield* invalidRequest();
    }
    return pending;
  });
  const complete = Effect.fn("ConnectAccount.complete")(function* (
    owner: ConnectAccountOwner,
    requestId: string,
    code: string,
  ) {
    const attempt = yield* locked(
      Effect.gen(function* () {
        const current = yield* findPending(owner, requestId);
        if (current.completing) return yield* invalidRequest();
        current.completing = true;
        return current;
      }),
    );
    return yield* Effect.gen(function* () {
      const metadata = yield* requireConfig();
      const { token } = yield* attempt.login.complete(code).pipe(
        Effect.provide(oauthServices),
        Effect.timeout("30 seconds"),
        Effect.mapError(() =>
          error("authorization_failed", "Connect sign-in failed. Start again."),
        ),
      );
      if (!token.refreshToken)
        return yield* error(
          "authorization_failed",
          "Connect did not return a refresh credential. Start again.",
        );
      const account = yield* userinfo(token.accessToken);
      return yield* locked(
        Effect.gen(function* () {
          yield* expire;
          if (pending !== attempt) return yield* invalidRequest();
          yield* persist({
            account,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAtEpochMs: token.expiresAtEpochMs,
            issuer: metadata.tokenEndpoint,
            clientId: metadata.clientId,
            relayUrl: metadata.relayUrl,
          });
          pending = null;
          lastError = undefined;
          return yield* snapshot;
        }).pipe(Effect.uninterruptible),
      );
    }).pipe(
      Effect.onExit((exit) =>
        locked(
          Effect.sync(() => {
            if (pending === attempt) {
              pending = null;
              if (exit._tag === "Failure") lastError = "Connect sign-in failed. Start again.";
            }
          }),
        ),
      ),
    );
  });
  const cancel = Effect.fn("ConnectAccount.cancel")(function* (
    owner: ConnectAccountOwner,
    requestId: string,
  ) {
    yield* findPending(owner, requestId);
    pending = null;
    lastError = undefined;
    return yield* snapshot;
  }, locked);
  const token = Effect.fn("ConnectAccount.token")(function* (accountId: string) {
    yield* requireConfig();
    const stored = yield* read();
    if (!stored) return { token: null };
    if (stored.account.id !== accountId)
      return yield* error(
        "account_mismatch",
        "The requested Connect account is not signed in on this phone.",
      );
    return yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (stored.expiresAtEpochMs - 5 * 60 * 1000 > now) return { token: stored.accessToken };
      const refreshed = yield* refreshOAuthToken(stored).pipe(
        Effect.provide(oauthServices),
        Effect.timeout("30 seconds"),
        Effect.mapError(() =>
          error(
            "credential_unavailable",
            "Connect session could not be refreshed. Sign out and sign in again.",
          ),
        ),
      );
      const account = yield* userinfo(refreshed.accessToken);
      if (account.id !== stored.account.id)
        return yield* error(
          "account_mismatch",
          "Connect returned a different account. Sign out and sign in again.",
        );
      yield* persist({
        ...stored,
        account,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAtEpochMs: refreshed.expiresAtEpochMs,
      });
      lastError = undefined;
      return { token: refreshed.accessToken };
    }).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() => {
          lastError = failure.message;
        }),
      ),
    );
  }, locked);
  const logout = locked(
    Effect.gen(function* () {
      pending = null;
      yield* secrets
        .remove(SECRET)
        .pipe(
          Effect.mapError(() =>
            error(
              "credential_unavailable",
              "Could not remove the local Connect account. Try signing out again.",
            ),
          ),
        );
      lastError = undefined;
      return yield* snapshot;
    }).pipe(Effect.uninterruptible),
  );
  return ConnectAccount.of({ status: locked(snapshot), begin, complete, cancel, token, logout });
});
export const layer = Layer.effect(ConnectAccount, make);
