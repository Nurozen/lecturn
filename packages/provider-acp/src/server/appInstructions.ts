import type { McpProviderSessionConfig } from "@lecturn/provider-core/server/mcpSession";

const code = (text: string) => `\`${text}\``;

function appToolsNote(
  app: NonNullable<McpProviderSessionConfig["app"]>,
  toolName: ((tool: string) => string) | undefined,
): string {
  if (toolName !== undefined) {
    return app.toolNames.length === 0
      ? `Call this app's tools by their full names, which start with ${code(toolName(`${app.toolPrefix}_`))}.`
      : `Call this app's tools by these exact names: ${app.toolNames.map((name) => code(toolName(name))).join(", ")}.`;
  }
  const names =
    app.toolNames.length === 0
      ? `named ${code(`${app.toolPrefix}_<tool>`)}`
      : app.toolNames.map(code).join(", ");
  return `This app's tools are on the ${code("lecturn")} MCP server: ${names}. Call each by the name your tool list shows for it, which may add the server's prefix.`;
}

/**
 * A connected app's instructions for an ACP agent, followed by the names to
 * call its tools by. ACP agents namespace MCP tools their own way (Grok lists
 * `lecturn__<tool>`), while the app's own text uses the bare names, which Grok
 * called first and got "not found".
 */
export function acpAppInstructions(input: {
  readonly instructions: string | undefined;
  readonly app: McpProviderSessionConfig["app"];
  readonly toolName: ((tool: string) => string) | undefined;
}): string | undefined {
  const instructions = input.instructions?.trim() || undefined;
  if (input.app === undefined) return instructions;
  const note = appToolsNote(input.app, input.toolName);
  return instructions === undefined ? note : `${instructions}\n\n${note}`;
}
