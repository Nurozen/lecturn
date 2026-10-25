import type { LecturnConnection } from "@lecturn/embed/node";
import * as Electron from "electron";

type ThreadsEvent = Parameters<Parameters<LecturnConnection["subscribeThreads"]>[1]>[0];

/** What renderer/main.ts draws in the pane header. */
export interface PaneHeaderState {
  readonly title: string;
  readonly canOpenInLecturn: boolean;
}

/**
 * The host's own header above the Lecturn pane, as the embed adds none: the
 * open thread's title, kept from the same thread stream a host rail reads.
 */
export function makePaneHeader(win: Electron.BrowserWindow) {
  const titles = new Map<string, string>();
  let threadId: string | null = null;
  let threadUrl: (threadId: string) => string | null = () => null;

  const openUrl = () => (threadId === null ? null : threadUrl(threadId));
  const publish = () => {
    const state: PaneHeaderState = {
      title: (threadId === null ? undefined : titles.get(threadId)) ?? "New thread",
      canOpenInLecturn: openUrl() !== null,
    };
    if (!win.isDestroyed()) win.webContents.send("embed-host:pane-header", state);
  };
  let menuItems: ReadonlyArray<Electron.MenuItemConstructorOptions> = [];
  win.webContents.ipc.on("embed-host:open-in-lecturn", () => {
    const url = openUrl();
    if (url !== null) void Electron.shell.openExternal(url);
  });
  // Native, because a page menu would open under the embed view, which is a
  // separate layer drawn over the window's own page.
  win.webContents.ipc.on("embed-host:pane-menu", (_event, at: { x: number; y: number }) => {
    if (menuItems.length === 0) return;
    Electron.Menu.buildFromTemplate([...menuItems]).popup({ window: win, ...at });
  });

  return {
    onThreads(event: ThreadsEvent) {
      if (event.type === "snapshot") {
        titles.clear();
        for (const thread of event.threads) titles.set(thread.threadId, thread.title);
      } else if (event.type === "upsert") {
        titles.set(event.thread.threadId, event.thread.title);
      } else {
        titles.delete(event.threadId);
      }
      publish();
    },
    onThreadChanged(changed: { readonly threadId: string | null }) {
      threadId = changed.threadId;
      publish();
    },
    setMenu(items: ReadonlyArray<Electron.MenuItemConstructorOptions>) {
      menuItems = items;
    },
    /** `url` returns null while no Lecturn client could open the thread. */
    setThreadUrl(url: (threadId: string) => string | null) {
      threadUrl = url;
      publish();
    },
  };
}
