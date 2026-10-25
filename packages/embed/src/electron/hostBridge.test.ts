import { EMBED_MAX_PENDING_REQUESTS } from "@lecturn/contracts/embedBridge";
import { describe, expect, it } from "vite-plus/test";

import { EmbedViewError } from "./errors.ts";
import { createEmbedHostSession, hostContextFor, type EmbedHostSessionDeps } from "./hostBridge.ts";

const context = hostContextFor("dark", "en-US");
const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "ui/initialize",
  params: {
    protocolVersion: "2026-01-26",
    appCapabilities: { experimental: { lecturn: { version: 1 } } },
  },
});
const initialized = { jsonrpc: "2.0", method: "ui/notifications/initialized" };

function harness(overrides: Partial<EmbedHostSessionDeps> = {}) {
  const sent: Array<any> = [];
  const events: Array<{ event: string; params: unknown }> = [];
  const errors: Array<EmbedViewError> = [];
  const session = createEmbedHostSession(context, {
    send: (message) => sent.push(message),
    refreshToken: async () => ({ token: "fresh", expiresAt: "2026-10-25T01:00:00.000Z" }),
    openLink: async () => {},
    emit: (event, params) => events.push({ event, params }),
    emitError: (error) => errors.push(error),
    ...overrides,
  });
  // Requests settle on the microtask queue; one macrotask drains them.
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  return { session, sent, events, errors, settled };
}

