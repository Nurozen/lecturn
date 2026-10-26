import { describe, expect, it } from "vite-plus/test";

import { mountEmbed, type MountEmbedOptions } from "./browser.ts";

const HOST_ORIGIN = "http://127.0.0.1:5173";
const GUEST_ORIGIN = "http://127.0.0.1:3773";
const TARGET_URL = `${GUEST_ORIGIN}/embed/env-1/project-1/thread-1`;

const initialize = (id: string) => ({
  jsonrpc: "2.0",
  id,
  method: "ui/initialize",
  params: {
    protocolVersion: "2026-01-26",
    appCapabilities: { experimental: { lecturn: { version: 1 } } },
  },
});
const initialized = { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} };

/** Just enough DOM for the helper: a window, a document, a container and the frame it makes. */
function harness(overrides: Partial<MountEmbedOptions> = {}) {
  const posted: Array<{ message: any; targetOrigin: string }> = [];
  const guestWindow = {
    postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }),
  };
  const opened: string[] = [];
  const win = Object.assign(new EventTarget(), {
    location: { origin: HOST_ORIGIN },
    open: (url: string) => {
      opened.push(url);
      return null;
    },
  });
  const iframe = {
    src: "",
    title: "",
    hidden: false,
    style: { cssText: "" },
    attributes: new Map<string, string>(),
    contentWindow: guestWindow as unknown,
    removed: false,
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    remove() {
      this.removed = true;
    },
  };
  const appended: unknown[] = [];
  const doc = { defaultView: win, createElement: () => iframe };
  const container = { ownerDocument: doc, appendChild: (node: unknown) => appended.push(node) };
  const refreshes: number[] = [];
  const bridge = mountEmbed(container as unknown as HTMLElement, {
    url: TARGET_URL,
    token: "tok-1",
    theme: "dark",
    onTokenRefresh: async () => {
      refreshes.push(1);
      return { token: "tok-2", expiresAt: "2026-10-25T01:00:00.000Z" };
    },
    ...overrides,
  });
  const fromGuest = (data: unknown, from: { source?: unknown; origin?: string } = {}) =>
    win.dispatchEvent(
      Object.assign(new Event("message"), {
        data,
        source: "source" in from ? from.source : guestWindow,
        origin: from.origin ?? GUEST_ORIGIN,
      }),
    );
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const handshake = async (id = "guest-1") => {
    fromGuest(initialize(id));
    await settled();
    fromGuest(initialized);
  };
  return { bridge, iframe, appended, posted, opened, refreshes, fromGuest, settled, handshake };
}

