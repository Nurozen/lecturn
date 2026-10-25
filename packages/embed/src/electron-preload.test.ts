import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { EMBED_GUEST_HOST_GLOBAL, EMBED_TO_GUEST_CHANNEL } from "./channels.ts";

const exposed = new Map<string, unknown>();
const ipcListeners = new Map<string, (event: unknown, message: unknown) => void>();
const sent: Array<{ channel: string; message: unknown }> = [];

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed.set(key, api);
      Reflect.set(globalThis.window, key, api);
    },
  },
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, message: unknown) => void) =>
      ipcListeners.set(channel, listener),
    send: (channel: string, message: unknown) => sent.push({ channel, message }),
  },
}));

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

// The web app picks hash history and its desktop code paths whenever `window.desktopBridge`
// exists (apps/web/src/env.ts), which would break `/embed/...` paths and the token in the hash.
describe("embed guest preload", () => {
  it("exposes only the embed host bridge and never a desktopBridge", async () => {
    const posted: Array<{ message: unknown; origin: string }> = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:3773" },
        postMessage: (message: unknown, origin: string) => posted.push({ message, origin }),
      },
    });

    await import("./electron-preload.ts");

    expect([...exposed.keys()]).toEqual([EMBED_GUEST_HOST_GLOBAL]);
    expect(Reflect.get(globalThis.window, "desktopBridge")).toBeUndefined();

    const { postMessage: sendToHost } = exposed.get(EMBED_GUEST_HOST_GLOBAL) as {
      postMessage: (message: unknown) => void;
    };
    sendToHost({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(sent).toHaveLength(1);
    ipcListeners.get(EMBED_TO_GUEST_CHANNEL)?.({}, { jsonrpc: "2.0", method: "x" });
    expect(posted).toEqual([
      { message: { jsonrpc: "2.0", method: "x" }, origin: "http://127.0.0.1:3773" },
    ]);
  });
});
