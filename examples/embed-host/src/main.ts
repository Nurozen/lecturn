// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A plain Electron host, the shape app developers copy; it runs no Effect runtime.
/**
 * Embed Host: the smallest Electron app with Lecturn chat in a pane. The
 * Lecturn integration is everything between `lecturn:begin` and
 * `lecturn:end` here, in preload.ts and in renderer/main.ts; the rest is
 * the host app itself. `scripts/count-integration-lines.ts` measures it.
 *
 * Environment (all optional; tests set every one to a temp path):
 * - LECTURN_HOME: where a user's own Lecturn server would be found.
 * - EMBED_HOST_SIDECAR_DIR: the app's own Lecturn home.
 * - EMBED_HOST_WORKSPACE: the workspace the pane chats about.
 * - EMBED_HOST_USER_DATA: Electron's userData directory.
 * - EMBED_HOST_FLASH_LOG: where window_flash calls are recorded.
 * - EMBED_HOST_CDP_PORT, EMBED_HOST_FREEZE_CLOCK: capture and test hooks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { type ConnectionModeEvent, connect } from "@lecturn/embed/node";
import { captureEmbedView, mountEmbedView } from "@lecturn/embed/electron";
import * as Electron from "electron";

import { iconDataUrl } from "./icon.ts";
import { LIVE_GATED_TOOLS, startLiveMcp } from "./liveMcp.ts";
import { makePaneHeader } from "./paneHeader.ts";
import { hostTheme } from "./theme.ts";

const env = process.env;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const require = NodeModule.createRequire(import.meta.url);

const userDataDir = env["EMBED_HOST_USER_DATA"];
if (userDataDir) Electron.app.setPath("userData", userDataDir);
const cdpPort = env["EMBED_HOST_CDP_PORT"];
if (cdpPort) Electron.app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
const freezeClockEnv = env["EMBED_HOST_FREEZE_CLOCK"];
const freezeClock = freezeClockEnv ? { freezeClock: Number(freezeClockEnv) } : {};
// Leaves `window_flash` ungated in the registration so the app's own gate
// decides, which is the path that carries the app's reason for the card.
const gatedTools = env["EMBED_HOST_APP_GATE"] === "1" ? [] : LIVE_GATED_TOOLS;

// An installed Electron app ships no separate Node, so its tools run on
// Electron itself in Node mode.
const bundledNode = process.execPath;
const counterServerPath = NodePath.join(here, "counter-mcp.mjs");
// Match the sidebar column and pane header in renderer/index.html, so the
// pane is placed right before the renderer's first rect report arrives.
const SIDEBAR_WIDTH = 320;
const PANE_HEADER_HEIGHT = 48;

async function main() {
  await Electron.app.whenReady();
  const userData = Electron.app.getPath("userData");
  const workspaceRoot = env["EMBED_HOST_WORKSPACE"] ?? NodePath.join(userData, "ws-a");
  await NodeFSP.mkdir(workspaceRoot, { recursive: true });
  const flashLogPath = env["EMBED_HOST_FLASH_LOG"] ?? NodePath.join(userData, "flashes.json");

  const win = new Electron.BrowserWindow({
    width: 1280,
    height: 820,
    title: "Embed Host",
    backgroundColor: "#1b1e20",
    webPreferences: {
      preload: NodePath.join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  await win.loadFile(NodePath.join(here, "renderer", "index.html"));
  const status = (text: string) => win.webContents.send("embed-host:status", text);
  const paneRect = () => {
    const { width, height } = win.getContentBounds();
    return {
      x: SIDEBAR_WIDTH,
      y: PANE_HEADER_HEIGHT,
      width: Math.max(0, width - SIDEBAR_WIDTH),
      height: Math.max(0, height - PANE_HEADER_HEIGHT),
    };
  };
  status("Starting Lecturn…");
  const header = makePaneHeader(win);

  // lecturn:begin
  const lecturn = await connect({
    registration: {
      appId: "dev.example.embedhost",
      name: "Embed Host",
      iconDataUrl,
      toolPrefix: "ex",
      openUrlTemplate: "embedhost://open?workspace={workspaceRoot}&thread={threadId}",
      refPrefixes: ["ex:"],
      headlessTools: {
        command: bundledNode,
        args: [counterServerPath, "--root", "{workspaceRoot}"],
        listArgs: [counterServerPath, "--list-tools"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        cwd: "{workspaceRoot}",
      },
      liveTools: true,
      gatedTools,
      instructions: "You can read and increment a counter and flash the host window.",
    },
    ...(env["LECTURN_HOME"] ? { lecturnHome: env["LECTURN_HOME"] } : {}),
    sidecar: {
      serverEntry: require.resolve("lecturn/dist/bin.mjs"),
      baseDir: env["EMBED_HOST_SIDECAR_DIR"] ?? NodePath.join(userData, "lecturn"),
    },
  });
  const { projectId } = await lecturn.ensureWorkspace(workspaceRoot, "ws-a");
  const live = await startLiveMcp({ flashLogPath, onFlash: () => win.flashFrame(true) });
  await lecturn.setLiveTools({ url: live.url, bearer: live.bearer });

  const embed = mountEmbedView(win, {
    connection: lecturn,
    projectId,
    theme: hostTheme,
    bounds: paneRect(),
    ...freezeClock,
  });
  embed.on("lecturn/navigate", ({ ref }) => win.webContents.send("embed-host:focus", ref));
  lecturn.subscribeThreads(projectId, header.onThreads);
  embed.on("lecturn/thread.changed", header.onThreadChanged);
  header.setMenu([{ label: "New thread", click: () => embed.newThread() }]);
  embed.on("error", (error) => console.error(`[embed-host] ${error.reason}: ${error.message}`));

  let closed = false;
  Electron.app.on("before-quit", (event) => {
    if (closed) return;
    event.preventDefault();
    void Promise.allSettled([lecturn.close(), live.close()]).finally(() => {
      closed = true;
      Electron.app.quit();
    });
  });
  // lecturn:end

  status(`Lecturn ${lecturn.mode} · ws-a`);
  // A sidecar has no signed-in Lecturn client to open the thread in; a user's own server does.
  header.setThreadUrl((threadId) =>
    lecturn.mode === "user-server"
      ? new URL(`/${lecturn.environmentId}/${threadId}`, lecturn.origin).href
      : null,
  );

  // Project ids differ per server, so the e2e hooks follow the live switch (D36).
  let currentProjectId = projectId;
  const modeEvents: Array<ConnectionModeEvent> = [];
  lecturn.status.subscribe((event) => {
    if (event.type !== "mode") return;
    modeEvents.push(event);
    currentProjectId = event.projectIdsByWorkspaceRoot[workspaceRoot] ?? currentProjectId;
  });

  // Driven from Playwright's electronApp.evaluate by e2e/.
  Object.assign(globalThis, {
    embedHost: {
      get environmentId() {
        return lecturn.environmentId;
      },
      get origin() {
        return lecturn.origin;
      },
      get mode() {
        return lecturn.mode;
      },
      get pairing() {
        return lecturn.status.current.pairing;
      },
      get projectId() {
        return currentProjectId;
      },
      workspaceRoot,
      flashLogPath,
      embed,
      modeEvents,
      embedTarget: () => lecturn.embedTarget(currentProjectId),
      openThread: (threadId: string) => embed.retarget(currentProjectId, threadId),
      listThreads: () => lecturn.listThreads(currentProjectId),
      setThreadAppData: (threadId: string, appData: string | null, subtitle?: string | null) =>
        lecturn.setThreadAppData(threadId, appData, subtitle),
      capture: async (file: string) => {
        await NodeFSP.writeFile(file, await captureEmbedView(embed));
      },
    },
  });
}

Electron.app.on("window-all-closed", () => Electron.app.quit());

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[embed-host] ${message}`);
  Object.assign(globalThis, { embedHostError: message });
  for (const win of Electron.BrowserWindow.getAllWindows()) {
    win.webContents.send("embed-host:status", `Lecturn failed to start: ${String(error)}`);
  }
});
