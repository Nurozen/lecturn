// @effect-diagnostics nodeBuiltinImport:off -- Promise API for hosts that run no Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

/**
 * A copy of `PersistedServerRuntimeState` in apps/server/src/serverRuntimeState.ts.
 * The helper ships outside the monorepo and cannot import the private server
 * package. The server publishes this record only after it has bound its port,
 * so it doubles as the ready record that carries the real port.
 */
export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  ownerId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

const decodeRuntimeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const EnvironmentProbe = Schema.Struct({
  environmentId: Schema.String.check(Schema.isMinLength(1)),
});
const decodeEnvironmentProbe = Schema.decodeUnknownOption(EnvironmentProbe);

export const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/lecturn/environment";

/**
 * Worktree dev servers run with an explicit home and so use `userdata`; only a
 * dev server started without one lands in `dev` (apps/server/src/config.ts).
 */
const SERVER_STATE_VARIANTS = ["userdata", "dev"] as const;
export type ServerStateVariant = (typeof SERVER_STATE_VARIANTS)[number];

export const serverRuntimeStatePath = (home: string, variant: ServerStateVariant): string =>
  NodePath.join(home, variant, "server-runtime.json");

export interface DiscoveredServer {
  readonly variant: ServerStateVariant;
  readonly statePath: string;
  readonly state: PersistedServerRuntimeState;
  readonly origin: string;
  readonly environmentId: string;
}

export interface DiscoveryOptions {
  readonly variants?: ReadonlyArray<ServerStateVariant>;
  readonly fetch?: typeof globalThis.fetch;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/**
 * Signal 0 delivers nothing; it only reports whether the pid exists. EPERM
 * means it exists but belongs to another user, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export async function readServerRuntimeState(
  statePath: string,
): Promise<PersistedServerRuntimeState | null> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(statePath, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const decoded = decodeRuntimeState(trimmed);
  return decoded._tag === "Some" ? decoded.value : null;
}

/** Returns the environment id when `origin` answers as a Lecturn server. */
export async function probeEnvironment(
  origin: string,
  options: Pick<DiscoveryOptions, "fetch" | "probeTimeoutMs"> = {},
): Promise<string | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let url: URL;
  try {
    url = new URL(WELL_KNOWN_ENVIRONMENT_PATH, origin);
  } catch {
    return null;
  }
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
      credentials: "omit",
    });
    // A proxy answering for a backend that is gone (Tailscale Serve) reports
    // the bad-gateway family; that is a stale mapping, not a live server.
    if (!response.ok) return null;
    const probe = decodeEnvironmentProbe(await response.json());
    return probe._tag === "Some" ? probe.value.environmentId : null;
  } catch {
    return null;
  }
}

/**
 * Finds a live Lecturn server under `home`. It reads only the runtime record,
 * the pid and the well-known endpoint: opening the ownership lock
 * (`server-owner.sqlite`) would take it for a moment and could make a server
 * that is starting right then exit 78.
 */
export async function discoverServer(
  home: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveredServer | null> {
  const alive = options.isProcessAlive ?? isProcessAlive;
  for (const variant of options.variants ?? SERVER_STATE_VARIANTS) {
    const statePath = serverRuntimeStatePath(home, variant);
    const state = await readServerRuntimeState(statePath);
    // A dead server's record can name a port another server has since taken.
    if (state === null || !alive(state.pid)) continue;
    const environmentId = await probeEnvironment(state.origin, options);
    if (environmentId === null) continue;
    return { variant, statePath, state, origin: state.origin, environmentId };
  }
  return null;
}
