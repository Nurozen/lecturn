/**
 * Lecturn: Stave memory MCP wiring shared by the provider packages.
 *
 * A live Stave space whose manifest enables Marmot memory carries a generated
 * `context-marmot` entry in its root `.mcp.json`. The server's
 * `StaveMemoryWiring` layer (apps/server `stave/StaveMemoryWiring.ts`) reads
 * and validates that entry; the service tag and the provider-neutral helpers
 * live here so packaged adapters (Cursor, Grok, OpenCode) can register the
 * memory server next to the `lecturn` MCP server.
 *
 * @module provider-core/server/staveMemory
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const STAVE_MEMORY_MCP_SERVER_NAME = "context-marmot";

/** The validated `context-marmot` stdio entry of a space's `.mcp.json`. */
export const StaveMemoryMcpConfig = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.Array(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type StaveMemoryConfig = typeof StaveMemoryMcpConfig.Type;

export type StaveMemoryResolution =
  | { readonly state: "absent" }
  | { readonly state: "configured"; readonly config: StaveMemoryConfig }
  | { readonly state: "unavailable"; readonly code: "missing_config" | "invalid_config" };

export class StaveMemoryWiring extends Context.Service<
  StaveMemoryWiring,
  {
    readonly resolve: (cwd: string) => Effect.Effect<StaveMemoryResolution>;
  }
>()("@lecturn/provider-core/server/staveMemory/StaveMemoryWiring") {}

/** A wiring that never finds a memory entry (tests, Stave disabled). */
export const noop = StaveMemoryWiring.of({ resolve: () => Effect.succeed({ state: "absent" }) });
export const layerNoop = Layer.succeed(StaveMemoryWiring, noop);

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

/** ACP stdio MCP server entry (structurally an `effect-acp` `McpServer`). */
export interface StaveMemoryAcpMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: Array<string>;
  readonly env: Array<{ readonly name: string; readonly value: string }>;
}

/** ACP stdio server list (Grok, Antigravity, Copilot and other ACP flavors). */
export function staveMemoryAcpMcpServers(
  resolution: StaveMemoryResolution,
): ReadonlyArray<StaveMemoryAcpMcpServer> {
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
): (cwd: string) => Effect.Effect<ReadonlyArray<StaveMemoryAcpMcpServer>> {
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

/** OpenCode `mcp.add` config for the memory server. */
export function staveMemoryOpenCodeMcpConfig(config: StaveMemoryConfig) {
  return {
    type: "local" as const,
    command: [config.command, ...config.args],
    ...(config.env ? { environment: { ...config.env } } : {}),
    enabled: true,
  };
}
