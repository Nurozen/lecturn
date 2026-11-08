/**
 * Some ACP agents (Grok) report an MCP call's completion without its result, so Lecturn's `/mcp`
 * keeps app tool results briefly for the adapter to fill the row. A result matches a call by
 * thread, tool and arguments, and only if served after the agent announced the call. `/mcp`
 * records every app tool result but drops media blocks, which would pin megabytes per entry.
 */

export interface ServedAppToolCall {
  readonly threadId: string;
  /** The name the agent called on Lecturn's server, e.g. `rw_simulate`. */
  readonly tool: string;
  readonly args: unknown;
}

interface ServedEntry extends ServedAppToolCall {
  readonly argsKey: string;
  readonly result: unknown;
  readonly servedAt: number;
  claimedBy: string | undefined;
}

// Results the provider already reported are never claimed, so the store is
// bounded by count and age rather than by consumption.
const MAX_SERVED = 32;
const SERVED_TTL_MS = 5 * 60_000;
// The agent may announce a call in the same update that completes it.
const ANNOUNCE_SLACK_MS = 1_000;

let served: Array<ServedEntry> = [];

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableKey(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const MEDIA_BLOCK_TYPES = new Set(["image", "audio"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function withoutMedia(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const content = result.content.filter(
    (block) => !(isRecord(block) && MEDIA_BLOCK_TYPES.has(String(block.type))),
  );
  return content.length === result.content.length ? result : { ...result, content };
}

function prune(now: number): void {
  served = served.filter((entry) => now - entry.servedAt <= SERVED_TTL_MS).slice(-MAX_SERVED);
}

export function recordServedAppToolResult(
  call: ServedAppToolCall & { readonly result: unknown },
  now: number,
): void {
  served.push({
    ...call,
    result: withoutMedia(call.result),
    argsKey: stableKey(call.args),
    servedAt: now,
    claimedBy: undefined,
  });
  prune(now);
}

/**
 * The result Lecturn served for this call, or `undefined`. The same `callId`
 * gets the same result on every later update of its row.
 */
export function claimServedAppToolResult(
  call: Omit<ServedAppToolCall, "args"> & {
    /** `undefined` when the agent did not report them; the tool alone then decides. */
    readonly args: unknown;
    readonly callId: string;
    /** When the agent announced the call, in epoch milliseconds. */
    readonly startedAt: number;
  },
  now: number,
): unknown {
  prune(now);
  const claim = `${call.threadId}\u0000${call.callId}`;
  const claimed = served.find((entry) => entry.claimedBy === claim);
  if (claimed !== undefined) return claimed.result;
  const argsKey = call.args === undefined ? undefined : stableKey(call.args);
  // Oldest first, so identical calls take their results in the order they were served.
  const match = served.find(
    (entry) =>
      entry.claimedBy === undefined &&
      entry.threadId === call.threadId &&
      entry.tool === call.tool &&
      entry.servedAt >= call.startedAt - ANNOUNCE_SLACK_MS &&
      (argsKey === undefined || entry.argsKey === argsKey),
  );
  if (match === undefined) return undefined;
  match.claimedBy = claim;
  return match.result;
}

/** For tests: served results are process-wide. */
export function resetServedAppToolResults(): void {
  served = [];
}
