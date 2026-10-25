import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import * as Electron from "electron";

import type { EmbedTargetSource } from "../target.ts";
import { EmbedViewError } from "./errors.ts";
import { freezeClockScript } from "./freezeClock.ts";

// The helper owns every key that decides what the guest can reach: its own
// partition keeps Lecturn session cookies away from embed-token requests, and
// its preload is the only one that guarantees no desktopBridge exists.
export type EmbedWebPreferences = Omit<
  Electron.WebPreferences,
  | "preload"
  | "partition"
  | "session"
  | "contextIsolation"
  | "sandbox"
  | "nodeIntegration"
  | "nodeIntegrationInSubFrames"
  | "nodeIntegrationInWorker"
  | "webviewTag"
>;

interface MountEmbedViewBaseOptions {
  readonly projectId: string;
  readonly threadId?: string;
  readonly theme: "light" | "dark";
  readonly bounds: Electron.Rectangle;
  readonly switcher?: boolean;
  readonly webPreferences?: EmbedWebPreferences;
  /** Test only: pins the guest's Date to this epoch millisecond value. */
  readonly freezeClock?: number;
}

export type MountEmbedViewOptions = MountEmbedViewBaseOptions &
  (
    | { readonly connection: EmbedTargetSource; readonly target?: never }
    | { readonly target: EmbedTargetSource; readonly connection?: never }
  );

export interface EmbedDebuggerSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface EmbedBridge {
  readonly webContents: Electron.WebContents;
  /** The one CDP session for this guest; Electron allows a single debugger client. */
  readonly debuggerSession: EmbedDebuggerSession;
  /** Bumped on every navigation, reload, crash, retarget and destroy; captures compare it. */
  readonly generation: number;
  setBounds(bounds: Electron.Rectangle): void;
  setVisible(visible: boolean): void;
  retarget(projectId: string, threadId?: string): Promise<void>;
  on(event: "error", listener: (error: EmbedViewError) => void): () => void;
  destroy(): void;
}

const CDP_PROTOCOL_VERSION = "1.3";

// Packed, this module and the CommonJS preload are siblings in dist/.
const embedPreloadPath = () =>
  NodeURL.fileURLToPath(new URL("./electron-preload.cjs", import.meta.url));

export function mountEmbedView(
  win: Electron.BaseWindow,
  options: MountEmbedViewOptions,
): EmbedBridge {
  const source = options.connection ?? options.target;
  const view = new Electron.WebContentsView({
    webPreferences: {
      ...options.webPreferences,
      partition: `lecturn-embed-${NodeCrypto.randomUUID()}`,
      preload: embedPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
    },
  });
  const webContents = view.webContents;
  const errorListeners = new Set<(error: EmbedViewError) => void>();
  let generation = 0;
  let destroyed = false;
  let attached = false;
  let attaching: Promise<void> | undefined;
  let loadSeq = 0;

  const emitError = (error: EmbedViewError) => {
    for (const listener of errorListeners) listener(error);
  };
  const isGone = () => destroyed || webContents.isDestroyed();

  const attach = async () => {
    if (isGone()) throw new EmbedViewError("guest-gone", "The embed view was destroyed.");
    if (webContents.debugger.isAttached()) {
      throw new EmbedViewError(
        "debugger-unavailable",
        "Another CDP client is attached to the embed guest. Use bridge.debuggerSession; Electron allows one debugger client per webContents.",
      );
    }
    try {
      webContents.debugger.attach(CDP_PROTOCOL_VERSION);
    } catch (cause) {
      throw new EmbedViewError("debugger-unavailable", "Could not attach to the embed guest.", {
        cause,
      });
    }
    attached = true;
    if (options.freezeClock === undefined) return;
    const script = freezeClockScript(options.freezeClock);
    try {
      await webContents.debugger.sendCommand("Page.enable");
      await webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: script,
      });
      // A re-attach lands on a live document that the new-document hook missed.
      await webContents.debugger.sendCommand("Runtime.evaluate", { expression: script });
    } catch (cause) {
      if (webContents.debugger.isAttached()) webContents.debugger.detach();
      attached = false;
      throw new EmbedViewError("debugger-unavailable", "Could not install the frozen clock.", {
        cause,
      });
    }
  };
  const ensureAttached = (): Promise<void> => {
    if (attached) return Promise.resolve();
    attaching ??= attach().finally(() => {
      attaching = undefined;
    });
    return attaching;
  };

  const navigate = async (projectId: string, threadId: string | undefined) => {
    const seq = ++loadSeq;
    generation += 1;
    const isCurrent = () => seq === loadSeq && !isGone();
    try {
      const target = await source.embedTarget(projectId, threadId);
      if (!isCurrent()) return;
      // The shim must be registered before the first document of the target exists.
      if (options.freezeClock !== undefined) await ensureAttached();
      if (!isCurrent()) return;
      await webContents.loadURL(target.url);
    } catch (cause) {
      if (!isCurrent()) return;
      throw cause instanceof EmbedViewError
        ? cause
        : new EmbedViewError("load-failed", "The embed view could not load its target.", {
            cause,
          });
    }
  };

  webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame) generation += 1;
  });
  webContents.on("render-process-gone", (_event, details) => {
    generation += 1;
    emitError(
      new EmbedViewError("renderer-gone", `The embed guest renderer exited (${details.reason}).`),
    );
  });
  webContents.debugger.on("detach", () => {
    attached = false;
  });

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    loadSeq += 1;
    errorListeners.clear();
    win.off("closed", destroy);
    if (!webContents.isDestroyed()) {
      win.contentView.removeChildView(view);
      if (attached && webContents.debugger.isAttached()) webContents.debugger.detach();
      // A WebContentsView does not free its webContents when removed.
      webContents.close();
    }
  };
  win.once("closed", destroy);

  win.contentView.addChildView(view);
  view.setBounds(options.bounds);
  navigate(options.projectId, options.threadId).catch((error: EmbedViewError) => emitError(error));

  return {
    webContents,
    debuggerSession: {
      send: async (method, params) => {
        await ensureAttached();
        return webContents.debugger.sendCommand(method, params);
      },
    },
    get generation() {
      return generation;
    },
    setBounds: (bounds) => view.setBounds(bounds),
    setVisible: (visible) => view.setVisible(visible),
    retarget: (projectId, threadId) => {
      if (isGone()) {
        return Promise.reject(new EmbedViewError("guest-gone", "The embed view was destroyed."));
      }
      return navigate(projectId, threadId);
    },
    on: (_event, listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    destroy,
  };
}
