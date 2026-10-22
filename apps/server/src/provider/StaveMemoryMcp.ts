/**
 * Stave memory MCP wiring for orchestration-v2 adapters.
 *
 * A live Stave space whose manifest enables Marmot memory carries a generated
 * `context-marmot` entry in its root `.mcp.json`. `StaveMemoryWiring` reads and
 * validates that entry; these helpers turn its resolution into each provider's
 * own MCP server shape, registered next to the `lecturn` MCP server.
 *
 * @module provider/StaveMemoryMcp
 */
import type { CodexSettings } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { ProcessRunner } from "../processRunner.ts";
import {
  StaveMemoryWiring,
  type StaveMemoryConfig,
  type StaveMemoryResolution,
} from "../stave/StaveMemoryWiring.ts";
import { resolveCodexLaunchArgs } from "./Layers/codexLaunchArgs.ts";
import {
  type CodexMcpInventoryError,
  hasCanonicalMarmotServer,
} from "./Layers/codexMcpInventory.ts";

export const STAVE_MEMORY_MCP_SERVER_NAME = "context-marmot";

/** Resolves the Stave memory MCP entry for a session's working directory. */
export type StaveMemoryResolver = (cwd: string) => Effect.Effect<StaveMemoryResolution>;

const noStaveMemory: StaveMemoryResolver = () => Effect.succeed({ state: "absent" });

/**
 * The resolver to hand an adapter. Optional at the adapter-driver layer so
 * upstream test kits run without the service; the provider drivers require
 * `StaveMemoryWiring` in their environment and provide it here.
 */
export const currentStaveMemoryResolver: Effect.Effect<StaveMemoryResolver> = Effect.serviceOption(
  StaveMemoryWiring,
).pipe(
  Effect.map(Option.match({ onNone: () => noStaveMemory, onSome: (wiring) => wiring.resolve })),
);

export function configuredStaveMemory(
  resolution: StaveMemoryResolution,
): StaveMemoryConfig | undefined {
  return resolution.state === "configured" ? resolution.config : undefined;
}

/** ACP stdio server list (Grok, Antigravity, Copilot and other ACP flavors). */
export function staveMemoryAcpMcpServers(
  resolution: StaveMemoryResolution,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  const config = configuredStaveMemory(resolution);
  if (config === undefined) return [];
  return [
    {
      name: STAVE_MEMORY_MCP_SERVER_NAME,
      command: config.command,
      args: [...config.args],
      env: Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value })),
    },
  ];
}

/** `AcpAdapterV2Options.extraMcpServers` for a resolver. */
export function staveMemoryAcpExtraMcpServers(
  resolve: StaveMemoryResolver,
): (cwd: string) => Effect.Effect<ReadonlyArray<EffectAcpSchema.McpServer>> {
  return (cwd) => resolve(cwd).pipe(Effect.map(staveMemoryAcpMcpServers));
}

/** Cursor Agent SDK `mcpServers` entries (stdio). */
export function staveMemoryCursorMcpServers(resolution: StaveMemoryResolution):
  | Record<
      string,
      {
        readonly type: "stdio";
        readonly command: string;
        readonly args: Array<string>;
        readonly env?: Record<string, string>;
      }
    >
  | undefined {
  const config = configuredStaveMemory(resolution);
  if (config === undefined) return undefined;
  return {
    [STAVE_MEMORY_MCP_SERVER_NAME]: {
      type: "stdio",
      command: config.command,
      args: [...config.args],
      ...(config.env === undefined ? {} : { env: { ...config.env } }),
    },
  };
}

/**
 * Codex `thread/start|resume|fork` config overrides for Stave memory.
 *
 * Codex recursively merges MCP tables across config layers, so the memory
 * server runs under a session-local name (`sm_<id>`) where stale env or
 * transport fields from a user's `context-marmot` entry cannot survive, and
 * the canonical `context-marmot` entry is disabled. A disabled entry still
 * needs a valid transport, so the command is only set when the user's own
 * config has no canonical entry; a conflicting entry then fails validation
 * instead of running.
 */
export function codexStaveMemoryMcpServers(input: {
  readonly config: StaveMemoryConfig;
  readonly canonicalExists: boolean;
  readonly sessionServerName: string;
}): Readonly<Record<string, Schema.Json>> {
  return {
    [STAVE_MEMORY_MCP_SERVER_NAME]: {
      enabled: false,
      ...(input.canonicalExists ? {} : { command: input.config.command }),
    },
    [input.sessionServerName]: {
      command: input.config.command,
      args: [...input.config.args],
      env: { ...input.config.env },
    },
  };
}

/** Launch context the Codex adapter resolves per session. */
export interface CodexStaveMemoryLaunch {
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export type CodexStaveMemoryMcpResolver = (
  launch: CodexStaveMemoryLaunch,
) => Effect.Effect<Readonly<Record<string, Schema.Json>> | undefined, CodexMcpInventoryError>;

/**
 * Builds the Codex resolver: reads the space's memory entry, asks Codex (with
 * the session's own launch args and home) whether a canonical
 * `context-marmot` entry exists, and returns the `mcp_servers` overrides.
 */
export function makeCodexStaveMemoryMcpResolver(deps: {
  readonly resolve: StaveMemoryResolver;
  readonly runner: ProcessRunner["Service"];
  readonly randomUuid: Effect.Effect<string>;
}): CodexStaveMemoryMcpResolver {
  return (launch) =>
    Effect.gen(function* () {
      const config = configuredStaveMemory(yield* deps.resolve(launch.cwd));
      if (config === undefined) return undefined;
      const canonicalExists = yield* hasCanonicalMarmotServer(
        {
          binaryPath: launch.settings.binaryPath || "codex",
          cwd: launch.cwd,
          launchArgs: resolveCodexLaunchArgs(launch.settings.launchArgs, launch.environment),
          ...(launch.settings.homePath ? { homePath: launch.settings.homePath } : {}),
          environment: launch.environment,
        },
        deps.runner,
      );
      return codexStaveMemoryMcpServers({
        config,
        canonicalExists,
        sessionServerName: codexStaveMemorySessionServerName(yield* deps.randomUuid),
      });
    });
}

/** Session-local Codex MCP server name for one session's memory server. */
function codexStaveMemorySessionServerName(uuid: string): string {
  return `sm_${uuid.replaceAll("-", "").slice(0, 12)}`;
}

/** OpenCode `mcp.add` config for the memory server. */
export function staveMemoryOpenCodeMcpConfig(config: StaveMemoryConfig) {
  return {
    type: "local" as const,
    command: [config.command, ...config.args],
    ...(config.env ? { environment: { ...config.env } } : {}),
    enabled: true,
  };
}
