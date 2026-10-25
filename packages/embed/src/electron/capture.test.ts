import { describe, expect, it, vi } from "vite-plus/test";

const fakes = vi.hoisted(() => {
  type Listener = (...args: Array<any>) => void;
  class Emitter {
    readonly listeners = new Map<string, Set<Listener>>();
    on(event: string, listener: Listener) {
      const set = this.listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(event, set);
      return this;
    }
    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }
    off(event: string, listener: Listener) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    emit(event: string, ...args: Array<unknown>) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  type Responder = (method: string, params: unknown) => Promise<unknown>;
  const journal: Array<string> = [];

  class FakeDebugger extends Emitter {
    attached = false;
    attachCount = 0;
    commands: Array<{ method: string; params: unknown }> = [];
    respond: Responder = async () => ({});
    isAttached() {
      return this.attached;
    }
    attach() {
      if (this.attached) throw new Error("Debugger is already attached to the target");
      this.attached = true;
      this.attachCount += 1;
      journal.push("attach");
    }
    detach() {
      this.attached = false;
      this.emit("detach", {}, "target closed");
    }
    sendCommand(method: string, params?: unknown) {
      if (!this.attached) return Promise.reject(new Error("Debugger is not attached"));
      this.commands.push({ method, params });
      journal.push(method);
      return this.respond(method, params);
    }
  }

  class FakeWebContents extends Emitter {
    readonly debugger = new FakeDebugger();
    readonly ipc = new Emitter();
    readonly sent: Array<{ channel: string; message: unknown }> = [];
    send(channel: string, message: unknown) {
      this.sent.push({ channel, message });
    }
    destroyed = false;
    crashed = false;
    zoomFactor = 1.5;
    readonly loads: Array<string> = [];
    isDestroyed() {
      return this.destroyed;
    }
    isCrashed() {
      return this.crashed;
    }
    setZoomFactor(factor: number) {
      this.zoomFactor = factor;
    }
    loadURL(url: string) {
      this.loads.push(url);
      journal.push(`load ${url}`);
      this.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
      this.emit("loaded");
      return Promise.resolve();
    }
    nextLoad() {
      return new Promise<void>((resolve) => this.once("loaded", resolve));
    }
    close() {
      this.destroyed = true;
      if (this.debugger.attached) this.debugger.detach();
      this.emit("destroyed");
    }
    crash() {
      this.crashed = true;
      this.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    }
  }

  class FakeWebContentsView {
    static created: Array<FakeWebContentsView> = [];
    readonly webContents = new FakeWebContents();
    readonly options: { webPreferences: Record<string, unknown> };
    bounds: unknown;
    visible = true;
    constructor(options: { webPreferences: Record<string, unknown> }) {
      this.options = options;
      FakeWebContentsView.created.push(this);
    }
    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }
    setVisible(visible: boolean) {
      this.visible = visible;
    }
  }

  class FakeWindow extends Emitter {
    readonly webContents = new FakeWebContents();
    readonly children = new Set<unknown>();
    readonly contentView = {
      addChildView: (view: unknown) => this.children.add(view),
      removeChildView: (view: unknown) => this.children.delete(view),
      get children(): Array<unknown> {
        return [];
      },
    };
  }

  const ipcMain = new Emitter();
  const openedLinks: Array<string> = [];
  const shell = {
    openExternal: async (url: string) => {
      openedLinks.push(url);
    },
  };

  return { FakeWebContentsView, FakeWindow, journal, ipcMain, openedLinks, shell };
});

vi.mock("electron", () => ({
  WebContentsView: fakes.FakeWebContentsView,
  ipcMain: fakes.ipcMain,
  shell: fakes.shell,
}));

import type * as Electron from "electron";

import { captureEmbedView } from "./capture.ts";
import { EmbedViewError } from "./errors.ts";
import { mountEmbedView, type MountEmbedViewOptions } from "./mountEmbedView.ts";

const PNG_BASE64 = Buffer.from("fake-png").toString("base64");
const ORIGIN_A = "http://127.0.0.1:41001";
const ORIGIN_B = "http://127.0.0.1:41002";
const TOKEN_HASH = "#embedToken=embed-token";

