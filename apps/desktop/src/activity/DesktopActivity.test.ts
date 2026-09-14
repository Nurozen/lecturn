import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BrowserWindow, screen, type IpcMainInvokeEvent } from "electron";
import { installDesktopActivity } from "./DesktopActivity.ts";
import * as Channels from "./channels.ts";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>(),
  windows: [] as Array<{
    emit: (name: string) => void;
    destroyed: boolean;
    visible: boolean;
    focused: boolean;
    focusable: boolean;
    bounds: { x: number; y: number; width: number; height: number };
    webContents: { mainFrame: { url: string }; send: ReturnType<typeof vi.fn> };
  }>,
  cursor: { x: 600, y: 10 },
  enabled: true,
  trayDestroyed: false,
}));
vi.mock("electron-store", () => ({
  default: class {
    get() {
      return state.enabled;
    }
    set(_key: string, value: boolean) {
      state.enabled = value;
    }
  },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWindow extends EventEmitter {
    destroyed = false;
    visible = false;
    focused = false;
    focusable = false;
    bounds = { x: 0, y: 0, width: 900, height: 600 };
    private contents = Object.assign(new EventEmitter(), {
      id: state.windows.length + 1,
      mainFrame: { url: "lecturn://app/" },
      send: vi.fn(),
      isLoadingMainFrame: () => false,
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn() },
    });
    get webContents() {
      if (this.destroyed) throw new Error("Object has been destroyed");
      return this.contents;
    }
    constructor() {
      super();
      state.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    getBounds() {
      if (this.destroyed) throw new Error("Object has been destroyed");
      return this.bounds;
    }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds;
    }
    isVisible() {
      return this.visible;
    }
    setFocusable(value: boolean) {
      this.focusable = value;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    showInactive() {
      this.visible = true;
    }
    show() {
      this.visible = true;
    }
    focus() {
      this.focused = true;
    }
    hide() {
      this.visible = false;
    }
    destroy() {
      this.destroyed = true;
      this.emit("blur");
      this.emit("closed");
    }
    async loadURL(url: string) {
      this.webContents.mainFrame.url = url;
    }
  }
  const display = {
    id: 1,
    internal: true,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 889 },
  };
  return {
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (template: unknown) => template },
    Tray: class {
      setTitle() {}
      setToolTip() {}
      setContextMenu() {}
      destroy() {
        state.trayDestroyed = true;
      }
    },
    ipcMain: {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown) =>
        state.handlers.set(channel, handler),
      removeHandler: (channel: string) => state.handlers.delete(channel),
    },
    nativeImage: { createFromBuffer: () => ({ setTemplateImage() {} }) },
    screen: Object.assign(new EventEmitter(), {
      getCursorScreenPoint: () => state.cursor,
      getAllDisplays: () => [display],
      getDisplayMatching: () => display,
    }),
  };
});
const options = {
  platform: "darwin",
  preloadPath: "/activity-preload.cjs",
  applicationUrl: "lecturn://app/",
};
const eventFor = (window: BrowserWindow) =>
  ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }) as IpcMainInvokeEvent;
const invoke = (channel: string, event: IpcMainInvokeEvent, value?: unknown) =>
  state.handlers.get(channel)!(event, value);

