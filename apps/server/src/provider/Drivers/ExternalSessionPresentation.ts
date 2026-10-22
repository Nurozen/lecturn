/**
 * Provider-neutral summaries for external-session imports: tool classification
 * and titles for imported Claude and Codex history. Carried over from the V1
 * Claude/Codex adapters, which owned them before orchestration v2.
 *
 * @module provider/Drivers/ExternalSessionPresentation
 */
import type { CanonicalItemType } from "@lecturn/contracts";
import { isWorkspaceImagePreviewPath } from "@lecturn/shared/filePreview";

/** An import shows the tail of the session: only its last messages are copied. */
export const IMPORT_HISTORY_MAX_MESSAGES = 200;

// --- Claude -----------------------------------------------------------------

type ClaudeMessageLike = { readonly type: string; readonly message?: unknown };

function readToolImagePath(toolName: string, input: Record<string, unknown>): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized !== "read" && normalized !== "read file") {
    return undefined;
  }
  const pathValue = input.file_path ?? input.path;
  if (typeof pathValue !== "string") {
    return undefined;
  }
  const path = pathValue.trim();
  return path.length > 0 && isWorkspaceImagePreviewPath(path) ? path : undefined;
}

export function classifyToolItemType(
  toolName: string,
  input: Record<string, unknown> = {},
): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (readToolImagePath(toolName, input)) {
    return "image_view";
  }
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

function extractAssistantContentBlocks(
  message: ClaudeMessageLike,
  blockType: "text" | "thinking",
  field: "text" | "thinking",
): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown; thinking?: unknown };
    const value = field === "thinking" ? candidate.thinking : candidate.text;
    if (candidate.type === blockType && typeof value === "string" && value.length > 0) {
      fragments.push(value);
    }
  }

  return fragments;
}

export function extractAssistantTextBlocks(message: ClaudeMessageLike): Array<string> {
  return extractAssistantContentBlocks(message, "text", "text");
}

// --- Codex ------------------------------------------------------------------

/** The loosely decoded Codex thread item an import reads. */
type CodexImportItem = { readonly type: string } & Record<string, unknown>;

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeMcpIntentTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= 80 ? normalized : `${characters.slice(0, 79).join("")}…`;
}

function normalizedMcpToolName(value: string): string {
  return (
    value
      .split(/__|[./:]/u)
      .at(-1)
      ?.trim() ?? value.trim()
  );
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

/** Summary title for an imported Codex item (computer-use phrasing is a live-only detail). */
export function itemTitle(itemType: CanonicalItemType, item?: CodexImportItem): string | undefined {
  if (
    itemType === "mcp_tool_call" &&
    item?.type === "mcpToolCall" &&
    typeof item.server === "string" &&
    typeof item.tool === "string"
  ) {
    if (normalizedMcpToolName(item.tool) === "js") {
      const intentTitle = normalizeMcpIntentTitle(asUnknownRecord(item.arguments)?.title);
      if (intentTitle) return intentTitle;
    }
    return `${item.server} · ${item.tool}`;
  }
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

export function itemDetail(itemType: CanonicalItemType, item: CodexImportItem): string | undefined {
  const action = asUnknownRecord(item.action);
  const actionQueries = Array.isArray(action?.queries) ? action.queries : [];
  const candidates = [
    ...(itemType === "web_search"
      ? [item.query, action?.query, ...actionQueries, action?.pattern, action?.url]
      : []),
    item.command,
    item.title,
    item.summary,
    item.text,
    item.path,
    item.prompt,
  ];

  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}
