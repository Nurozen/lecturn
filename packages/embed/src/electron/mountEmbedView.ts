// @effect-diagnostics nodeBuiltinImport:off -- Runs in the host's Electron main process, which has no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import type {
  EmbedHostNotificationParams,
  EmbedTokenRefreshResult,
} from "@lecturn/contracts/embedBridge";
import * as Electron from "electron";

import {
  EMBED_FROM_GUEST_CHANNEL,
  EMBED_HOST_BRIDGE_CHANNEL,
  EMBED_PANE_RECT_CHANNEL,
  EMBED_TO_GUEST_CHANNEL,
} from "../channels.ts";
import { embedGuestUrl } from "../embedUrl.ts";
import {
  type EmbedConnectionSource,
  type EmbedTargetSource,
  followConnectionMode,
} from "../target.ts";
import { isExternalLink } from "../embedUrl.ts";
import { EmbedViewError } from "./errors.ts";
import { freezeClockScript } from "./freezeClock.ts";
import {
  assertHostContextFits,
  createEmbedHostSession,
  type EmbedBridgeEvent,
  type EmbedBridgeEvents,
  type EmbedDescribeRefs,
  type EmbedThemeInput,
  hostContextFor,
} from "./hostBridge.ts";

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
  readonly theme: EmbedThemeInput;
  /** Replaces the idle composer prompt (up to 200 characters); without it Lecturn's own shows. */
  readonly composerPlaceholder?: string;
  readonly bounds: Electron.Rectangle;
  readonly switcher?: boolean;
  readonly webPreferences?: EmbedWebPreferences;
  /**
   * Names the references a thread shows that no message stored a name for, such as ones the agent
   * wrote. Without it, or for a reference it leaves out, the chip shows the reference itself.
   */
  readonly onDescribeRefs?: EmbedDescribeRefs;
  /** Test only: pins the guest's Date to this epoch millisecond value. */
  readonly freezeClock?: number;
}

export type MountEmbedViewOptions = MountEmbedViewBaseOptions &
  (
    | { readonly connection: EmbedConnectionSource; readonly target?: never }
    | { readonly target: EmbedTargetSource; readonly connection?: never }
  );

export interface EmbedDebuggerSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

type BridgeListener<E extends EmbedBridgeEvent | "error"> = (
  payload: E extends EmbedBridgeEvent ? EmbedBridgeEvents[E] : EmbedViewError,
) => void;

export interface EmbedBridge {
  readonly webContents: Electron.WebContents;
  /** The one CDP session for this guest; Electron allows a single debugger client. */
  readonly debuggerSession: EmbedDebuggerSession;
  /** Bumped on every navigation, reload, crash, thread switch, retarget and destroy; captures compare it. */
  readonly generation: number;
  insertMention(params: EmbedHostNotificationParams<"lecturn/composer.insertMention">): void;
  setDraft(text: string): void;
  openThread(threadId: string): void;
  newThread(params?: EmbedHostNotificationParams<"lecturn/thread.new">): void;
  openProviders(): void;
  setTheme(theme: EmbedThemeInput): void;
  /** Null hands the idle composer prompt back to Lecturn's wording. */
  setComposerPlaceholder(placeholder: string | null): void;
  setBounds(bounds: Electron.Rectangle): void;
  setVisible(visible: boolean): void;
  retarget(projectId: string, threadId?: string): Promise<void>;
  on<E extends EmbedBridgeEvent | "error">(event: E, listener: BridgeListener<E>): () => void;
  destroy(): void;
}

const CDP_PROTOCOL_VERSION = "1.3";

// Packed, this module and the CommonJS preload are siblings in dist/.
const embedPreloadPath = () =>
  NodeURL.fileURLToPath(new URL("./electron-preload.cjs", import.meta.url));

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const hasRefresh = (source: EmbedTargetSource): source is EmbedConnectionSource =>
  typeof (source as Partial<EmbedConnectionSource>).refreshEmbedToken === "function";

const readRect = (value: unknown): Electron.Rectangle | null => {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  const finite = (field: unknown): field is number =>
    typeof field === "number" && Number.isFinite(field);
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  };
};

/** net::ERR_ABORTED */
const ABORTED = -3;