beforeEach(() => {
  state.windows.length = 0;
  state.handlers.clear();
  state.cursor = { x: 600, y: 10 };
  state.enabled = true;
  state.trayDestroyed = false;
});
describe("Mac activity lifecycle", () => {
  it("shows automatic micro activity without stealing focus and focuses only after interaction", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    const event = {
      sender: panel.webContents,
      senderFrame: panel.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    invoke(Channels.ACTIVITY_MODE, event, "micro-open");
    expect(panel.bounds.height).toBe(298);
    expect(panel.visible).toBe(true);
    expect(panel.focused).toBe(false);
    expect(panel.focusable).toBe(false);
    invoke(Channels.ACTIVITY_MODE, event, "micro-interact");
    expect(panel.focused).toBe(true);
    expect(panel.focusable).toBe(true);
    state.cursor = { x: 200, y: 500 };
    panel.emit("blur");
    expect(panel.bounds.height).toBe(38);
    invoke(Channels.ACTIVITY_MODE, event, "expand");
    invoke(Channels.ACTIVITY_MODE, event, "micro-open");
    expect(panel.bounds.height).toBe(588);
    dispose();
  });
  it("opens the main app without navigation or changing the current panel mode", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    const event = {
      sender: panel.webContents,
      senderFrame: panel.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    invoke(Channels.ACTIVITY_MODE, event, "expand");
    vi.mocked(main.webContents.send).mockClear();
    invoke(Channels.ACTIVITY_OPEN_APP, event);
    state.cursor = { x: 200, y: 500 };
    panel.emit("blur");
    expect(panel.bounds.height).toBe(588);
    expect(state.windows[0]!.visible).toBe(true);
    expect(main.webContents.send).not.toHaveBeenCalledWith(
      Channels.ACTIVITY_ACTION,
      expect.anything(),
    );
    expect(() => invoke(Channels.ACTIVITY_OPEN_APP, eventFor(main))).toThrow("Untrusted");
    expect(() => invoke(Channels.ACTIVITY_MODE, eventFor(main), "micro-open")).toThrow("Untrusted");
    dispose();
  });
  it("closes after an accepted open action but keeps a rejected action visible", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    const event = {
      sender: panel.webContents,
      senderFrame: panel.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const row = {
      id: "thread",
      environmentId: "e",
      projectId: "p",
      threadId: "t",
      title: "Thread",
      subtitle: "Project",
      status: "Idle",
      actions: [{ id: "open", label: "Open thread" }],
    };
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), { summary: "1 thread", rows: [row] });
    invoke(Channels.ACTIVITY_MODE, event, "expand");
    const action = {
      rowId: "thread",
      environmentId: "e",
      projectId: "p",
      threadId: "wrong",
      kind: "open",
    };
    expect(() => invoke(Channels.ACTIVITY_ACTION, event, action)).toThrow("no longer available");
    expect(panel.bounds.height).toBe(588);
    invoke(Channels.ACTIVITY_ACTION, event, { ...action, threadId: "t" });
    expect(panel.bounds.height).toBe(38);
    expect(state.windows[0]!.visible).toBe(true);
    dispose();
  });
  it("keeps manual expansion focused through pointer exits and interior blur, then collapses on outside focus loss", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    const event = {
      sender: panel.webContents,
      senderFrame: panel.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    invoke(Channels.ACTIVITY_MODE, event, "hover-enter");
    expect(panel.bounds.height).toBe(163);
    expect(panel.focused).toBe(false);
    invoke(Channels.ACTIVITY_MODE, event, "toggle");
    expect(panel.focused).toBe(true);
    expect(panel.focusable).toBe(true);
    expect(panel.bounds.height).toBe(588);
    invoke(Channels.ACTIVITY_MODE, event, "hover-leave");
    panel.emit("blur");
    expect(panel.bounds.height).toBe(588);
    state.cursor = { x: 200, y: 500 };
    panel.emit("blur");
    expect(panel.bounds.height).toBe(38);
    expect(panel.focusable).toBe(false);
    expect(() => invoke(Channels.ACTIVITY_MODE, eventFor(main), "expand")).toThrow("Untrusted");
    dispose();
  });
  it("reveals the main app when a merge handoff requires choosing an agent", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    const row = {
      id: "pr",
      environmentId: "e",
      projectId: "p",
      watchId: "w",
      title: "PR",
      subtitle: "repo",
      status: "unassigned",
      actions: [{ id: "merge", label: "Choose agent" }],
    };
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), { summary: "1 PR", rows: [row] });
    expect(state.windows[0]!.visible).toBe(false);
    invoke(
      Channels.ACTIVITY_ACTION,
      {
        sender: panel.webContents,
        senderFrame: panel.webContents.mainFrame,
      } as unknown as IpcMainInvokeEvent,
      {
        rowId: row.id,
        environmentId: "e",
        projectId: "p",
        watchId: "w",
        kind: "merge",
      },
    );
    expect(state.windows[0]!.visible).toBe(true);
    dispose();
  });
  it("never allocates a window, tray or handlers on other platforms", () => {
    const main = new BrowserWindow();
    installDesktopActivity(main, { ...options, platform: "linux" })();
    expect(state.windows).toHaveLength(1);
    expect(state.handlers.size).toBe(0);
  });
  it("publishes through the main client, clears stale actions after renderer reload, and disposes listeners", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    expect(panel.visible).toBe(true);
    const snapshot = {
      summary: "1 PR",
      rows: [
        {
          id: "r",
          environmentId: "e",
          projectId: "p",
          watchId: "w",
          title: "CI failed",
          subtitle: "repo",
          status: "failed",
          actions: [{ id: "watch", label: "Watch" }],
        },
      ],
    };
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), snapshot);
    const panelEvent = {
      sender: panel.webContents,
      senderFrame: panel.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const action = { rowId: "r", environmentId: "e", projectId: "p", watchId: "w", kind: "watch" };
    invoke(Channels.ACTIVITY_ACTION, panelEvent, action);
    expect(main.webContents.send).toHaveBeenCalledWith(Channels.ACTIVITY_ACTION, action);
    expect(() => invoke(Channels.ACTIVITY_PUBLISH, panelEvent, snapshot)).toThrow("Untrusted");
    main.webContents.emit("did-start-loading");
    expect(() => invoke(Channels.ACTIVITY_ACTION, panelEvent, action)).toThrow(
      "no longer available",
    );
    dispose();
    dispose();
    expect(panel.destroyed).toBe(true);
    expect(state.trayDestroyed).toBe(true);
    expect(state.handlers.size).toBe(0);
    expect(screen.listenerCount("display-removed")).toBe(0);
    expect(main.listenerCount("move")).toBe(0);
  });
  it("cleans up after main destruction and ignores late placement and panel lifecycle events", () => {
    const main = new BrowserWindow();
    const contents = main.webContents;
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    main.destroy();
    expect(() => main.webContents).toThrow("Object has been destroyed");
    expect(() => {
      screen.emit("display-metrics-changed");
      main.emit("move");
      panel.emit("blur");
      dispose();
      dispose();
      panel.emit("blur");
      panel.emit("ready-to-show");
    }).not.toThrow();
    expect(panel.destroyed).toBe(true);
    expect(state.trayDestroyed).toBe(true);
    expect(state.windows).toHaveLength(2);
    expect(state.handlers.size).toBe(0);
    expect(contents.listenerCount("did-start-loading")).toBe(0);
    expect(contents.listenerCount("render-process-gone")).toBe(0);
    expect(screen.listenerCount("display-metrics-changed")).toBe(0);
  });
  it("persists hide and supports re-enabling without replacing the isolated surface", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    invoke(Channels.ACTIVITY_SET_ENABLED, eventFor(main), false);
    expect(state.enabled).toBe(false);
    expect(main.webContents.send).toHaveBeenCalledWith(Channels.ACTIVITY_ENABLED_CHANGED, false);
    expect(panel.visible).toBe(false);
    expect(invoke(Channels.ACTIVITY_ENABLED, eventFor(main))).toBe(false);
    invoke(Channels.ACTIVITY_SET_ENABLED, eventFor(main), true);
    expect(panel.visible).toBe(true);
    expect(state.windows).toHaveLength(2);
    dispose();
  });
});
