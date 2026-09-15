import {
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  type IpcMainInvokeEvent,
} from "electron";
import Store from "electron-store";
import * as Schema from "effect/Schema";
import {
  DesktopActivityActionSchema,
  DesktopActivitySnapshotSchema,
  type DesktopActivitySnapshot,
} from "@lecturn/contracts";
import * as Channels from "./channels.ts";
import { activityTrayMark } from "./artwork.ts";
import { activityDocument } from "./document.ts";
import {
  activityBounds,
  activityCameraHeight,
  hasNotchSpace,
  selectActivityDisplay,
} from "./geometry.ts";
import { nextActivityMode, isViewedActivityThread, type ActivityMode } from "./interaction.ts";
import { isPublishedActivityAction, isTrustedActivitySender } from "./policy.ts";

const decodeSnapshot = Schema.decodeUnknownSync(DesktopActivitySnapshotSchema);
const decodeAction = Schema.decodeUnknownSync(DesktopActivityActionSchema);
const decodeInteraction = Schema.decodeUnknownSync(
  Schema.Literals([
    "hover-enter",
    "hover-leave",
    "toggle",
    "expand",
    "dismiss",
    "micro-open",
    "micro-interact",
  ]),
);
const decodeBoolean = Schema.decodeUnknownSync(Schema.Boolean);

/** A Mac-owned display surface. Only the existing authenticated renderer can publish work
 * or receive commands. The isolated panel has no general DesktopBridge or network access. */
