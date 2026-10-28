// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Promise API for hosts that run no Effect runtime; it owns a plain child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type * as NodeStream from "node:stream";
import type { AppRegistration, AppSidecarBootstrap } from "@lecturn/contracts/apps";
import { waitForHttpReady } from "@lecturn/shared/httpReadiness";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { FetchHttpClient } from "effect/http";

import {
  type DiscoveredServer,
  discoverServer,
  probeEnvironment,
  readServerRuntimeState,
  serverRuntimeStatePath,
  WELL_KNOWN_ENVIRONMENT_PATH,
} from "./discovery.ts";

export interface SidecarOptions {
  /** The Lecturn server entry, e.g. `<lecturn package>/dist/bin.mjs`. */
  readonly serverEntry: string;
  /** The sidecar's own Lecturn home; never the user's. */
  readonly baseDir: string;
  /** Defaults to this process run as Node (`ELECTRON_RUN_AS_NODE=1` under Electron). */
  readonly nodePath?: string;
}

/** The server exits with this code when another process owns its state dir. */
const SIDECAR_EXIT_STATE_DIR_OWNED = 78;

const BOOTSTRAP_FD = 3;
/** Never written; the server exits at its end-of-file, which only this process's exit causes. */
const PARENT_PIPE_FD = 4;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 100;
const STOP_GRACE_MS = 5_000;
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * Inherited values that would point the sidecar at someone else's server
 * state or change how it serves. `VITE_DEV_SERVER_URL` would redirect every
 * loopback static request, `/embed` included, to that dev server.
 */
export const SIDECAR_ENV_SCRUB = [
  "ELECTRON_RUN_AS_NODE",
  "VITE_DEV_SERVER_URL",
  "LECTURN_PORT",
  "LECTURN_HOST",
  "LECTURN_MODE",
  "LECTURN_HOME",
  "LECTURN_BOOTSTRAP_FD",
  "LECTURN_DEV_AUTH_TOKEN",
  "LECTURN_DEV_ALLOWED_ORIGINS",
  "LECTURN_TAILSCALE_SERVE",
  "LECTURN_TAILSCALE_SERVE_PORT",
  "LECTURN_NO_BROWSER",
  "LECTURN_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
] as const;

export function buildSidecarEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  options: { readonly electronAsNode: boolean },
): Record<string, string> {
  const scrubbed = new Set<string>(SIDECAR_ENV_SCRUB);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !scrubbed.has(key)) env[key] = value;
  }
  // Only the server runs as Node; it strips this again for the tools it spawns.
  if (options.electronAsNode) env["ELECTRON_RUN_AS_NODE"] = "1";
  return env;
}

/**
 * No `--port`: web mode picks a free port itself and records the bound one in
 * `server-runtime.json`, so there is no pick-and-retry race here.
 */
export function sidecarArgs(serverEntry: string, baseDir: string): Array<string> {
  return [
    serverEntry,
    "serve",
    "--base-dir",
    baseDir,
    "--host",
    "127.0.0.1",
    "--no-browser",
    "--bootstrap-fd",
    String(BOOTSTRAP_FD),
  ];
}

function makeSidecarEnvelope(
  registration: AppRegistration,
  appSeedToken: string,
): AppSidecarBootstrap {
  return { mode: "app-sidecar", registration, appSeedToken, parentPipeFd: PARENT_PIPE_FD };
}

export class SidecarError extends Error {
  override readonly name = "SidecarError";
  readonly reason: "exited" | "timeout" | "spawn-failed";
  readonly exitCode: number | null;

  constructor(
    reason: SidecarError["reason"],
    message: string,
    options?: { readonly exitCode?: number | null; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.reason = reason;
    this.exitCode = options?.exitCode ?? null;
  }
}

interface SidecarServer {
  readonly origin: string;
  readonly environmentId: string;
  readonly pid: number;
}

export type SidecarHandle =
  | (SidecarServer & {
      readonly kind: "spawned";
      readonly appSeedToken: string;
      /** Resolves with the exit code once the sidecar process is gone. */
      readonly exited: Promise<number | null>;
      stop(): Promise<void>;
    })
  | (SidecarServer & { readonly kind: "attached" });

export interface StartSidecarInput {
  readonly registration: AppRegistration;
  readonly sidecar: SidecarOptions;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readyTimeoutMs?: number;
  /**
   * Aborting before ready stops a sidecar this call spawned and rejects with
   * the signal's reason once that process has exited. A ready handle is not
   * affected; `stop()` owns it from then on.
   */
  readonly signal?: AbortSignal;
}

const attached = (server: DiscoveredServer): SidecarHandle => ({
  kind: "attached",
  origin: server.origin,
  environmentId: server.environmentId,
  pid: server.state.pid,
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The server prints a one-time admin pairing token at startup; stdout is
// never read, and stderr is kept only as a redacted tail for failure messages.
const redact = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/token|pairing url/i.test(line))
    .join("\n");

const waitUntilHttpReady = (origin: string, timeoutMs: number, signal?: AbortSignal) =>
  Effect.runPromise(
    waitForHttpReady({
      baseUrl: origin,
      path: WELL_KNOWN_ENVIRONMENT_PATH,
      timeoutMs,
      makeError: ({ requestUrl }) =>
        new SidecarError("timeout", `The Lecturn sidecar did not answer at ${requestUrl}.`),
    }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, Logger.layer([])))),
    { signal },
  );

