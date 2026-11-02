import * as Schema from "effect/Schema";

/**
 * Turning off the MCP servers Codex loads by itself: the user's, a project's,
 * and those plugins and apps bring. Squire threads do it in app-server thread
 * config; `textGeneration/CodexTextGeneration.ts` does it on the `codex exec`
 * command line with its own flags.
 */

// Plugins and apps bring MCP servers of their own; the user's are listed and
// turned off by name.
export const CODEX_NO_PLUGIN_CONFIG = {
  "features.plugins": false,
  "features.apps": false,
} as const;

/** `codex mcp list --json` output. */
export const CodexMcpServerList = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);

/**
 * `mcp_servers={}` merges into the user's servers rather than replacing them,
 * so each is named; quoting the name keeps one with a dot a single key.
 */
export const codexMcpServersOffArg = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;

/** The thread-config form of {@link codexMcpServersOffArg}. */
export const codexMcpServersOffConfig = (
  names: ReadonlyArray<string>,
): Record<string, { readonly enabled: false }> =>
  Object.fromEntries(names.map((name) => [name, { enabled: false as const }]));

/**
 * Server names in an app-server `config/read` result. The effective config,
 * read with the thread's cwd, includes the user's and the project's layers.
 */
export function codexConfiguredMcpServerNames(config: unknown): ReadonlyArray<string> {
  if (typeof config !== "object" || config === null) return [];
  const servers = (config as { readonly mcp_servers?: unknown }).mcp_servers;
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? Object.keys(servers)
    : [];
}
