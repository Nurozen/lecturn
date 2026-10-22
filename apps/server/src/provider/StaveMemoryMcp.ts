/**
 * Codex-specific Stave memory MCP wiring for orchestration-v2 adapters.
 *
 * A live Stave space whose manifest enables Marmot memory carries a generated
 * `context-marmot` entry in its root `.mcp.json`. `StaveMemoryWiring` reads and
 * validates that entry. Provider-neutral helpers (resolver, ACP, Cursor and
 * OpenCode shapes) live in `@lecturn/provider-core/server/staveMemory`; this
 * module only adds the Codex overrides, which need the server's process runner
 * and Codex MCP inventory.
 *
 * @module provider/StaveMemoryMcp
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
