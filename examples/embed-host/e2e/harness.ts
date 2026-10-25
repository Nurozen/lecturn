// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Test harness driving a real Electron app; it runs no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { embedHostDir, resolveEmbedHostLaunch } from "../scripts/electronLauncher.ts";

/** What src/main.ts publishes on the main process's globalThis once the pane is mounted. */
export interface EmbedHostGlobal {
  readonly environmentId: string;
  readonly origin: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly flashLogPath: string;
  embedTarget(): Promise<{
    readonly url: string;
    readonly token: string;
    readonly expiresAt: string;
  }>;
  openThread(threadId: string): Promise<void>;
  capture(file: string): Promise<void>;
}

/**
 * For `app.evaluate` callbacks, which are serialized into the main process and
 * so can use only types from here: `(globalThis as HostGlobals).embedHost!`.
 */
export interface HostGlobals {
  readonly embedHost?: EmbedHostGlobal;
  readonly embedHostError?: string;
}

export interface EmbedHostDirs {
  readonly root: string;
  readonly lecturnHome: string;
  readonly sidecarDir: string;
  readonly userData: string;
  readonly workspace: string;
  readonly flashLog: string;
}

export interface EmbedHostRun {
  readonly app: ElectronApplication;
  readonly dirs: EmbedHostDirs;
  readonly host: Omit<EmbedHostGlobal, "embedTarget" | "openThread" | "capture">;
  /** The embed guest's page, once its URL contains `urlPart`. */
  guestPage(urlPart: string, timeoutMs?: number): Promise<Page>;
  readonly output: () => string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** `providerInstances.scripted` and the default model, so app threads run the scripted provider. */
  readonly scripted?: boolean;
  readonly readyTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const QUIT_TIMEOUT_MS = 20_000;

const SCRIPTED_SETTINGS = {
  providerInstances: { scripted: { driver: "scripted", enabled: true } },
  defaultModelSelection: { instanceId: "scripted", model: "scripted" },
};

/**
 * Every path the run touches is under one temp directory: the Lecturn home
 * the helper would discover a user server in (empty, so it runs the sidecar),
 * the sidecar's own home, Electron's userData and the workspace.
 */
async function makeDirs(): Promise<EmbedHostDirs> {
  // realpath: macOS hands out /var/... for /private/var/..., and the
  // workspace root is compared verbatim with what the server echoes.
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "embed-host-e2e-")),
  );
  const dirs = {
    root,
    lecturnHome: NodePath.join(root, "lecturn-home"),
    sidecarDir: NodePath.join(root, "sidecar"),
    userData: NodePath.join(root, "electron-user-data"),
    workspace: NodePath.join(root, "ws-a"),
    flashLog: NodePath.join(root, "flashes.json"),
  };
  for (const dir of [dirs.lecturnHome, dirs.sidecarDir, dirs.userData, dirs.workspace]) {
    await NodeFSP.mkdir(dir, { recursive: true });
  }
  return dirs;
}

export async function launchEmbedHost(options: LaunchOptions = {}): Promise<EmbedHostRun> {
  if (!NodeFS.existsSync(NodePath.join(embedHostDir, "dist", "main.mjs"))) {
    throw new Error("embed-host is not built; run `vp run --filter embed-host build` first.");
  }
  const dirs = await makeDirs();
  if (options.scripted) {
    const settingsDir = NodePath.join(dirs.sidecarDir, "userdata");
    await NodeFSP.mkdir(settingsDir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(settingsDir, "settings.json"),
      `${JSON.stringify(SCRIPTED_SETTINGS, null, 2)}\n`,
    );
  }

  const command = await resolveEmbedHostLaunch();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Inherited when the e2e runs from an agent inside Lecturn desktop; it would
  // start Electron as plain Node, which rejects Playwright's debugging flags.
  delete env["ELECTRON_RUN_AS_NODE"];
  Object.assign(env, {
    LECTURN_HOME: dirs.lecturnHome,
    EMBED_HOST_SIDECAR_DIR: dirs.sidecarDir,
    EMBED_HOST_USER_DATA: dirs.userData,
    EMBED_HOST_WORKSPACE: dirs.workspace,
    EMBED_HOST_FLASH_LOG: dirs.flashLog,
    ELECTRON_ENABLE_LOGGING: "1",
    ...(options.scripted ? { LECTURN_TEST_PROVIDERS: "1" } : {}),
  });
  const app = await _electron.launch({
    executablePath: command.electronPath,
    args: [...command.args],
    cwd: embedHostDir,
    env,
  });

  let output = "";
  const child = app.process();
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // before-quit in main.ts clears the live lease and stops the sidecar.
    void app.close().catch(() => undefined);
    // With the embed view mounted, the window's `closed` never follows its
    // `close` and the app never quits; a run must not leave it behind.
    const quit = await Promise.race([
      exited.then(() => true),
      sleep(QUIT_TIMEOUT_MS).then(() => false),
    ]);
    if (!quit) {
      child.kill("SIGKILL");
      await exited;
    }
    await stopLeftoverSidecar(dirs.sidecarDir);
  };

  try {
    const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
    let host: EmbedHostRun["host"] | null = null;
    while (host === null) {
      const state = await app.evaluate(() => {
        const globals = globalThis as HostGlobals;
        if (globals.embedHostError !== undefined) return { error: globals.embedHostError };
        const published = globals.embedHost;
        if (published === undefined) return null;
        return {
          host: {
            environmentId: published.environmentId,
            origin: published.origin,
            projectId: published.projectId,
            workspaceRoot: published.workspaceRoot,
            flashLogPath: published.flashLogPath,
          },
        };
      });
      if (state !== null && "error" in state) {
        throw new Error(`embed-host failed to start:\n${state.error}`);
      }
      if (state !== null) host = state.host;
      else if (Date.now() > deadline) throw new Error("embed-host never mounted the embed view.");
      else await sleep(250);
    }

    return {
      app,
      dirs,
      host,
      guestPage: async (urlPart, timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const page = app
            .context()
            .pages()
            .find((candidate) => candidate.url().includes(urlPart));
          if (page !== undefined) return page;
          await sleep(200);
        }
        const urls = app
          .context()
          .pages()
          .map((page) => page.url());
        throw new Error(`No embed guest page at ${urlPart}; pages: ${urls.join(", ")}`);
      },
      output: () => output,
      close,
    };
  } catch (error) {
    await close();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- embed-host output ---\n${output}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * main.ts installs its before-quit cleanup only once the pane is mounted, so a
 * run that failed earlier leaves its sidecar serving. Its runtime record in
 * this run's own temp baseDir names the PID.
 */
async function stopLeftoverSidecar(sidecarDir: string): Promise<void> {
  const record = await NodeFSP.readFile(
    NodePath.join(sidecarDir, "userdata", "server-runtime.json"),
    "utf8",
  ).catch(() => null);
  const pid = record === null ? undefined : (JSON.parse(record) as { pid?: unknown }).pid;
  if (typeof pid !== "number") return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

export async function removeDirs(dirs: EmbedHostDirs): Promise<void> {
  await NodeFSP.rm(dirs.root, { recursive: true, force: true });
}