export function mountEmbedView(
  win: Electron.BaseWindow,
  options: MountEmbedViewOptions,
): EmbedBridge {
  const source: EmbedTargetSource = options.connection ?? options.target;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  let theme = options.theme;
  let composerPlaceholder = options.composerPlaceholder ?? null;
  const initialContext = hostContextFor(theme, locale, composerPlaceholder);
  assertHostContextFits(initialContext);

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
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let generation = 0;
  let destroyed = false;
  let attached = false;
  let attaching: Promise<void> | undefined;
  let loadSeq = 0;
  let projectId = options.projectId;
  let threadId = options.threadId;
  let guestOrigin: string | null = null;

  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) (listener as (p: unknown) => void)(payload);
  };
  const emitError = (error: EmbedViewError) => emit("error", error);
  const isGone = () => destroyed || webContents.isDestroyed();

  const refreshToken = async (): Promise<EmbedTokenRefreshResult> => {
    const target = hasRefresh(source)
      ? await source.refreshEmbedToken(projectId)
      : await source.embedTarget(projectId, threadId);
    return { token: target.token, expiresAt: target.expiresAt };
  };

  const session = createEmbedHostSession(initialContext, {
    send: (message) => {
      if (!isGone()) webContents.send(EMBED_TO_GUEST_CHANNEL, message);
    },
    refreshToken,
    openLink: async (url) => {
      if (!isExternalLink(url)) {
        throw new Error("Only http, https and lecturn links open outside the embed view.");
      }
      await Electron.shell.openExternal(url);
    },
    ...(options.onDescribeRefs === undefined ? {} : { describeRefs: options.onDescribeRefs }),
    emit: (event, payload) => {
      if (event === "lecturn/thread.changed") {
        const changed = payload as EmbedBridgeEvents["lecturn/thread.changed"];
        const next = changed.threadId ?? undefined;
        if (next !== threadId) {
          threadId = next;
          generation += 1;
        }
      }
      emit(event, payload);
    },
    emitError,
  });

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
      // A view that never navigated has no renderer, and CDP commands to it never answer.
      if (webContents.getURL() === "") await webContents.loadURL("about:blank");
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

  // Electron rejects a loadURL with the abort of the earlier load it replaced
  // (a retarget while the first target is still loading), while the new load
  // carries on; it has loaded once loading stops with the guest on this URL.
  const loadGuest = async (url: string) => {
    try {
      await webContents.loadURL(url);
    } catch (cause) {
      const failed = cause as { readonly errno?: unknown; readonly url?: unknown };
      if (failed.errno !== ABORTED || failed.url === url || isGone()) throw cause;
      if (webContents.isLoading()) {
        await new Promise<void>((resolve) => {
          webContents.once("did-stop-loading", () => resolve());
          webContents.once("destroyed", () => resolve());
        });
      }
      const withoutHash = (value: string) => value.split("#")[0];
      if (isGone() || withoutHash(webContents.getURL()) !== withoutHash(url)) throw cause;
    }
  };

  const navigate = async (nextProjectId: string, nextThreadId: string | undefined) => {
    const seq = ++loadSeq;
    generation += 1;
    projectId = nextProjectId;
    threadId = nextThreadId;
    session.clearQueue();
    const isCurrent = () => seq === loadSeq && !isGone();
    try {
      const target = await source.embedTarget(nextProjectId, nextThreadId);
      if (!isCurrent()) return;
      // The shim must be registered before the first document of the target exists.
      if (options.freezeClock !== undefined) await ensureAttached();
      if (!isCurrent()) return;
      guestOrigin = originOf(target.url);
      await loadGuest(
        embedGuestUrl(target.url, target.token, { switcher: options.switcher !== false }),
      );
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
    if (!details.isMainFrame) return;
    generation += 1;
    if (!details.isSameDocument) session.resetDocument();
  });
  webContents.on("render-process-gone", (_event, details) => {
    generation += 1;
    session.resetDocument();
    emitError(
      new EmbedViewError("renderer-gone", `The embed guest renderer exited (${details.reason}).`),
    );
  });
  webContents.debugger.on("detach", () => {
    attached = false;
  });

  // Only the guest's own top document may speak for it; a page it navigated
  // to must not be able to ask for a fresh embed token.
  const onGuestMessage = (event: Electron.IpcMainEvent, message: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || guestOrigin === null) return;
    if (originOf(frame.url) !== guestOrigin) return;
    session.handleGuestMessage(message);
  };
  webContents.ipc.on(EMBED_FROM_GUEST_CHANNEL, onGuestMessage);

  // The host renderer reports its pane in its own coordinates; a host page in
  // a child view of a BaseWindow sits at that view's offset.
  const hostOffset = (sender: Electron.WebContents): { x: number; y: number } | null => {
    if (sender === webContents) return null;
    if ("webContents" in win && (win as Electron.BrowserWindow).webContents === sender) {
      return { x: 0, y: 0 };
    }
    for (const child of win.contentView.children) {
      if ("webContents" in child && (child as Electron.WebContentsView).webContents === sender) {
        const bounds = child.getBounds();
        return { x: bounds.x, y: bounds.y };
      }
    }
    return null;
  };
  const onPaneRect = (event: Electron.IpcMainEvent, value: unknown) => {
    const offset = hostOffset(event.sender);
    const rect = readRect(value);
    if (offset === null || rect === null || isGone()) return;
    view.setBounds({ ...rect, x: rect.x + offset.x, y: rect.y + offset.y });
  };
  const onHostBridge = (event: Electron.IpcMainEvent, message: unknown) => {
    if (hostOffset(event.sender) === null || isGone()) return;
    try {
      session.notifyUnknown(message);
    } catch (error) {
      emitError(
        error instanceof EmbedViewError
          ? error
          : new EmbedViewError("bridge-message-rejected", "The bridge message was rejected.", {
              cause: error,
            }),
      );
    }
  };
  Electron.ipcMain.on(EMBED_PANE_RECT_CHANNEL, onPaneRect);
  Electron.ipcMain.on(EMBED_HOST_BRIDGE_CHANNEL, onHostBridge);

  // Hosts that mount from a connection need no code for a live switch.
  const stopFollowing =
    options.connection === undefined
      ? () => undefined
      : followConnectionMode(
          options.connection,
          () => ({ projectId, threadId }),
          (nextProjectId, nextThreadId) => {
            if (isGone()) return;
            navigate(nextProjectId, nextThreadId).catch((error: EmbedViewError) =>
              emitError(error),
            );
          },
        );

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    stopFollowing();
    generation += 1;
    loadSeq += 1;
    listeners.clear();
    win.off("close", onWindowClose);
    win.off("closed", destroy);
    Electron.ipcMain.off(EMBED_PANE_RECT_CHANNEL, onPaneRect);
    Electron.ipcMain.off(EMBED_HOST_BRIDGE_CHANNEL, onHostBridge);
    if (!webContents.isDestroyed()) {
      webContents.ipc.off(EMBED_FROM_GUEST_CHANNEL, onGuestMessage);
      if (attached && webContents.debugger.isAttached()) webContents.debugger.detach();
      win.contentView.removeChildView(view);
      // A WebContentsView does not free its webContents when removed.
      webContents.close();
    }
  };
  // While this view's webContents is alive the window emits `close` but never
  // `closed`, so app.quit hangs; the view has to go as soon as closing is
  // certain. A veto from a `close` listener added after mounting runs too
  // late to be seen here.
  const onWindowClose = (event: Electron.Event) => {
    if (!event.defaultPrevented) destroy();
  };
  win.on("close", onWindowClose);
  win.once("closed", destroy);

  win.contentView.addChildView(view);
  view.setBounds(options.bounds);
  navigate(options.projectId, options.threadId).catch((error: EmbedViewError) => emitError(error));

  const requireLive = () => {
    if (isGone()) throw new EmbedViewError("guest-gone", "The embed view was destroyed.");
  };

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
    insertMention: (params) => {
      requireLive();
      session.notify("lecturn/composer.insertMention", params);
    },
    setDraft: (text) => {
      requireLive();
      session.notify("lecturn/composer.setDraft", { text });
    },
    openThread: (nextThreadId) => {
      requireLive();
      session.notify("lecturn/thread.open", { threadId: nextThreadId });
    },
    newThread: (params = {}) => {
      requireLive();
      session.notify("lecturn/thread.new", params);
    },
    openProviders: () => {
      requireLive();
      session.notify("lecturn/providers.open", {});
    },
    setTheme: (next) => {
      requireLive();
      session.setHostContext(hostContextFor(next, locale, composerPlaceholder));
      theme = next;
    },
    setComposerPlaceholder: (next) => {
      requireLive();
      session.setHostContext(hostContextFor(theme, locale, next));
      composerPlaceholder = next;
    },
    setBounds: (bounds) => view.setBounds(bounds),
    setVisible: (visible) => view.setVisible(visible),
    retarget: (nextProjectId, nextThreadId) => {
      if (isGone()) {
        return Promise.reject(new EmbedViewError("guest-gone", "The embed view was destroyed."));
      }
      return navigate(nextProjectId, nextThreadId);
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(event, set);
      return () => set.delete(listener as (payload: never) => void);
    },
    destroy,
  };
}