function deferred<A = void>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function mount(overrides: Partial<MountEmbedViewOptions> = {}) {
  fakes.journal.length = 0;
  const win = new fakes.FakeWindow();
  let origin = ORIGIN_A;
  const target = {
    embedTarget: async (projectId: string, threadId?: string) => ({
      url: `${origin}/embed/env-1/${projectId}${threadId ? `/${threadId}` : ""}`,
      token: "embed-token",
      expiresAt: "2026-10-24T00:15:00.000Z",
    }),
  };
  const created = fakes.FakeWebContentsView.created.length;
  const bridge = mountEmbedView(
    win as unknown as Electron.BaseWindow,
    {
      target,
      projectId: "project-1",
      theme: "dark",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      ...overrides,
    } as MountEmbedViewOptions,
  );
  const view = fakes.FakeWebContentsView.created[created]!;
  const wc = view.webContents;
  await wc.nextLoad();
  return {
    bridge,
    view,
    wc,
    win,
    useSecondOrigin: () => {
      origin = ORIGIN_B;
    },
  };
}

// Holds Page.captureScreenshot open so a test can act while the capture runs.
function holdScreenshot(wc: {
  debugger: { respond: (m: string, p: unknown) => Promise<unknown> };
}) {
  const requested = deferred();
  const release = deferred<unknown>();
  wc.debugger.respond = async (method) => {
    if (method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
    }
    if (method === "Page.captureScreenshot") {
      requested.resolve();
      return release.promise;
    }
    return {};
  };
  return { requested: requested.promise, release };
}

function respondNormally(wc: {
  debugger: { respond: (m: string, p: unknown) => Promise<unknown> };
}) {
  wc.debugger.respond = async (method) => {
    if (method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
    }
    if (method === "Page.captureScreenshot") return { data: PNG_BASE64 };
    return {};
  };
}

async function captureError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(EmbedViewError);
  return (error as EmbedViewError).reason;
}

describe("mountEmbedView", () => {
  it("isolates the guest: own partition, helper preload, no node, sandboxed", async () => {
    const { view, win } = await mount({
      webPreferences: { spellcheck: false, backgroundThrottling: false },
    });
    const prefs = view.options.webPreferences;
    expect(prefs["partition"]).toMatch(/^lecturn-embed-/);
    expect(prefs["preload"]).toMatch(/electron-preload\.cjs$/);
    expect(prefs).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    });
    expect(win.children.has(view)).toBe(true);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });

    const second = await mount();
    expect(second.view.options.webPreferences["partition"]).not.toBe(prefs["partition"]);
  });

  it("installs the frozen clock before the first load and keeps it through a retarget", async () => {
    const { bridge, view, wc, useSecondOrigin } = await mount({ freezeClock: 1_700_000_000_000 });
    const firstLoad = fakes.journal.indexOf(`load ${ORIGIN_A}/embed/env-1/project-1${TOKEN_HASH}`);
    expect(fakes.journal.indexOf("Page.addScriptToEvaluateOnNewDocument")).toBeLessThan(firstLoad);
    expect(fakes.journal.indexOf("attach")).toBeLessThan(firstLoad);

    useSecondOrigin();
    const generation = bridge.generation;
    await bridge.retarget("project-2", "thread-9");
    expect(wc.loads.at(-1)).toBe(`${ORIGIN_B}/embed/env-1/project-2/thread-9${TOKEN_HASH}`);
    expect(bridge.generation).toBeGreaterThan(generation);
    // Same view, same partition, same debugger session: the shim registration survives.
    expect(fakes.FakeWebContentsView.created.at(-1)).toBe(view);
    expect(wc.debugger.attachCount).toBe(1);
    expect(
      wc.debugger.commands.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument"),
    ).toHaveLength(1);
  });
});

const FROM_GUEST = "lecturn-embed:from-guest";
const TO_GUEST = "lecturn-embed:to-guest";
const INITIALIZED = { jsonrpc: "2.0", method: "ui/notifications/initialized" };

function fromGuest(
  wc: { ipc: { emit: (event: string, ...args: Array<unknown>) => void } },
  message: unknown,
  frame: { url: string; parent: unknown } = {
    url: `${ORIGIN_A}/embed/env-1/project-1`,
    parent: null,
  },
) {
  wc.ipc.emit(FROM_GUEST, { senderFrame: frame }, message);
}

