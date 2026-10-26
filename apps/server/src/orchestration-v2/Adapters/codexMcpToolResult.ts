import * as Predicate from "effect/Predicate";

const MCP_CONTENT_BLOCK_TYPES = new Set(["text", "image", "audio", "resource", "resource_link"]);

function isMcpContentBlock(block: unknown): boolean {
  return (
    Predicate.isObject(block) &&
    typeof block.type === "string" &&
    MCP_CONTENT_BLOCK_TYPES.has(block.type)
  );
}

/**
 * Codex can hand an MCP result over as a single text block holding the whole
 * `CallToolResult` as JSON (seen for an app tool returning an image). Every
 * reader of tool output expects the MCP shape: the row's `lecturn/summary`,
 * the card envelope, image serving and the stored-image strip. Behind a JSON
 * string they find nothing, and the wire projection will not parse a string
 * that large, so the result is restored here.
 */
export function codexMcpToolResult(result: unknown): unknown {
  if (!Predicate.isObject(result) || result.structuredContent != null) return result;
  const blocks = result.content;
  if (!Array.isArray(blocks) || blocks.length !== 1) return result;
  const [block] = blocks;
  if (
    !Predicate.isObject(block) ||
    block.type !== "text" ||
    typeof block.text !== "string" ||
    !block.text.trimStart().startsWith("{")
  ) {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    return result;
  }
  // A tool whose own text happens to be JSON stays as it was.
  if (
    !Predicate.isObject(parsed) ||
    !Array.isArray(parsed.content) ||
    !parsed.content.every(isMcpContentBlock)
  ) {
    return result;
  }
  return parsed._meta == null && result._meta != null ? { ...parsed, _meta: result._meta } : parsed;
}
