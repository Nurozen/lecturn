/**
 * Codex-only Stave memory overrides; they need the server's process runner and Codex MCP
 * inventory. Provider-neutral helpers live in `@lecturn/provider-core/server/staveMemory`.
 */
import type { CodexSettings } from "@lecturn/contracts";
import {
  configuredStaveMemory,
  STAVE_MEMORY_MCP_SERVER_NAME,
  type StaveMemoryConfig,
  type StaveMemoryResolver,
} from "@lecturn/provider-core/server/staveMemory";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import type { ProcessRunner } from "../processRunner.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import { type CodexMcpInventoryError, hasCanonicalMarmotServer } from "./codexMcpInventory.ts";

/**
 * Codex merges MCP tables across config layers, so memory runs as session-local `sm_<id>`, where a
 * user's stale `context-marmot` fields cannot survive, and the canonical entry is disabled. A
 * disabled entry still needs a transport: the command is set only when the user has no canonical
 * entry, so a conflicting one fails validation instead of running.
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
