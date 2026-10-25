import { contextBridge, ipcRenderer } from "electron";

import {
  EMBED_FROM_GUEST_CHANNEL,
  EMBED_GUEST_HOST_GLOBAL,
  EMBED_TO_GUEST_CHANNEL,
} from "./channels.ts";

// The guest is the Lecturn web app in embed mode. This preload deliberately
// defines no desktopBridge, so the web app never takes its desktop code paths
// or reaches desktop IPC. Host messages reach the page as same-origin
// postMessage events, the shape the embed guest already listens for.
ipcRenderer.on(EMBED_TO_GUEST_CHANNEL, (_event, message: unknown) => {
  window.postMessage(message, window.location.origin);
});

// Posting to `window` would also echo back into the guest's own listener, so
// guest messages leave through a dedicated function instead.
contextBridge.exposeInMainWorld(EMBED_GUEST_HOST_GLOBAL, {
  postMessage: (message: unknown) => ipcRenderer.send(EMBED_FROM_GUEST_CHANNEL, message),
});
