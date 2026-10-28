/**
 * Each adapter records a Lecturn MCP tool under its own name: Claude as
 * `mcp__lecturn__<tool>`, Codex as `lecturn.<tool>`, and OpenCode as
 * `lecturn-<thread>_<tool>`, because it runs one `lecturn-<thread>` server per
 * thread (see `lecturnMcpServerName` in provider-opencode).
 */
const LECTURN_MCP_TOOL_NAME = /^(?:mcp__lecturn__|lecturn\.|lecturn-[A-Za-z0-9-]+_)(.+)$/;

/**
 * The tool name as Lecturn's MCP server defines it, or null when the recorded
 * name is not a Lecturn MCP tool. OpenCode thread segments never contain `_`
 * (server thread ids are UUIDs, digests are hex), so the first `_` ends it.
 */
export function lecturnMcpToolName(recordedName: string | null | undefined): string | null {
  if (typeof recordedName !== "string") return null;
  return LECTURN_MCP_TOOL_NAME.exec(recordedName)?.[1] ?? null;
}
