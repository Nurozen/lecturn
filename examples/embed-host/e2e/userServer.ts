// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off -- Test harness for a server the e2e launches; it runs no Effect runtime.
/**
 * The user's own Lecturn server for the attach steps: `lecturn serve` on the
 * run's temp Lecturn home, the one the host's helper watches (D36). It keeps
 * its home across restarts, so it comes back as the same environment.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { lecturnBin } from "./adminClient.ts";
import type { EmbedHostDirs } from "./harness.ts";
import { until } from "./harness.ts";

const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 20_000;
const SCRIPTED_SETTINGS = {
  providerInstances: { scripted: { driver: "scripted", enabled: true } },
  defaultModelSelection: { instanceId: "scripted", model: "scripted" },
};

export interface UserServerRuntime {
  readonly origin: string;
  readonly environmentId: string;
  readonly pid: number;
}

export interface UserServer {
  readonly baseDir: string;
  /** The running server; throws when it is stopped. */
  readonly current: UserServerRuntime;
  start(): Promise<UserServerRuntime>;
  stop(): Promise<void>;
  readonly output: () => string;
}

const runtimeStatePath = (baseDir: string) =>
  NodePath.join(baseDir, "userdata", "server-runtime.json");

async function environmentIdAt(origin: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/.well-known/lecturn/environment", origin), {
      credentials: "omit",
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { readonly environmentId?: unknown };
    return typeof body.environmentId === "string" ? body.environmentId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Inherited `LECTURN_*` values would point the server at someone else's state
 * or change how it serves, as they would the sidecar.
 */
function serverEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("LECTURN_")) continue;
    if (key === "ELECTRON_RUN_AS_NODE" || key === "VITE_DEV_SERVER_URL") continue;
    env[key] = value;
  }
  return { ...env, LECTURN_TEST_PROVIDERS: "1" };
}

export function userServer(dirs: EmbedHostDirs, log: (line: string) => void): UserServer {
  const baseDir = dirs.lecturnHome;
  let child: NodeChildProcess.ChildProcess | null = null;
  let exited: Promise<void> = Promise.resolve();
  let runtime: UserServerRuntime | null = null;
  let output = "";

  const start = async (): Promise<UserServerRuntime> => {
    if (child !== null) throw new Error("The user server is already running.");
    const settingsPath = NodePath.join(baseDir, "userdata", "settings.json");
    if (!NodeFS.existsSync(settingsPath)) {
      await NodeFSP.mkdir(NodePath.dirname(settingsPath), { recursive: true });
      await NodeFSP.writeFile(settingsPath, `${JSON.stringify(SCRIPTED_SETTINGS, null, 2)}\n`);
    }
    // No `--port`: the server picks a free one and records it in server-runtime.json.
    const spawned = NodeChildProcess.spawn(
      process.execPath,
      [lecturnBin(), "serve", "--base-dir", baseDir, "--host", "127.0.0.1", "--no-browser"],
      { cwd: dirs.root, env: serverEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    child = spawned;
    exited = new Promise<void>((resolve) => spawned.once("exit", () => resolve()));
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
    };
    spawned.stdout?.on("data", capture);
    spawned.stderr?.on("data", capture);
    const pid = spawned.pid;
    if (pid === undefined) throw new Error("The user server did not start.");

    const ready = await until("the user server to serve", READY_TIMEOUT_MS, async () => {
      if (spawned.exitCode !== null) {
        throw new Error(`The user server exited (${spawned.exitCode}):\n${output}`);
      }
      const record = await NodeFSP.readFile(runtimeStatePath(baseDir), "utf8").catch(() => null);
      if (record === null) return undefined;
      const state = JSON.parse(record) as { readonly pid?: unknown; readonly origin?: unknown };
      if (state.pid !== pid || typeof state.origin !== "string") return undefined;
      const environmentId = await environmentIdAt(state.origin);
      return environmentId === undefined ? undefined : { origin: state.origin, environmentId, pid };
    });
    runtime = ready;
    log(`user server ${ready.origin} (${ready.environmentId}), pid ${pid}`);
    return ready;
  };

  const stop = async () => {
    const running = child;
    if (running === null) return;
    child = null;
    runtime = null;
    // The pid captured at spawn; nothing else is signalled.
    running.kill("SIGTERM");
    const quit = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
    ]);
    if (!quit) {
      running.kill("SIGKILL");
      await exited;
    }
    log("user server stopped");
  };

  return {
    baseDir,
    get current() {
      if (runtime === null) throw new Error("The user server is not running.");
      return runtime;
    },
    start,
    stop,
    output: () => output,
  };
}