describe("embed host session", () => {
  it("answers ui/initialize and holds host notifications until the guest is initialized", async () => {
    const { session, sent, settled } = harness();
    session.notify("lecturn/composer.setDraft", { text: "draft" });
    session.notify("lecturn/thread.open", { threadId: "thread-1" });

    session.handleGuestMessage(initialize(1));
    await settled();
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          hostContext: context,
          hostCapabilities: { experimental: { lecturn: { version: 1 } } },
        },
      },
    ]);

    session.handleGuestMessage(initialized);
    expect(sent.slice(1).map((message) => message.method)).toEqual([
      "lecturn/composer.setDraft",
      "lecturn/thread.open",
    ]);

    session.notify("lecturn/providers.open", {});
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "lecturn/providers.open", params: {} });
  });

  it("starts the handshake again for a new document and drops replies meant for the old one", async () => {
    let release!: () => void;
    const { session, sent, settled } = harness({
      refreshToken: () =>
        new Promise((resolve) => {
          release = () => resolve({ token: "late", expiresAt: "2026-10-25T01:00:00.000Z" });
        }),
    });
    session.handleGuestMessage(initialized);
    session.handleGuestMessage({ jsonrpc: "2.0", id: 7, method: "lecturn/token.refresh" });

    session.resetDocument();
    release();
    await settled();
    session.notify("lecturn/composer.setDraft", { text: "after reload" });

    expect(sent).toEqual([]);
    session.handleGuestMessage(initialized);
    expect(sent.map((message) => message.method)).toEqual(["lecturn/composer.setDraft"]);
  });

  it("refreshes the embed token, and reports a failed refresh to both sides", async () => {
    const ok = harness();
    ok.session.handleGuestMessage({ jsonrpc: "2.0", id: "r1", method: "lecturn/token.refresh" });
    await ok.settled();
    expect(ok.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: "r1",
        result: { token: "fresh", expiresAt: "2026-10-25T01:00:00.000Z" },
      },
    ]);

    const failing = harness({ refreshToken: () => Promise.reject(new Error("sidecar gone")) });
    failing.session.handleGuestMessage({ jsonrpc: "2.0", id: 2, method: "lecturn/token.refresh" });
    await failing.settled();
    expect(failing.sent[0]).toMatchObject({ id: 2, error: { code: -32603 } });
    expect(failing.errors.map((error) => error.reason)).toEqual(["token-refresh-failed"]);
  });

  it("refuses unknown methods, bad params and requests past the pending cap", async () => {
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const { session, sent, settled } = harness({
      refreshToken: async () => {
        await gate;
        return { token: "t", expiresAt: "2026-10-25T01:00:00.000Z" };
      },
    });
    session.handleGuestMessage({ jsonrpc: "2.0", id: 1, method: "lecturn/unknown" });
    session.handleGuestMessage({ jsonrpc: "2.0", id: 2, method: "ui/initialize", params: {} });
    session.handleGuestMessage({ jsonrpc: "2.0", id: 3, method: "ui/open-link", params: {} });
    await settled();
    expect(sent.map((message) => [message.id, message.error?.code])).toEqual([
      [1, -32601],
      [2, -32602],
      [3, -32602],
    ]);

    sent.length = 0;
    for (let id = 0; id <= EMBED_MAX_PENDING_REQUESTS; id += 1) {
      session.handleGuestMessage({ jsonrpc: "2.0", id: 100 + id, method: "lecturn/token.refresh" });
    }
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 100 + EMBED_MAX_PENDING_REQUESTS,
        error: { code: -32603, message: "Too many pending requests." },
      },
    ]);
    releaseAll();
    await settled();
    expect(sent).toHaveLength(EMBED_MAX_PENDING_REQUESTS + 1);
  });

  it("forwards guest events with decoded params and drops malformed ones", () => {
    const { session, events } = harness();
    session.handleGuestMessage({
      jsonrpc: "2.0",
      method: "lecturn/navigate",
      params: { ref: "ex:item/1" },
    });
    session.handleGuestMessage({
      jsonrpc: "2.0",
      method: "lecturn/turn.state",
      params: { threadId: "t1", state: "running" },
    });
    session.handleGuestMessage({
      jsonrpc: "2.0",
      method: "lecturn/turn.state",
      params: { threadId: "t1", state: "exploded" },
    });
    session.handleGuestMessage({
      jsonrpc: "2.0",
      method: "lecturn/ready",
      params: { threadId: null },
    });
    session.handleGuestMessage({
      jsonrpc: "2.0",
      method: "lecturn/navigate",
      params: { ref: "x".repeat(300 * 1024) },
    });

    expect(events).toEqual([
      { event: "lecturn/navigate", params: { ref: "ex:item/1" } },
      { event: "lecturn/turn.state", params: { threadId: "t1", state: "running" } },
      { event: "lecturn/ready", params: { threadId: null } },
    ]);
  });

  it("rejects host messages the guest would refuse, before anything is sent", () => {
    const { session, sent } = harness();
    session.handleGuestMessage(initialized);

    expect(() => session.notify("lecturn/thread.open", { threadId: "" })).toThrow(EmbedViewError);
    expect(() => session.notifyUnknown({ method: "lecturn/token.refresh" })).toThrow(
      /not a host notification/,
    );
    session.notifyUnknown({
      method: "lecturn/composer.insertMention",
      params: { ref: "ex:a", label: "A" },
    });
    expect(sent.map((message) => message.method)).toEqual(["lecturn/composer.insertMention"]);
  });

  it("refuses a theme whose ui/initialize result would overflow the bridge, naming the size", () => {
    const { session, sent } = harness();
    session.handleGuestMessage(initialized);
    const fonts = (familyName: string) =>
      `@font-face { font-family: "${familyName}"; src: url(data:font/woff2;base64,AAAA); }`;

    session.setHostContext(
      hostContextFor({ theme: "light", styles: { css: { fonts: fonts("A") } } }, "en-US"),
    );
    expect(sent.at(-1)).toMatchObject({
      method: "ui/notifications/host-context-changed",
      params: { theme: "light", styles: { css: { fonts: fonts("A") } } },
    });

    // Within the 200 KB fonts cap as UTF-8, but JSON escaping doubles every quote.
    const escaped = hostContextFor(
      { theme: "dark", styles: { css: { fonts: fonts('"'.repeat(150 * 1024)) } } },
      "en-US",
    );
    expect(() => session.setHostContext(escaped)).toThrow(
      /is \d+ bytes; the limit is 262144 bytes/,
    );
    expect(sent.at(-1)?.params.theme).toBe("light");
  });
});
