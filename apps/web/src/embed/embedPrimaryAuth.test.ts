import { resolveRemoteWebSocketConnectionUrl } from "@lecturn/client-runtime/authorization";
import { layerRemoteHttpClient } from "@lecturn/client-runtime/rpc";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  __resetEmbedAuthForTests,
  readEmbedBearerToken,
  readEmbedTokenExpiresAt,
  rememberEmbedTokenExpiry,
} from "./embedAuth";
import { layerWithoutCookies } from "./embedHttpLayer";
import {
  embedConnectionWakeups,
  embedPrimaryAuth,
  setEmbedTokenRefresher,
  type EmbedTokenGrant,
} from "./embedPrimaryAuth";

const ORIGIN = "http://127.0.0.1:3773";

function installEmbedWindow(hash: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: new URL(`${ORIGIN}/embed/environment-1/project-1${hash}`),
      history: { state: null, replaceState: () => undefined },
    },
  });
}

const collectWakeups = Effect.gen(function* () {
  const wakeups = yield* Queue.unbounded<string>();
  yield* embedConnectionWakeups.pipe(
    Stream.runForEach((wakeup) => Queue.offer(wakeups, String(wakeup))),
    Effect.forkScoped({ startImmediately: true }),
  );
  return wakeups;
});

describe("embed primary auth", { concurrent: false }, () => {
  afterEach(() => {
    setEmbedTokenRefresher(null);
    __resetEmbedAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it.effect("hands the connection the embed token from the hash", () =>
    Effect.gen(function* () {
      installEmbedWindow("#embedToken=embed-token&parentOrigin=http%3A%2F%2F127.0.0.1%3A5173");
      expect(yield* embedPrimaryAuth.bearerToken).toEqual(Option.some("embed-token"));
    }),
  );

  // An unticketed socket would authenticate by the user's cookie, as the user.
  it.effect("refuses to connect without an embed token instead of falling back to the cookie", () =>
    Effect.gen(function* () {
      installEmbedWindow("");
      const error = yield* Effect.flip(embedPrimaryAuth.bearerToken);
      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication" });
    }),
  );

  it.effect("mints a WebSocket ticket with the embed bearer and no cookies", () =>
    Effect.gen(function* () {
      installEmbedWindow("#embedToken=embed-token");
      const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          Response.json({ ticket: "ticket-1", expiresAt: "2026-10-25T00:01:00.000Z" }),
        ),
      );
      const bearer = yield* embedPrimaryAuth.bearerToken;

      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: "ws://127.0.0.1:3773",
        httpBaseUrl: ORIGIN,
        bearerToken: Option.getOrThrow(bearer),
        connectionMethod: "direct",
      }).pipe(Effect.provide(layerWithoutCookies(layerRemoteHttpClient(fetchMock))));

      const call = fetchMock.mock.calls[0];
      if (call === undefined) throw new Error("No ticket request");
      const ticketRequest = new Request(call[0], call[1]);
      expect(new URL(ticketRequest.url).pathname).toBe("/api/auth/websocket-ticket");
      expect(ticketRequest.credentials).toBe("omit");
      expect(ticketRequest.headers.get("authorization")).toBe("Bearer embed-token");
      const url = new URL(socketUrl);
      expect(url.pathname).toBe("/ws");
      expect(url.searchParams.get("wsTicket")).toBe("ticket-1");
    }),
  );

  it.effect("refreshes a token near expiry and replaces the session with the new one", () =>
    Effect.gen(function* () {
      installEmbedWindow("#embedToken=tok-1");
      rememberEmbedTokenExpiry(Option.getOrThrow(yield* embedPrimaryAuth.bearerToken), 120_000);
      const refreshed = yield* Deferred.make<void>();
      setEmbedTokenRefresher(() => {
        Deferred.doneUnsafe(refreshed, Effect.void);
        return Promise.resolve<EmbedTokenGrant>({
          token: "tok-2",
          expiresAt: new Date(600_000).toISOString(),
        });
      });
      const wakeups = yield* collectWakeups;

      // 30 s before expiry, not at it: the server closes the socket at expiry.
      yield* TestClock.adjust(89_999);
      expect(yield* Deferred.isDone(refreshed)).toBe(false);
      yield* TestClock.adjust(1);
      yield* Deferred.await(refreshed);

      expect(yield* Queue.take(wakeups)).toBe("application-active-reconnect");
      expect(yield* embedPrimaryAuth.bearerToken).toEqual(Option.some("tok-2"));
      expect(readEmbedTokenExpiresAt()).toBe(600_000);
    }),
  );

  it.effect("learns the first token's expiry from the session, without cookies", () =>
    Effect.gen(function* () {
      installEmbedWindow("#embedToken=tok-1");
      const sessionRead = yield* Deferred.make<Request>();
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          Deferred.doneUnsafe(sessionRead, Effect.succeed(new Request(input, init)));
          return Promise.resolve(
            Response.json({
              authenticated: true,
              auth: {
                policy: "loopback-browser",
                bootstrapMethods: [],
                sessionMethods: ["bearer-access-token"],
                sessionCookieName: "lecturn_session",
              },
              expiresAt: new Date(120_000).toISOString(),
            }),
          );
        }),
      );
      const refreshed = yield* Deferred.make<void>();
      setEmbedTokenRefresher(() => {
        Deferred.doneUnsafe(refreshed, Effect.void);
        return Promise.resolve({ token: "tok-2", expiresAt: new Date(600_000).toISOString() });
      });
      const wakeups = yield* collectWakeups;

      const request = yield* Deferred.await(sessionRead);
      expect(new URL(request.url).pathname).toBe("/api/auth/session");
      expect(request.credentials).toBe("omit");
      expect(request.headers.get("authorization")).toBe("Bearer tok-1");

      yield* TestClock.adjust(90_000);
      yield* Deferred.await(refreshed);
      expect(yield* Queue.take(wakeups)).toBe("application-active-reconnect");
      expect(yield* Effect.promise(readEmbedBearerToken)).toBe("tok-2");
    }),
  );

  it.effect("keeps the session when no refresher is registered yet", () =>
    Effect.gen(function* () {
      installEmbedWindow("#embedToken=tok-1");
      rememberEmbedTokenExpiry(Option.getOrThrow(yield* embedPrimaryAuth.bearerToken), 120_000);
      const wakeups = yield* collectWakeups;

      yield* TestClock.adjust(200_000);

      expect(yield* Queue.size(wakeups)).toBe(0);
      expect(yield* embedPrimaryAuth.bearerToken).toEqual(Option.some("tok-1"));
    }),
  );
});
