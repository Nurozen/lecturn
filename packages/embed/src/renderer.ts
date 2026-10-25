import type {
  EmbedHostNotificationMethod,
  EmbedHostNotificationParams,
} from "@lecturn/contracts/embedBridge";

import {
  EMBED_HOST_BRIDGE_CHANNEL,
  EMBED_IPC_CHANNEL_PREFIX,
  EMBED_PANE_RECT_CHANNEL,
  EMBED_RENDERER_IPC_GLOBAL,
} from "./channels.ts";

export { EMBED_IPC_CHANNEL_PREFIX, EMBED_RENDERER_IPC_GLOBAL } from "./channels.ts";

export interface EmbedRendererIpc {
  send(channel: string, payload: unknown): void;
}

/** Structural so this entry never imports electron; pass the preload's own objects. */
export interface EmbedPreloadElectron {
  readonly contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  readonly ipcRenderer: { send(channel: string, ...args: Array<unknown>): void };
}

/**
 * Call from the host window's preload. A sandboxed, context-isolated page
 * cannot reach ipcRenderer, so this exposes a sender limited to the embed
 * channels.
 */
export function exposeEmbedRendererIpc({ contextBridge, ipcRenderer }: EmbedPreloadElectron) {
  const ipc: EmbedRendererIpc = {
    send: (channel, payload) => {
      if (typeof channel === "string" && channel.startsWith(EMBED_IPC_CHANNEL_PREFIX)) {
        ipcRenderer.send(channel, payload);
      }
    },
  };
  contextBridge.exposeInMainWorld(EMBED_RENDERER_IPC_GLOBAL, ipc);
}

function rendererIpc(): EmbedRendererIpc {
  const ipc = (globalThis as Record<string, unknown>)[EMBED_RENDERER_IPC_GLOBAL] as
    | EmbedRendererIpc
    | undefined;
  if (!ipc || typeof ipc.send !== "function") {
    throw new Error(
      `@lecturn/embed/renderer needs window.${EMBED_RENDERER_IPC_GLOBAL}; call exposeEmbedRendererIpc in the window's preload.`,
    );
  }
  return ipc;
}

/**
 * Keeps the embed view over `el`. Returns a function that stops reporting.
 * The rect is in CSS pixels of this page, which match window DIPs at zoom 1.
 */
export function reportPaneRect(el: Element): () => void {
  const ipc = rendererIpc();
  let last = "";
  let frame: number | null = null;
  const report = () => {
    frame = null;
    const rect = el.getBoundingClientRect();
    const next = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const key = `${next.x},${next.y},${next.width},${next.height}`;
    if (key === last) return;
    last = key;
    ipc.send(EMBED_PANE_RECT_CHANNEL, next);
  };
  // Batched to one report per frame, so a window drag does not flood IPC.
  const schedule = () => {
    frame ??= requestAnimationFrame(report);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(el);
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  report();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

export type EmbedHostMessage = {
  [M in EmbedHostNotificationMethod]: {
    readonly method: M;
    readonly params: EmbedHostNotificationParams<M>;
  };
}[EmbedHostNotificationMethod];

/** Forwards a host notification to the embed guest of this window, through the main process. */
export function sendBridge(message: EmbedHostMessage): void {
  rendererIpc().send(EMBED_HOST_BRIDGE_CHANNEL, message);
}
