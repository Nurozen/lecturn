import { lecturnResultMeta } from "@lecturn/shared/appToolPresentation";
import { MCP_APP_OUTPUT_KEY } from "@lecturn/shared/mcpApp";
import * as Predicate from "effect/Predicate";

/** The name Codex runs Lecturn's MCP server under (see `codexThreadRuntimeParams`). */
const CODEX_LECTURN_MCP_SERVER = "lecturn";

const MCP_CONTENT_BLOCK_TYPES = new Set(["text", "image", "audio", "resource", "resource_link"]);
// Codex serializes a result's members as content, structuredContent, isError,
// _meta, with no whitespace.
const SERIALIZED_RESULT_START = '{"content":[';
const TRUNCATION_MARKER = /…\d+ (?:chars|tokens) truncated…/gu;
const MAX_MEMBER_CANDIDATES = 16;

function isMcpContentBlock(block: unknown): boolean {
  return (
    Predicate.isObject(block) &&
    typeof block.type === "string" &&
    MCP_CONTENT_BLOCK_TYPES.has(block.type)
  );
}

function wholeResult(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Predicate.isObject(parsed) &&
    Array.isArray(parsed.content) &&
    parsed.content.every(isMcpContentBlock)
    ? parsed
    : undefined;
}

/**
 * Only the member that ends `body` parses from its key on: one nested deeper is
 * followed by its parents' closing brackets.
 */
function takeLastMember(
  body: string,
  key: string,
): { readonly value: unknown; readonly rest: string } | undefined {
  const needle = `,"${key}":`;
  let at = body.lastIndexOf(needle);
  for (let tried = 0; at !== -1 && tried < MAX_MEMBER_CANDIDATES; tried += 1) {
    try {
      return { value: JSON.parse(body.slice(at + needle.length)), rest: body.slice(0, at) };
    } catch {
      at = at === 0 ? -1 : body.lastIndexOf(needle, at - 1);
    }
  }
  return undefined;
}

/**
 * What follows the marker is a contiguous end of the serialized result, so its
 * last members are whole when they are small: the row summary in `_meta` and a
 * card's envelope in `structuredContent`. Nothing before it is trusted, since
 * a cut through one string can still parse with the marker inside it. The cut
 * content (an image's bytes) cannot be restored, so the marker stands for it.
 */
function truncatedResult(
  text: string,
  marker: RegExpExecArray,
): Record<string, unknown> | undefined {
  if (!text.endsWith("}")) return undefined;
  let body = text.slice(marker.index + marker[0].length, -1);
  const meta = takeLastMember(body, "_meta");
  if (meta !== undefined) body = meta.rest;
  const isError = takeLastMember(body, "isError");
  if (isError !== undefined) body = isError.rest;
  const structured = takeLastMember(body, "structuredContent");
  return {
    content: [{ type: "text", text: marker[0] }],
    ...(structured === undefined ? {} : { structuredContent: structured.value }),
    ...(isError?.value === true ? { isError: true } : {}),
    ...(meta === undefined ? {} : { _meta: meta.value }),
  };
}

/**
 * The toolkit stamps Lecturn's `_meta` on every app tool result, as its last
 * member, so it survives Codex's cut too. Anything else is a tool's own text,
 * however much it looks like a serialized result, and is kept whole.
 */
function isLecturnAppResult(result: Record<string, unknown>): boolean {
  return (
    lecturnResultMeta(result._meta) !== undefined ||
    (Predicate.isObject(result.structuredContent) && MCP_APP_OUTPUT_KEY in result.structuredContent)
  );
}

/**
 * Codex replaces an MCP result whose JSON passes its event limit (1 MiB, which
 * an app tool's image reaches) with one text block holding the head and tail
 * of that JSON around a `…N chars truncated…` marker, and drops its
 * `structuredContent` and `_meta`. Every reader of tool output expects the MCP
 * shape: the row's `lecturn/summary`, the card envelope, image serving and the
 * stored-image strip. Behind that string they find nothing, and the string is
 * too large to store or to parse on the wire, so an app tool's result is
 * restored here.
 */
export function codexMcpToolResult(call: {
  readonly server: string;
  readonly result?: unknown;
}): unknown {
  const { result } = call;
  if (
    call.server !== CODEX_LECTURN_MCP_SERVER ||
    !Predicate.isObject(result) ||
    result.structuredContent != null
  ) {
    return result;
  }
  const blocks = result.content;
  if (!Array.isArray(blocks) || blocks.length !== 1) return result;
  const [block] = blocks;
  if (
    !Predicate.isObject(block) ||
    block.type !== "text" ||
    typeof block.text !== "string" ||
    !block.text.startsWith(SERIALIZED_RESULT_START)
  ) {
    return result;
  }
  const marker = [...block.text.matchAll(TRUNCATION_MARKER)].at(-1);
  const parsed =
    marker === undefined ? wholeResult(block.text) : truncatedResult(block.text, marker);
  if (parsed === undefined) return result;
  const restored =
    parsed._meta == null && result._meta != null ? { ...parsed, _meta: result._meta } : parsed;
  return isLecturnAppResult(restored) ? restored : result;
}
