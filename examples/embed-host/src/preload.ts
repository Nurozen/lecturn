import { exposeEmbedRendererIpc } from "@lecturn/embed/renderer";
import { contextBridge, ipcRenderer } from "electron";

import type { PaneHeaderState } from "./paneHeader.ts";

// lecturn:begin
exposeEmbedRendererIpc({ contextBridge, ipcRenderer });
// lecturn:end

export interface EmbedHostUi {
  onStatus(listener: (text: string) => void): void;
  onFocus(listener: (ref: string) => void): void;
  onPaneHeader(listener: (state: PaneHeaderState) => void): void;
  openInLecturn(): void;
  openPaneMenu(at: { readonly x: number; readonly y: number }): void;
}

const ui: EmbedHostUi = {
  onStatus: (listener) => {
    ipcRenderer.on("embed-host:status", (_event, text: string) => listener(text));
  },
  onFocus: (listener) => {
    ipcRenderer.on("embed-host:focus", (_event, ref: string) => listener(ref));
  },
  onPaneHeader: (listener) => {
    ipcRenderer.on("embed-host:pane-header", (_event, state: PaneHeaderState) => listener(state));
  },
  openInLecturn: () => ipcRenderer.send("embed-host:open-in-lecturn"),
  openPaneMenu: (at) => ipcRenderer.send("embed-host:pane-menu", { x: at.x, y: at.y }),
};
contextBridge.exposeInMainWorld("embedHostUi", ui);
