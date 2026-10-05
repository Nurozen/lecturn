import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
    animated: boolean;
    bounds: { x: number; y: number; width: number; height: number };
    webContents: { mainFrame: { url: string }; send: ReturnType<typeof vi.fn> };
  }>,
  cursor: { x: 600, y: 10 },
  enabled: true,
  reducedMotion: false,
  trayDestroyed: false,
  idleSeconds: 0,
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
    animated = false;
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
    setBounds(bounds: typeof this.bounds, animated = false) {
      this.bounds = bounds;
      this.animated = animated;
    }
    isFocused() {
      return this.focused;
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
    systemPreferences: {
      getAnimationSettings: () => ({ prefersReducedMotion: state.reducedMotion }),
    },
    nativeImage: { createFromBuffer: () => ({ setTemplateImage() {} }) },
    powerMonitor: { getSystemIdleTime: () => state.idleSeconds },
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

const offer = (event: IpcMainInvokeEvent, change: unknown) =>
  invoke(Channels.ACTIVITY_ANNOUNCE, event, {
    change,
    revision: (invoke(Channels.ACTIVITY_READ, event) as { revision: number }).revision,
  });

beforeEach(() => {
  state.windows.length = 0;
  state.handlers.clear();
  state.cursor = { x: 600, y: 10 };
  state.enabled = true;
  state.reducedMotion = false;
  state.trayDestroyed = false;
  state.idleSeconds = 0;
});
describe("Mac activity alerts while the user is present", () => {
  const blocked = {
    id: "thread",
    environmentId: "e",
    projectId: "p",
    threadId: "t",
    title: "Thread",
    subtitle: "Project",
    status: "Needs input",
    actions: [],
  };
  const change = { rowId: "thread", state: "attention", label: "Thread · Needs attention" };
  const setup = () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    const mainWindow = state.windows[0]!;
    mainWindow.visible = true;
    mainWindow.focused = true;
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), { summary: "1 thread", rows: [blocked] });
    const announced = () =>
      panel.webContents.send.mock.calls.filter(
        ([channel]) => channel === Channels.ACTIVITY_ANNOUNCE,
      );
    return { main, mainWindow, panel, dispose, announced, event: eventFor(panel as never) };
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the alert while Lecturn is in use and fires it once on blur", () => {
    const { mainWindow, panel, dispose, announced, event } = setup();
    expect(offer(event, change)).toBe(false);
    expect(panel.bounds.height).toBe(38);
    mainWindow.focused = false;
    mainWindow.emit("blur");
    expect(announced()).toEqual([
      [Channels.ACTIVITY_ANNOUNCE, expect.objectContaining({ change })],
    ]);
    mainWindow.emit("blur");
    mainWindow.emit("hide");
    expect(announced()).toHaveLength(1);
    dispose();
  });

  it.each([false, true])(
    "holds a passed PR job independently of its running siblings (job restarted: %s)",
    (restarted) => {
      const { main, mainWindow, dispose, event, announced } = setup();
      const watched = {
        ...blocked,
        watchId: "watch",
        status: "Running checks",
        visualState: "active",
        checks: [
          { name: "Web", status: "success" },
          { name: "Server", status: "pending" },
        ],
      };
      invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), { summary: "PR", rows: [watched] });
      const jobChange = {
        rowId: blocked.id,
        state: "complete",
        label: "Web passed",
        check: { name: "Web", status: "success" },
      };
      expect(offer(event, jobChange)).toBe(false);
      // Subsequent snapshots and another job starting must not erase this held completion.
      invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), {
        summary: "PR",
        rows: [
          {
            ...watched,
            checks: [
              { name: "Web", status: restarted ? "pending" : "success" },
              { name: "Server", status: "pending" },
            ],
          },
        ],
      });
      offer(event, {
        rowId: blocked.id,
        state: "active",
        label: "Server started",
        check: { name: "Server", status: "pending" },
      });
      mainWindow.focused = false;
      mainWindow.emit("blur");
      expect(announced()).toEqual(
        restarted
          ? []
          : [[Channels.ACTIVITY_ANNOUNCE, expect.objectContaining({ change: jobChange })]],
      );
      dispose();
    },
  );

  it("leaves hover and click expansion alone while the user is present", () => {
    const { panel, dispose, event } = setup();
    invoke(Channels.ACTIVITY_MODE, event, "hover-enter");
    expect(panel.bounds.height).toBeGreaterThan(38);
    invoke(Channels.ACTIVITY_MODE, event, "expand");
    expect(panel.bounds.height).toBe(588);
    dispose();
  });

  it("fires immediately when Lecturn is in the background or the user is idle", () => {
    const { mainWindow, dispose, event } = setup();
    state.idleSeconds = 45;
    expect(offer(event, change)).toBe(true);
    state.idleSeconds = 0;
    mainWindow.focused = false;
    expect(offer(event, change)).toBe(true);
    dispose();
  });

  it("fires a held alert once the user goes idle, then stops polling", () => {
    vi.useFakeTimers();
    const { dispose, announced, event } = setup();
    expect(vi.getTimerCount()).toBe(0);
    offer(event, change);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(announced()).toHaveLength(0);
    state.idleSeconds = 45;
    vi.advanceTimersByTime(5_000);
    expect(announced()).toEqual([
      [Channels.ACTIVITY_ANNOUNCE, expect.objectContaining({ change })],
    ]);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it("skips a held alert the user resolved before looking away", () => {
    const { main, mainWindow, dispose, announced, event } = setup();
    offer(event, change);
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), {
      summary: "1 thread",
      rows: [{ ...blocked, status: "Working" }],
    });
    mainWindow.focused = false;
    mainWindow.emit("blur");
    expect(announced()).toHaveLength(0);
    dispose();
  });

  it("does not fire on blur for a held thread the user opened in Lecturn first", () => {
    const { main, mainWindow, dispose, announced, event } = setup();
    offer(event, change);
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), {
      summary: "1 thread",
      rows: [blocked],
      viewedThread: { environmentId: "e", threadId: "t" },
    });
    mainWindow.focused = false;
    mainWindow.emit("blur");
    expect(announced()).toHaveLength(0);
    dispose();
  });

  it("stops holding and polling when the window is disposed", () => {
    vi.useFakeTimers();
    const { panel, dispose, event } = setup();
    offer(event, change);
    const send = panel.webContents.send;
    dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalledWith(Channels.ACTIVITY_ANNOUNCE, expect.anything());
  });

  it("rejects an announcement queued before its thread was opened", () => {
    vi.useFakeTimers();
    const { main, mainWindow, dispose, event, announced } = setup();
    const { revision } = invoke(Channels.ACTIVITY_READ, event) as { revision: number };
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), {
      summary: "1 thread",
      rows: [blocked],
      viewedThread: { environmentId: "e", threadId: "t" },
    });
    expect(invoke(Channels.ACTIVITY_ANNOUNCE, event, { change, revision })).toBe(false);
    expect(offer(event, change)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), { summary: "1 thread", rows: [blocked] });
    mainWindow.focused = false;
    mainWindow.emit("blur");
    expect(announced()).toHaveLength(0);
    dispose();
  });

  it.each(["removed", "not-ready", "reload", "crash"])(
    "forgets held alerts and stops polling on %s, even if cached rows return",
    (reason) => {
      vi.useFakeTimers();
      const { main, mainWindow, dispose, event, announced } = setup();
      offer(event, change);
      expect(vi.getTimerCount()).toBe(1);
      if (reason === "reload" || reason === "crash") {
        main.webContents.emit(reason === "reload" ? "did-start-loading" : "render-process-gone");
      } else {
        invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), {
          summary: "Reconnecting",
          rows: reason === "removed" ? [] : [blocked],
          readyEnvironmentIds: [],
        });
      }
      expect(vi.getTimerCount()).toBe(0);
      invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), { summary: "1 thread", rows: [blocked] });
      mainWindow.focused = false;
      mainWindow.emit("blur");
      expect(announced()).toHaveLength(0);
      dispose();
    },
  );
});
describe("Mac activity lifecycle", () => {
  it("animates visible mode changes while respecting reduced motion and immediate startup", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    expect(panel.animated).toBe(false);
    const event = {
      sender: panel.webContents,
      senderFrame: panel.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    invoke(Channels.ACTIVITY_MODE, event, "hover-enter");
    expect(panel.bounds.height).toBeGreaterThan(38);
    expect(panel.animated).toBe(true);
    invoke(Channels.ACTIVITY_MODE, event, "expand");
    expect(panel.bounds.height).toBe(588);
    expect(panel.animated).toBe(true);
    state.reducedMotion = true;
    invoke(Channels.ACTIVITY_MODE, event, "dismiss");
    expect(panel.bounds.height).toBe(38);
    expect(panel.animated).toBe(false);
    dispose();
  });
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

describe("foreground chat previews", () => {
  it("opens peek at the filtered height and animates subsequent count changes", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    main.show();
    main.focus();
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), {
      summary: "Activity",
      viewedThread: { environmentId: "env", threadId: "current" },
      rows: ["current", "other"].map((id) => ({
        id,
        threadId: id,
        environmentId: "env",
        projectId: "project",
        title: id,
        subtitle: "",
        status: "Working",
        actions: [],
      })),
    });
    const event = {
      sender: panel.webContents,
      senderFrame: panel.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    invoke(Channels.ACTIVITY_MODE, event, "hover-enter");
    expect(panel.bounds.height).toBe(163);
    expect(panel.animated).toBe(true);
    invoke(Channels.ACTIVITY_PEEK_COUNT, event, 2);
    expect(panel.bounds.height).toBe(241);
    expect(panel.animated).toBe(true);
    dispose();
  });
  it("keeps a current-chat-only notch collapsed on hover but allows manual expansion", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    main.show();
    main.focus();
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), {
      summary: "Activity",
      viewedThread: { environmentId: "env", threadId: "thread" },
      rows: [
        {
          id: "current",
          environmentId: "env",
          projectId: "project",
          threadId: "thread",
          title: "Current chat",
          subtitle: "",
          status: "Working",
          actions: [],
        },
      ],
    });
    const panelEvent = {
      sender: panel.webContents,
      senderFrame: panel.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    invoke(Channels.ACTIVITY_MODE, panelEvent, "hover-enter");
    expect(panel.bounds.height).toBe(38);
    invoke(Channels.ACTIVITY_MODE, panelEvent, "expand");
    expect(panel.bounds.height).toBe(588);
    dispose();
  });
  it("publishes the viewed chat only while the main application is visible and focused", () => {
    const main = new BrowserWindow();
    const dispose = installDesktopActivity(main, options);
    const panel = state.windows[1]!;
    panel.emit("ready-to-show");
    const current = { environmentId: "env", threadId: "thread" };
    invoke(Channels.ACTIVITY_PUBLISH, eventFor(main), {
      summary: "Activity",
      rows: [],
      viewedThread: current,
    });
    expect(panel.webContents.send).toHaveBeenLastCalledWith(Channels.ACTIVITY_SNAPSHOT, {
      summary: "Activity",
      rows: [],
      revision: expect.any(Number),
    });
    main.show();
    main.focus();
    main.emit("focus");
    expect(panel.webContents.send).toHaveBeenLastCalledWith(
      Channels.ACTIVITY_SNAPSHOT,
      expect.objectContaining({ viewedThread: current }),
    );
    state.windows[0]!.focused = false;
    main.emit("blur");
    expect(panel.webContents.send).toHaveBeenLastCalledWith(Channels.ACTIVITY_SNAPSHOT, {
      summary: "Activity",
      rows: [],
      revision: expect.any(Number),
    });
    main.focus();
    main.hide();
    main.emit("hide");
    expect(panel.webContents.send).toHaveBeenLastCalledWith(Channels.ACTIVITY_SNAPSHOT, {
      summary: "Activity",
      rows: [],
      revision: expect.any(Number),
    });
    dispose();
    expect(main.listenerCount("focus")).toBe(0);
    expect(main.listenerCount("blur")).toBe(0);
  });
});