const toGuest = (wc: { sent: Array<{ channel: string; message: any }> }) =>
  wc.sent.filter((entry) => entry.channel === TO_GUEST).map((entry) => entry.message);

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("mountEmbedView bridge", () => {
  it("answers the guest over the preload channel and holds host messages until it initializes", async () => {
    const { bridge, wc } = await mount();
    bridge.setDraft("hello");

    fromGuest(wc, {
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appCapabilities: { experimental: { lecturn: { version: 1 } } },
      },
    });
    await settle();
    expect(toGuest(wc)).toEqual([
      expect.objectContaining({
        id: 1,
        result: expect.objectContaining({
          hostContext: expect.objectContaining({ theme: "dark", displayMode: "inline" }),
        }),
      }),
    ]);

    fromGuest(wc, INITIALIZED);
    expect(toGuest(wc).at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "lecturn/composer.setDraft",
      params: { text: "hello" },
    });
  });

  it("only listens to the target's own top document", async () => {
    const { wc } = await mount();
    const ping = { jsonrpc: "2.0", id: 9, method: "lecturn/token.refresh" };
    fromGuest(wc, ping, { url: "https://elsewhere.example/page", parent: null });
    fromGuest(wc, ping, { url: `${ORIGIN_A}/card`, parent: {} });
    await settle();
    expect(toGuest(wc)).toEqual([]);
  });

  it("refreshes through the connection and follows the guest's thread", async () => {
    const minted: Array<string> = [];
    const connection = {
      embedTarget: async (projectId: string, threadId?: string) => {
        minted.push(`target ${projectId} ${threadId ?? "-"}`);
        return {
          url: `${ORIGIN_A}/embed/env-1/${projectId}`,
          token: "embed-token",
          expiresAt: "2026-10-24T00:15:00.000Z",
        };
      },
      refreshEmbedToken: async (projectId: string) => {
        minted.push(`refresh ${projectId}`);
        return {
          url: `${ORIGIN_A}/embed/env-1/${projectId}`,
          token: "refreshed",
          expiresAt: "2026-10-24T00:30:00.000Z",
        };
      },
    };
    const { bridge, wc } = await mount({ connection, target: undefined } as never);
    const changed: Array<unknown> = [];
    bridge.on("lecturn/thread.changed", (params) => changed.push(params));

    const before = bridge.generation;
    fromGuest(wc, {
      jsonrpc: "2.0",
      method: "lecturn/thread.changed",
      params: { threadId: "thread-3" },
    });
    expect(bridge.generation).toBeGreaterThan(before);
    expect(changed).toEqual([{ threadId: "thread-3" }]);

    fromGuest(wc, { jsonrpc: "2.0", id: "r", method: "lecturn/token.refresh" });
    await settle();
    expect(toGuest(wc).at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "r",
      result: { token: "refreshed", expiresAt: "2026-10-24T00:30:00.000Z" },
    });
    expect(minted).toEqual(["target project-1 -", "refresh project-1"]);
  });

  it("moves the view to the pane its host page reports and ignores other senders", async () => {
    const { view, win } = await mount();
    fakes.ipcMain.emit(
      "lecturn-embed:pane-rect",
      { sender: {} },
      { x: 1, y: 1, width: 1, height: 1 },
    );
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });

    fakes.ipcMain.emit(
      "lecturn-embed:pane-rect",
      { sender: win.webContents },
      { x: 320.4, y: 40, width: 879.6, height: -5 },
    );
    expect(view.bounds).toEqual({ x: 320, y: 40, width: 880, height: 0 });
  });

  it("forwards the host page's bridge messages and reports invalid ones", async () => {
    const { bridge, wc, win } = await mount();
    const errors: Array<string> = [];
    bridge.on("error", (error) => errors.push(error.reason));
    fromGuest(wc, INITIALIZED);

    fakes.ipcMain.emit(
      "lecturn-embed:bridge",
      { sender: win.webContents },
      { method: "lecturn/composer.insertMention", params: { ref: "ex:item/1", label: "Item 1" } },
    );
    fakes.ipcMain.emit(
      "lecturn-embed:bridge",
      { sender: win.webContents },
      { method: "ui/initialize" },
    );

    expect(toGuest(wc).at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "lecturn/composer.insertMention",
      params: { ref: "ex:item/1", label: "Item 1" },
    });
    expect(errors).toEqual(["bridge-message-rejected"]);
    bridge.destroy();
  });
});

