import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  __resetEmbedBridgeForTests,
  readEmbedBridge,
  resolveEmbedTransport,
  startEmbedBridge,
} from "./bridge";
import { __resetEmbedAuthForTests, readEmbedToken, rememberEmbedTokenExpiry } from "./embedAuth";
import { embedConnectionWakeups, setEmbedTokenRefresher } from "./embedPrimaryAuth";

const ORIGIN = "http://127.0.0.1:3773";
const PARENT_ORIGIN = "http://127.0.0.1:5173";

interface Posted {
  readonly message: Record<string, unknown>;
  readonly targetOrigin?: string;
}

function makeFrameWindow(
  hash = `#embedToken=tok-1&parentOrigin=${encodeURIComponent(PARENT_ORIGIN)}`,
) {
  const posted: Posted[] = [];
  const onPost: Array<(posted: Posted) => void> = [];
  const parent = {
    postMessage(message: unknown, targetOrigin: string) {
      const entry = { message: message as Record<string, unknown>, targetOrigin };
      posted.push(entry);
      for (const listener of onPost) listener(entry);
    },
  };
  const target = new EventTarget();
  const win = Object.assign(target, {
    parent: parent as unknown as Window,
    location: new URL(`${ORIGIN}/embed/environment-1/project-1${hash}`),
    history: { state: null, replaceState: () => undefined },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  const deliver = (data: unknown, from: { source?: unknown; origin?: string } = {}) =>
    win.dispatchEvent(
      Object.assign(new Event("message"), {
        data,
        source: "source" in from ? from.source : parent,
        origin: from.origin ?? PARENT_ORIGIN,
      }),
    );
  const answer = (method: string, result: unknown) => {
    const request = posted.find((entry) => entry.message.method === method);
    deliver({ jsonrpc: "2.0", id: request?.message.id, result });
  };
  return { win, parent, posted, onPost, deliver, answer };
}

const initializeResult = {
  hostContext: { theme: "dark", displayMode: "inline", locale: "en-US" },
  hostCapabilities: { experimental: { lecturn: { version: 1 } } },
};

const methods = (posted: ReadonlyArray<Posted>) => posted.map((entry) => entry.message.method);

const flushMicrotasks = () => Promise.resolve().then(() => undefined);

describe("embed bridge", { concurrent: false }, () => {
  afterEach(() => {
    __resetEmbedBridgeForTests();
    setEmbedTokenRefresher(null);
    __resetEmbedAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("has no transport outside a host: a top-level tab, or a frame without a parent origin", () => {
    const top = { parent: null as unknown as Window, location: { origin: ORIGIN } };
    Object.assign(top, { parent: top });
    expect(resolveEmbedTransport(top as never, PARENT_ORIGIN)).toBeNull();
    const { win } = makeFrameWindow("#embedToken=tok-1");
    expect(resolveEmbedTransport(win, null)).toBeNull();
    expect(startEmbedBridge(win)).toBeNull();
  });

  it("talks to an Electron host through the preload global and trusts only this window", () => {
    const sent: unknown[] = [];
    const target = new EventTarget();
    const win = Object.assign(target, {
      location: { origin: ORIGIN },
      lecturnEmbedHost: { postMessage: (message: unknown) => sent.push(message) },
    });
    Object.assign(win, { parent: win });
    const transport = resolveEmbedTransport(win as never, null);
    transport?.post({ ping: 1 });
    expect(sent).toEqual([{ ping: 1 }]);
    const event = (source: unknown, origin: string) =>
      Object.assign(new Event("message"), { source, origin }) as MessageEvent;
    expect(transport?.accepts(event(win, ORIGIN))).toBe(true);
    expect(transport?.accepts(event({}, ORIGIN))).toBe(false);
    expect(transport?.accepts(event(win, "null"))).toBe(false);
  });

  it("initializes with the parent at its origin, ignores other senders, and queues reports until initialized", async () => {
    const { win, posted, deliver, answer } = makeFrameWindow();
    const bridge = startEmbedBridge(win);
    expect(startEmbedBridge(win)).toBe(bridge);
    expect(readEmbedBridge()).toBe(bridge);
    bridge?.reportThread("thread-1");
    bridge?.reportTurnState("thread-1", "running");

    expect(posted).toEqual([
      {
        message: expect.objectContaining({ method: "ui/initialize" }),
        targetOrigin: PARENT_ORIGIN,
      },
    ]);

    const initializeId = posted[0]?.message.id;
    deliver({ jsonrpc: "2.0", id: initializeId, result: initializeResult }, { origin: ORIGIN });
    deliver({ jsonrpc: "2.0", id: initializeId, result: initializeResult }, { source: {} });
    await flushMicrotasks();
    expect(methods(posted)).toEqual(["ui/initialize"]);

    answer("ui/initialize", initializeResult);
    await flushMicrotasks();
    expect(bridge?.hostContext()).toEqual(initializeResult.hostContext);
    expect(methods(posted)).toEqual([
      "ui/initialize",
      "ui/notifications/initialized",
      "lecturn/thread.changed",
      "lecturn/turn.state",
    ]);
    expect(posted.every((entry) => entry.targetOrigin === PARENT_ORIGIN)).toBe(true);
  });

  it("sends thread and turn changes once each, and a thread change re-sends its turn state", async () => {
    const { win, posted, answer } = makeFrameWindow();
    const bridge = startEmbedBridge(win);
    answer("ui/initialize", initializeResult);
    await flushMicrotasks();
    posted.length = 0;

    bridge?.reportThread("thread-1");
    bridge?.reportThread("thread-1");
    bridge?.reportTurnState("thread-1", "idle");
    bridge?.reportTurnState("thread-1", "idle");
    bridge?.reportTurnState("thread-1", "awaiting-approval");
    bridge?.reportThread("thread-2");
    bridge?.reportTurnState("thread-2", "idle");
    bridge?.reportThread(null);

    expect(posted.map((entry) => [entry.message.method, entry.message.params])).toEqual([
      ["lecturn/thread.changed", { threadId: "thread-1" }],
      ["lecturn/turn.state", { threadId: "thread-1", state: "idle" }],
      ["lecturn/turn.state", { threadId: "thread-1", state: "awaiting-approval" }],
      ["lecturn/thread.changed", { threadId: "thread-2" }],
      ["lecturn/turn.state", { threadId: "thread-2", state: "idle" }],
      ["lecturn/thread.changed", { threadId: null }],
    ]);
  });

  it("passes host commands and context changes to subscribers", async () => {
    const { win, deliver, answer } = makeFrameWindow();
    const bridge = startEmbedBridge(win);
    const commands: unknown[] = [];
    const themes: unknown[] = [];
    bridge?.subscribeHostCommands((command) => commands.push(command));
    bridge?.subscribeHostContext((context) => themes.push(context.theme));
    answer("ui/initialize", initializeResult);
    await flushMicrotasks();

    deliver({ jsonrpc: "2.0", method: "lecturn/thread.open", params: { threadId: "thread-9" } });
    deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    });
    expect(commands).toEqual([{ method: "lecturn/thread.open", params: { threadId: "thread-9" } }]);
    expect(themes).toEqual(["dark", "light"]);
  });

  it.effect("asks the host for a new token before expiry, then reconnects with it", () =>
    Effect.gen(function* () {
      const { win, onPost, deliver, answer } = makeFrameWindow();
      startEmbedBridge(win);
      answer("ui/initialize", initializeResult);
      rememberEmbedTokenExpiry("tok-1", 120_000);

      const refreshRequested = yield* Deferred.make<unknown>();
      onPost.push((entry) => {
        if (entry.message.method === "lecturn/token.refresh") {
          Deferred.doneUnsafe(refreshRequested, Effect.succeed(entry.message.id));
        }
      });
      const wakeups = yield* Queue.unbounded<string>();
      yield* embedConnectionWakeups.pipe(
        Stream.runForEach((wakeup) => Queue.offer(wakeups, String(wakeup))),
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* TestClock.adjust(90_000);
      const requestId = yield* Deferred.await(refreshRequested);
      deliver({
        jsonrpc: "2.0",
        id: requestId,
        result: { token: "tok-2", expiresAt: "1970-01-01T00:10:00.000Z" },
      });

      expect(yield* Queue.take(wakeups)).toBe("application-active-reconnect");
      expect(readEmbedToken()).toBe("tok-2");
    }),
  );
});
