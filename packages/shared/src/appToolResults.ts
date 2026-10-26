/**
 * Some ACP agents (Grok) report an MCP call's completion without its result,
 * so an app tool row would lose its card and summary. Lecturn's own `/mcp`
 * served that call, in the same process, so it keeps what it returned for a
 * short while and the adapter fills the row from it.
 *
 * A served result is matched to a call by thread, tool and arguments, and only
 * if it was served after the agent announced the call, so a result from an
 * earlier call (or an earlier provider on the thread) never fills a later one.
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

function prune(now: number): void {
  served = served.filter((entry) => now - entry.servedAt <= SERVED_TTL_MS).slice(-MAX_SERVED);
}

export function recordServedAppToolResult(
  call: ServedAppToolCall & { readonly result: unknown },
  now: number,
): void {
  served.push({ ...call, argsKey: stableKey(call.args), servedAt: now, claimedBy: undefined });
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