describe("captureEmbedView", () => {
  it("captures at DPR 1 with zoom reset and the guest blurred", async () => {
    const { bridge, wc } = await mount();
    respondNormally(wc);
    const png = await captureEmbedView(bridge);
    expect(png.toString()).toBe("fake-png");
    expect(wc.zoomFactor).toBe(1);
    const methods = wc.debugger.commands.map((c) => c.method);
    expect(methods).toEqual([
      "Runtime.evaluate",
      "Page.getLayoutMetrics",
      "Emulation.setDeviceMetricsOverride",
      "Page.captureScreenshot",
      "Emulation.clearDeviceMetricsOverride",
    ]);
    expect(wc.debugger.commands[2]!.params).toEqual({
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
  });

  it("retries a cold guest that has no frame yet", async () => {
    const { bridge, wc } = await mount();
    let screenshots = 0;
    wc.debugger.respond = async (method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === "Page.captureScreenshot") {
        screenshots += 1;
        return { data: screenshots === 1 ? "" : PNG_BASE64 };
      }
      return {};
    };
    const png = await captureEmbedView(bridge, { retryDelayMs: 0 });
    expect(png.toString()).toBe("fake-png");
    expect(screenshots).toBe(2);
  });

  it("drops the capture when the guest is destroyed mid-capture", async () => {
    const { bridge, wc } = await mount();
    const hold = holdScreenshot(wc);
    const capture = captureEmbedView(bridge);
    await hold.requested;
    wc.close();
    hold.release.resolve({ data: PNG_BASE64 });
    expect(await captureError(capture)).toBe("guest-gone");
  });

  it("drops the capture when the guest switches threads mid-capture", async () => {
    const { bridge, wc } = await mount();
    const hold = holdScreenshot(wc);
    const capture = captureEmbedView(bridge);
    await hold.requested;
    wc.emit("did-start-navigation", {
      url: `${ORIGIN_A}/embed/env-1/project-1/thread-2`,
      isMainFrame: true,
      isSameDocument: true,
    });
    hold.release.resolve({ data: PNG_BASE64 });
    expect(await captureError(capture)).toBe("stale-capture");
  });

  it("drops the capture on a retarget and captures the new origin afterwards", async () => {
    const { bridge, wc, useSecondOrigin } = await mount();
    const hold = holdScreenshot(wc);
    const capture = captureEmbedView(bridge);
    await hold.requested;
    useSecondOrigin();
    const retargeted = bridge.retarget("project-2");
    hold.release.resolve({ data: PNG_BASE64 });
    expect(await captureError(capture)).toBe("stale-capture");
    await retargeted;

    respondNormally(wc);
    expect((await captureEmbedView(bridge)).toString()).toBe("fake-png");
    expect(wc.loads.at(-1)).toBe(`${ORIGIN_B}/embed/env-1/project-2${TOKEN_HASH}`);
    expect(wc.debugger.attachCount).toBe(1);
  });

  it("reports a renderer crash mid-capture as a gone guest", async () => {
    const { bridge, wc } = await mount();
    const errors: Array<string> = [];
    bridge.on("error", (error) => errors.push(error.reason));
    const hold = holdScreenshot(wc);
    const capture = captureEmbedView(bridge, { retryDelayMs: 0 });
    await hold.requested;
    wc.crash();
    hold.release.reject(new Error("Target crashed"));
    expect(await captureError(capture)).toBe("guest-gone");
    expect(errors).toEqual(["renderer-gone"]);
  });

  it("refuses to capture a closed view and closing mid-capture drops it", async () => {
    const { bridge, wc, view, win } = await mount();
    const hold = holdScreenshot(wc);
    const capture = captureEmbedView(bridge);
    await hold.requested;
    win.emit("closed");
    hold.release.resolve({ data: PNG_BASE64 });
    expect(await captureError(capture)).toBe("guest-gone");
    expect(win.children.has(view)).toBe(false);
    expect(wc.destroyed).toBe(true);

    const commandsBefore = wc.debugger.commands.length;
    expect(await captureError(captureEmbedView(bridge))).toBe("guest-gone");
    expect(wc.debugger.commands.length).toBe(commandsBefore);
    expect(await captureError(bridge.retarget("project-1"))).toBe("guest-gone");
  });

  it("refuses a second debugger client instead of fighting over the guest", async () => {
    const { bridge, wc } = await mount();
    respondNormally(wc);
    wc.debugger.attach();
    expect(await captureError(captureEmbedView(bridge))).toBe("debugger-unavailable");
    expect(wc.debugger.commands).toHaveLength(0);
  });

  it("serializes overlapping captures so their emulation overrides do not interleave", async () => {
    const { bridge, wc } = await mount();
    respondNormally(wc);
    await Promise.all([captureEmbedView(bridge), captureEmbedView(bridge)]);
    const methods = wc.debugger.commands.map((c) => c.method);
    const firstClear = methods.indexOf("Emulation.clearDeviceMetricsOverride");
    expect(methods.lastIndexOf("Emulation.setDeviceMetricsOverride")).toBeGreaterThan(firstClear);
    expect(wc.debugger.attachCount).toBe(1);
  });
});
