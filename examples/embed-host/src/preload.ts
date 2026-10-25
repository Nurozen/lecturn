import { exposeEmbedRendererIpc } from "@lecturn/embed/renderer";
import { contextBridge, ipcRenderer } from "electron";

// lecturn:begin
exposeEmbedRendererIpc({ contextBridge, ipcRenderer });
// lecturn:end

export interface EmbedHostUi {
  onStatus(listener: (text: string) => void): void;
  onFocus(listener: (ref: string) => void): void;
}

const ui: EmbedHostUi = {
  onStatus: (listener) => {
    ipcRenderer.on("embed-host:status", (_event, text: string) => listener(text));
  },
  onFocus: (listener) => {
    ipcRenderer.on("embed-host:focus", (_event, ref: string) => listener(ref));
  },
};
contextBridge.exposeInMainWorld("embedHostUi", ui);