export function installDesktopActivity(
  main: BrowserWindow,
  options: {
    platform: string;
    preloadPath: string;
    applicationUrl: string;
  },
): () => void {
  if (options.platform !== "darwin" || main.isDestroyed()) return () => {};
  // Accessing BrowserWindow.webContents throws after its closed event. Retain the
  // emitter while alive so listener cleanup does not cross a destroyed native object.
  const mainContents = main.webContents;
  const mainContentsId = mainContents.id;
  const preferences = new Store<{ enabled: boolean }>({
    name: "activity-panel",
    defaults: { enabled: true },
  });
  let enabled = preferences.get("enabled");
  let mode: ActivityMode = "collapsed";
  let peekCount = 0;
  let panel: BrowserWindow | undefined;
  let ready = false;
  let disposed = false;
  let manuallyShown = false;
  let preserveNextPanelBlur = false;
  let snapshot: DesktopActivitySnapshot = {
    summary: "Lecturn activity",
    rows: [],
    readyEnvironmentIds: [],
  };
  const panelUrl = `data:text/html;charset=utf-8,${encodeURIComponent(activityDocument)}`;
  const trayImage = nativeImage.createFromBuffer(Buffer.from(activityTrayMark, "base64"), {
    scaleFactor: 2,
  });
  trayImage.setTemplateImage(true);
  const tray = new Tray(trayImage);
  tray.setToolTip("Lecturn activity");
  const trusted = (event: IpcMainInvokeEvent, window: BrowserWindow | undefined, url: string) => {
    if (
      disposed ||
      !window ||
      window.isDestroyed() ||
      !isTrustedActivitySender({
        senderId: event.sender.id,
        expectedId: window.webContents.id,
        isMainFrame: event.senderFrame === window.webContents.mainFrame,
        url: event.senderFrame?.url ?? "",
        expectedUrl: url,
      })
    )
      throw new Error("Untrusted activity sender.");
  };
  const snapshotForPanel = (): DesktopActivitySnapshot => {
    if (!main.isDestroyed() && main.isVisible() && main.isFocused()) return snapshot;
    const { viewedThread: _viewedThread, ...backgroundSnapshot } = snapshot;
    return backgroundSnapshot;
  };
  const sendSnapshot = () => {
    if (!disposed && ready && panel && !panel.isDestroyed())
      panel.webContents.send(Channels.ACTIVITY_SNAPSHOT, snapshotForPanel());
  };
  const place = () => {
    if (disposed || main.isDestroyed()) return;
    if (panel?.isDestroyed()) {
      panel = undefined;
      ready = false;
    }
    const display = selectActivityDisplay(
      screen.getAllDisplays(),
      screen.getDisplayMatching(main.getBounds()).id,
    );
    if (!display || !enabled) {
      panel?.hide();
      return;
    }
    if (!panel) {
      panel = new BrowserWindow({
        ...activityBounds(display, mode, peekCount),
        show: false,
        frame: false,
        focusable: mode === "expanded",
        acceptFirstMouse: true,
        // Frameless windows may occupy the menu strip instead of AppKit clamping y.
        enableLargerThanScreen: true,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        hasShadow: true,
        title: "Lecturn activity",
        webPreferences: {
          preload: options.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          partition: "lecturn-activity",
        },
      });
      panel.setAlwaysOnTop(true, "pop-up-menu");
      panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      panel.webContents.on("will-navigate", (event) => event.preventDefault());
      panel.webContents.on("will-attach-webview", (event) => event.preventDefault());
      panel.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      panel.once("ready-to-show", () => {
        if (disposed || main.isDestroyed() || !panel || panel.isDestroyed()) return;
        ready = true;
        sendSnapshot();
        panel.webContents.send(Channels.ACTIVITY_MODE, mode);
        place();
      });
      panel.on("focus", () => {
        preserveNextPanelBlur = false;
      });
      panel.on("blur", () => {
        if (disposed || main.isDestroyed() || !panel || panel.isDestroyed()) return;
        // Resizing or moving between the camera wings and body must not dismiss it.
        // A focused expanded panel loses focus when the user clicks another window.
        if (preserveNextPanelBlur) {
          preserveNextPanelBlur = false;
          return;
        }
        if (mode !== "expanded" && mode !== "micro") return;
        const cursor = screen.getCursorScreenPoint();
        const bounds = panel.getBounds();
        if (
          cursor.x >= bounds.x &&
          cursor.x < bounds.x + bounds.width &&
          cursor.y >= bounds.y &&
          cursor.y < bounds.y + bounds.height
        )
          return;
        changeMode("collapsed");
      });
      panel.once("closed", () => {
        panel = undefined;
        ready = false;
      });
      void panel.loadURL(panelUrl);
    }
    panel.setBounds(activityBounds(display, mode, peekCount));
    if (ready)
      panel.webContents.send(Channels.ACTIVITY_CAMERA_HEIGHT, activityCameraHeight(display));
    if (ready && (hasNotchSpace(display) || manuallyShown)) {
      if (!panel.isVisible()) panel.showInactive();
    } else panel.hide();
  };
  const changeMode = (next: ActivityMode) => {
    if (mode === next) return;
    mode = next;
    if (mode === "peek") peekCount = Math.min(snapshot.rows.length, 3);
    if (mode === "collapsed") manuallyShown = false;
    place();
    if (!panel || panel.isDestroyed()) return;
    panel.setFocusable(mode === "expanded");
    panel.webContents.send(Channels.ACTIVITY_MODE, mode);
    if (mode === "expanded") {
      panel.show();
      panel.focus();
    }
  };
  const updateMenu = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Show activity",
          enabled,
          click: () => {
            if (disposed || main.isDestroyed()) return;
            manuallyShown = true;
            changeMode("expanded");
          },
        },
        {
          label: "Enable activity panel",
          type: "checkbox",
          checked: enabled,
          click: (item) => setEnabled(item.checked),
        },
        { type: "separator" },
        {
          label: "Open Lecturn",
          click: () => {
            if (disposed || main.isDestroyed()) return;
            main.show();
            main.focus();
          },
        },
      ]),
    );
  const setEnabled = (next: boolean) => {
    if (disposed || main.isDestroyed()) return;
    preferences.set("enabled", next);
    enabled = next;
    if (!main.isDestroyed()) main.webContents.send(Channels.ACTIVITY_ENABLED_CHANGED, enabled);
    mode = "collapsed";
    manuallyShown = false;
    if (panel && !panel.isDestroyed()) {
      panel.setFocusable(false);
      panel.webContents.send(Channels.ACTIVITY_MODE, mode);
    }
    updateMenu();
    place();
  };
  const handlers: [string, (event: IpcMainInvokeEvent, value: unknown) => unknown][] = [
    [
      Channels.ACTIVITY_PUBLISH,
      (event, value) => {
        trusted(event, main, options.applicationUrl);
        const decoded = decodeSnapshot(value);
        if (decoded.rows.length > 200 || JSON.stringify(decoded).length > 1_000_000)
          throw new Error("Activity snapshot is too large.");
        snapshot = decoded;
        sendSnapshot();
      },
    ],
    [
      Channels.ACTIVITY_ACTION,
      (event, value) => {
        trusted(event, panel, panelUrl);
        const action = decodeAction(value);
        if (!enabled || !isPublishedActivityAction(snapshot, action))
          throw new Error("This action is no longer available. Refresh activity in Lecturn.");
        if (main.isDestroyed() || main.webContents.isLoadingMainFrame())
          throw new Error("Lecturn is reconnecting. Try again shortly.");
        main.webContents.send(Channels.ACTIVITY_ACTION, action);
        if (action.kind === "open" || (action.kind === "merge" && !action.threadId)) {
          changeMode("collapsed");
          main.show();
          main.focus();
        }
      },
    ],
    [
      Channels.ACTIVITY_OPEN_APP,
      (event) => {
        trusted(event, panel, panelUrl);
        if (!enabled || main.isDestroyed()) return;
        preserveNextPanelBlur = true;
        main.show();
        main.focus();
      },
    ],
    [
      Channels.ACTIVITY_READ,
      (event) => {
        trusted(event, panel, panelUrl);
        return snapshotForPanel();
      },
    ],
    [
      Channels.ACTIVITY_PEEK_COUNT,
      (event, value) => {
        trusted(event, panel, panelUrl);
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3)
          throw new Error("Invalid peek size.");
        if (peekCount === value) return;
        peekCount = value;
        if (mode === "peek") place();
      },
    ],
    [
      Channels.ACTIVITY_MODE,
      (event, value) => {
        trusted(event, panel, panelUrl);
        const interaction = decodeInteraction(value);
        const current = snapshotForPanel();
        if (
          interaction === "hover-enter" &&
          current.rows.length &&
          current.rows.every((row) => isViewedActivityThread(row, current.viewedThread))
        )
          return;
        changeMode(nextActivityMode(mode, interaction));
        if (interaction === "micro-interact" && mode === "micro" && panel && !panel.isDestroyed()) {
          panel.setFocusable(true);
          panel.show();
          panel.focus();
        }
      },
    ],
    [
      Channels.ACTIVITY_ENABLED,
      (event) => {
        trusted(event, main, options.applicationUrl);
        return enabled;
      },
    ],
    [
      Channels.ACTIVITY_SET_ENABLED,
      (event, value) => {
        if (event.sender.id === mainContentsId) trusted(event, main, options.applicationUrl);
        else trusted(event, panel, panelUrl);
        setEnabled(decodeBoolean(value));
      },
    ],
  ];
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);
  const clear = () => {
    if (disposed) return;
    snapshot = { summary: "Lecturn is reconnecting…", rows: [], readyEnvironmentIds: [] };
    sendSnapshot();
  };
  mainContents.on("did-start-loading", clear);
  mainContents.on("render-process-gone", clear);
  screen.on("display-added", place);
  screen.on("display-removed", place);
  screen.on("display-metrics-changed", place);
  main.on("move", place);
  main.on("focus", sendSnapshot);
  main.on("blur", sendSnapshot);
  main.on("hide", sendSnapshot);
  updateMenu();
  place();
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
    screen.removeListener("display-added", place);
    screen.removeListener("display-removed", place);
    screen.removeListener("display-metrics-changed", place);
    main.removeListener("move", place);
    main.removeListener("focus", sendSnapshot);
    main.removeListener("blur", sendSnapshot);
    main.removeListener("hide", sendSnapshot);
    mainContents.removeListener("did-start-loading", clear);
    mainContents.removeListener("render-process-gone", clear);
    const closingPanel = panel;
    panel = undefined;
    ready = false;
    if (closingPanel && !closingPanel.isDestroyed()) closingPanel.destroy();
    tray.destroy();
  };
}