/**
 * Starts the app's own Lecturn server in `baseDir`, or attaches to the one
 * that already owns it (a second window or process of the same app).
 */
export async function startSidecar(input: StartSidecarInput): Promise<SidecarHandle> {
  const { serverEntry, baseDir } = input.sidecar;
  const timeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const statePath = serverRuntimeStatePath(baseDir, "userdata");
  const { signal } = input;

  signal?.throwIfAborted();
  // `--base-dir` is explicit, so the server's state is always under `userdata`.
  const owner = await discoverServer(baseDir, { variants: ["userdata"] });
  if (owner !== null) return attached(owner);
  signal?.throwIfAborted();

  await NodeFSP.mkdir(baseDir, { recursive: true });
  const appSeedToken = NodeCrypto.randomBytes(32).toString("base64url");
  const envelope = makeSidecarEnvelope(input.registration, appSeedToken);
  const executable = input.sidecar.nodePath ?? process.execPath;
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(executable, sidecarArgs(serverEntry, baseDir), {
      cwd: baseDir,
      env: buildSidecarEnv(input.env ?? process.env, {
        electronAsNode: input.sidecar.nodePath === undefined,
      }),
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (cause) {
    throw new SidecarError("spawn-failed", `Could not start ${executable}.`, { cause });
  }

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  let exitCode: number | null | undefined;
  let spawnError: unknown;
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      exitCode ??= null;
      resolve(null);
    });
    child.once("exit", (code) => {
      exitCode = code;
      resolve(code);
    });
  });

  // The server reads the envelope within its first second, so it goes out now.
  const bootstrap = child.stdio[BOOTSTRAP_FD] as NodeStream.Writable | null | undefined;
  bootstrap?.on("error", () => {});
  bootstrap?.end(`${JSON.stringify(envelope)}\n`);
  const parentPipe = child.stdio[PARENT_PIPE_FD] as NodeStream.Duplex | null | undefined;
  parentPipe?.on("error", () => {});

  const stop = async () => {
    if (exitCode !== undefined) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (exitCode === undefined) child.kill("SIGKILL");
    }, STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  };

  const failure = (reason: SidecarError["reason"], message: string) => {
    const tail = redact(stderrTail).trim();
    return new SidecarError(reason, tail ? `${message}\n${tail}` : message, {
      exitCode: exitCode ?? null,
      ...(spawnError === undefined ? {} : { cause: spawnError }),
    });
  };

  // Every wait below races this, so an abort never waits out the ready timeout.
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const unlessAborted = <A>(promise: Promise<A>) =>
    signal === undefined ? promise : Promise.race([promise, aborted]);

  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (exitCode !== undefined) {
        if (exitCode !== SIDECAR_EXIT_STATE_DIR_OWNED) {
          throw failure(
            spawnError === undefined ? "exited" : "spawn-failed",
            `The Lecturn sidecar exited with code ${exitCode}.`,
          );
        }
        // Another process won the race for this baseDir; it publishes its
        // runtime record once it is serving.
        const winner = await unlessAborted(discoverServer(baseDir, { variants: ["userdata"] }));
        if (winner !== null) return attached(winner);
      } else {
        const state = await unlessAborted(readServerRuntimeState(statePath));
        // Only the child's own record means it is serving. Any other pid is a
        // crashed earlier sidecar's leftover or the live winner of a start
        // race, whose record can land before this child exits 78.
        if (state !== null && state.pid === child.pid) {
          await unlessAborted(
            waitUntilHttpReady(state.origin, Math.max(1, deadline - Date.now()), signal),
          );
          const environmentId = await unlessAborted(probeEnvironment(state.origin));
          if (environmentId !== null) {
            return {
              kind: "spawned",
              origin: state.origin,
              environmentId,
              pid: state.pid,
              appSeedToken,
              exited,
              stop,
            };
          }
        }
      }
      await unlessAborted(delay(READY_POLL_INTERVAL_MS));
    }
    throw failure("timeout", `The Lecturn sidecar was not ready within ${timeoutMs} ms.`);
  } catch (error) {
    await stop();
    throw signal?.aborted === true ? signal.reason : error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
