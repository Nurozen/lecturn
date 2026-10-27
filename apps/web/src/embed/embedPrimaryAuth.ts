import { fetchRemoteSessionState } from "@lecturn/client-runtime/authorization";
import { ConnectionBlockedError, type Wakeups } from "@lecturn/client-runtime/connection";
import { ClientCapabilities } from "@lecturn/client-runtime/platform";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import {
  readEmbedToken,
  readEmbedTokenExpiresAt,
  rememberEmbedTokenExpiry,
  setEmbedToken,
  subscribeEmbedToken,
} from "./embedAuth";
import { makeEmbedHttpLayer } from "./embedHttpLayer";

/** What the host answers to `lecturn/token.refresh`. */
export interface EmbedTokenGrant {
  readonly token: string;
  readonly expiresAt: string;
}

export type EmbedTokenRefresher = () => Promise<EmbedTokenGrant>;

const REFRESH_LEAD_MS = 30_000;
const REFRESH_RETRY_MS = 5_000;

let refresher: EmbedTokenRefresher | null = null;

/** The embed bridge registers how to ask its host for a new token. */
export function setEmbedTokenRefresher(next: EmbedTokenRefresher | null): void {
  refresher = next;
}

/**
 * The primary broker mints a WebSocket ticket from this bearer before every connect
 * (`authorizeBearer`), so the socket authenticates as the embed even though its handshake carries
 * the user's cookie. Without a token there is no safe fallback: an unticketed socket would
 * authenticate by that cookie, as the user.
 */
export const embedPrimaryAuth = ClientCapabilities.PrimaryEnvironmentAuth.of({
  bearerToken: Effect.suspend(() => {
    const token = readEmbedToken();
    return token === null
      ? Effect.fail(
          new ConnectionBlockedError({
            reason: "authentication",
            detail: "This embedded view has no Lecturn credential. Reopen it from its app.",
          }),
        )
      : Effect.succeedSome(token);
  }),
});

const learnExpiry = Effect.fn("web.embed.learnTokenExpiry")(function* (token: string) {
  const httpBaseUrl = yield* Effect.try(() => resolvePrimaryEnvironmentHttpUrl("/"));
  const session = yield* fetchRemoteSessionState({
    httpBaseUrl,
    bearerToken: token,
  }).pipe(Effect.provide(makeEmbedHttpLayer()));
  const expiresAtMs = session.expiresAt?.epochMilliseconds ?? null;
  if (expiresAtMs !== null) rememberEmbedTokenExpiry(token, expiresAtMs);
  return expiresAtMs;
});

// Refresh at the later of 30 s before expiry and halfway there, so a short-lived token is not
// refreshed in a tight loop.
function refreshDelayMs(expiresAtMs: number, nowMs: number): number {
  const remaining = Math.max(0, expiresAtMs - nowMs);
  return Math.max(remaining - REFRESH_LEAD_MS, remaining / 2);
}

const requestRefresh = Effect.fn("web.embed.refreshToken")(function* () {
  const refresh = refresher;
  if (refresh === null) return false;
  const grant = yield* Effect.tryPromise(refresh);
  const expiresAtMs = Date.parse(grant.expiresAt);
  setEmbedToken(grant.token, Number.isNaN(expiresAtMs) ? null : expiresAtMs);
  return true;
});

/**
 * The server closes an embed socket when its token expires, so a new token is fetched before then
 * and every token change replaces the session. `application-active-reconnect` is the wakeup that
 * replaces a live session outright, and the new session subscribes again on its own.
 */
export const embedConnectionWakeups = Stream.callback<Wakeups.ConnectionWakeup>((wakeups) =>
  Effect.gen(function* () {
    const changes = yield* Queue.sliding<void>(1);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        subscribeEmbedToken(() => {
          Queue.offerUnsafe(changes, undefined);
          Queue.offerUnsafe(wakeups, "application-active-reconnect");
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    const nextChange = Queue.take(changes).pipe(Effect.as("changed" as const));
    const untilChangedOr = (delayMs: number) =>
      nextChange.pipe(
        Effect.timeoutOrElse({ duration: delayMs, orElse: () => Effect.succeed("due" as const) }),
      );

    const step = Effect.gen(function* () {
      const token = readEmbedToken();
      if (token === null) return yield* nextChange;
      const expiresAtMs =
        readEmbedTokenExpiresAt() ??
        (yield* learnExpiry(token).pipe(Effect.orElseSucceed(() => undefined)));
      if (expiresAtMs === undefined) return yield* untilChangedOr(REFRESH_RETRY_MS);
      if (expiresAtMs === null) return yield* nextChange;
      const now = yield* Clock.currentTimeMillis;
      if ((yield* untilChangedOr(refreshDelayMs(expiresAtMs, now))) === "changed") return;
      const refreshed = yield* requestRefresh().pipe(Effect.orElseSucceed(() => false));
      if (!refreshed) yield* untilChangedOr(REFRESH_RETRY_MS);
    });
    yield* Effect.forkScoped(Effect.forever(step));
  }),
);