describe("mountEmbed", () => {
  it("frames the target with the token, parent origin and switcher flag in the hash only", () => {
    const { iframe, appended } = harness({ switcher: false });
    const src = new URL(iframe.src);
    expect(`${src.origin}${src.pathname}${src.search}`).toBe(TARGET_URL);
    const hash = new URLSearchParams(src.hash.slice(1));
    expect(hash.get("embedToken")).toBe("tok-1");
    expect(hash.get("parentOrigin")).toBe(HOST_ORIGIN);
    expect(hash.get("switcher")).toBe("0");
    expect(appended).toEqual([iframe]);
  });

  it("holds host commands until the guest initializes, then posts them to the guest origin only", async () => {
    const { bridge, posted, handshake } = harness();
    bridge.insertMention({ ref: "rw:c/fins", label: "Fins" });
    bridge.newThread({ title: "Fin study", appData: '{"doc":"a"}' });
    expect(posted).toEqual([]);

    await handshake();
    expect(posted.map((entry) => entry.message.method ?? "result")).toEqual([
      "result",
      "lecturn/composer.insertMention",
      "lecturn/thread.new",
    ]);
    expect(posted[2]?.message.params).toEqual({ title: "Fin study", appData: '{"doc":"a"}' });
    expect(posted.every((entry) => entry.targetOrigin === GUEST_ORIGIN)).toBe(true);
  });

  it("sends the composer placeholder in the handshake, keeps it across theme changes and clears it", async () => {
    const { bridge, posted, handshake } = harness({ composerPlaceholder: "Ask for changes…" });
    await handshake();
    expect(posted[0]?.message.result.hostContext.composerPlaceholder).toBe("Ask for changes…");

    bridge.setTheme("light");
    expect(posted.at(-1)?.message.params).toEqual({ theme: "light" });
    bridge.setComposerPlaceholder(null);
    expect(posted.at(-1)?.message.params).toEqual({ theme: "light", composerPlaceholder: null });
    bridge.setComposerPlaceholder("Describe the change…");
    expect(posted.at(-1)?.message.params).toEqual({
      theme: "light",
      composerPlaceholder: "Describe the change…",
    });
    expect(() => bridge.setComposerPlaceholder("x".repeat(201))).toThrow(/composer placeholder/);
    bridge.setTheme("dark");
    expect(posted.at(-1)?.message.params).toEqual({ theme: "dark" });
  });

  it("leaves the placeholder out of the handshake when the host sets none", async () => {
    const { posted, handshake } = harness();
    await handshake();
    expect(posted[0]?.message.result.hostContext).not.toHaveProperty("composerPlaceholder");
  });

  it("ignores messages from other frames and other origins", async () => {
    const { posted, fromGuest, settled } = harness();
    fromGuest(initialize("x"), { source: {} });
    fromGuest(initialize("y"), { origin: "http://127.0.0.1:9999" });
    await settled();
    expect(posted).toEqual([]);
  });

  it("forwards guest events to listeners and stops after unsubscribe", async () => {
    const { bridge, fromGuest, handshake } = harness();
    const navigated: unknown[] = [];
    const ready: unknown[] = [];
    const off = bridge.on("lecturn/navigate", (params) => navigated.push(params));
    bridge.on("lecturn/ready", (params) => ready.push(params));
    await handshake();

    fromGuest({ jsonrpc: "2.0", method: "lecturn/navigate", params: { ref: "rw:c/fins" } });
    fromGuest({ jsonrpc: "2.0", method: "lecturn/ready", params: { threadId: "thread-1" } });
    off();
    fromGuest({ jsonrpc: "2.0", method: "lecturn/navigate", params: { ref: "rw:c/nose" } });
    expect(navigated).toEqual([{ ref: "rw:c/fins" }]);
    expect(ready).toEqual([{ threadId: "thread-1" }]);
  });

  it("answers token refreshes from the host's minter", async () => {
    const { posted, refreshes, fromGuest, settled, handshake } = harness();
    await handshake();
    fromGuest({ jsonrpc: "2.0", id: "guest-2", method: "lecturn/token.refresh", params: {} });
    await settled();
    expect(refreshes).toHaveLength(1);
    expect(posted.at(-1)?.message).toEqual({
      jsonrpc: "2.0",
      id: "guest-2",
      result: { token: "tok-2", expiresAt: "2026-10-25T01:00:00.000Z" },
    });
  });

  it("treats a second handshake as a reloaded guest that must initialize again", async () => {
    const { bridge, posted, fromGuest, settled, handshake } = harness();
    await handshake();
    fromGuest(initialize("guest-1"));
    await settled();
    posted.length = 0;
    bridge.setDraft("Check the fins");
    expect(posted).toEqual([]);
    fromGuest(initialized);
    expect(posted.map((entry) => entry.message.method)).toEqual(["lecturn/composer.setDraft"]);
  });

  it("retargets the same frame and drops what was queued for the old target", async () => {
    const { bridge, iframe, posted, handshake } = harness();
    bridge.setDraft("for the old thread");
    bridge.retarget({ url: `${GUEST_ORIGIN}/embed/env-2/project-9`, token: "tok-9" });
    expect(new URL(iframe.src).pathname).toBe("/embed/env-2/project-9");
    expect(new URLSearchParams(new URL(iframe.src).hash.slice(1)).get("embedToken")).toBe("tok-9");
    await handshake();
    expect(posted.map((entry) => entry.message.method ?? "result")).toEqual(["result"]);
  });

  it("opens only web links by default, and goes quiet once destroyed", async () => {
    const { bridge, iframe, posted, opened, fromGuest, settled, handshake } = harness();
    await handshake();
    fromGuest({
      jsonrpc: "2.0",
      id: "l1",
      method: "ui/open-link",
      params: { url: "https://a.test/" },
    });
    fromGuest({ jsonrpc: "2.0", id: "l2", method: "ui/open-link", params: { url: "file:///etc" } });
    await settled();
    expect(opened).toEqual(["https://a.test/"]);
    expect(posted.find((entry) => entry.message.id === "l2")?.message.error).toBeDefined();

    bridge.destroy();
    expect(iframe.removed).toBe(true);
    expect(() => bridge.setDraft("late")).toThrow(/destroyed/);
    posted.length = 0;
    fromGuest(initialize("guest-9"));
    await settled();
    expect(posted).toEqual([]);
  });
});
