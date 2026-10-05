/** Source-backed receipt hooks, not a claim of live provider qualification.
 * Delivery is available only through the adapter-local durable receipt observer.
 */
export type ContextualAcceptanceEvidence =
  | "codex-turn-start-response"
  | "acp-prompt-response"
  | "opencode-prompt-async-response"
  | "opencode-correlated-user-message"
  | "local-queue"
  | "local-dispatched"
  | "turn-started"
  | "turn-completed";

export interface ContextualProviderCapabilities {
  readonly delivery: "receipt-hook" | "unsupported";
  readonly acceptanceEvidence: ReadonlyArray<ContextualAcceptanceEvidence>;
  readonly nativeCompactionSignals: ReadonlyArray<string>;
  readonly authoritativeReconciliation: "correlated-user-message" | "unsupported";
  /** Unknown inheritance preserves suppression, including across process restart. */
  readonly automaticContinuity: false;
}

const unsupported: ContextualProviderCapabilities = {
  delivery: "unsupported",
  acceptanceEvidence: [],
  nativeCompactionSignals: [],
  authoritativeReconciliation: "unsupported",
  automaticContinuity: false,
};

export const contextualProviderCapabilities = {
  codex: {
    ...unsupported,
    delivery: "receipt-hook",
    acceptanceEvidence: ["codex-turn-start-response"],
    nativeCompactionSignals: ["thread/compacted", "item/completed:context_compaction"],
  },
  claude: {
    ...unsupported,
    nativeCompactionSignals: ["claude/system/compact_boundary"],
  },
  cursor: {
    ...unsupported,
    delivery: "receipt-hook",
    acceptanceEvidence: ["acp-prompt-response"],
  },
  grok: {
    ...unsupported,
    delivery: "receipt-hook",
    acceptanceEvidence: ["acp-prompt-response"],
  },
  githubCopilot: {
    ...unsupported,
    delivery: "receipt-hook",
    acceptanceEvidence: ["acp-prompt-response"],
  },
  opencode: {
    ...unsupported,
    delivery: "receipt-hook",
    acceptanceEvidence: ["opencode-correlated-user-message"],
    nativeCompactionSignals: ["session.compacted"],
    authoritativeReconciliation: "correlated-user-message",
  },
  antigravity: {
    ...unsupported,
    delivery: "receipt-hook",
    acceptanceEvidence: ["acp-prompt-response"],
  },
} as const satisfies Record<string, ContextualProviderCapabilities>;

/** Driver slugs are open; an unrecognized driver must not inherit another's proof. */
export function getContextualProviderCapabilities(driver: string): ContextualProviderCapabilities {
  switch (driver) {
    case "claudeAgent":
      return contextualProviderCapabilities.claude;
    case "codex":
    case "claude":
    case "cursor":
    case "grok":
    case "githubCopilot":
    case "opencode":
    case "antigravity":
      return contextualProviderCapabilities[driver];
    default:
      return unsupported;
  }
}

/** Call only after matching native session/request identity to the persisted dispatch.
 * Generic lifecycle events and ACP's local RPC-registration latch are not receipts.
 * ACP can synthesize a cancelled response on local interruption, so it is insufficient.
 */
export function supportsContextualAcceptanceEvidence(
  driver: string,
  observation: {
    readonly evidence: ContextualAcceptanceEvidence;
    readonly promptDispatched: boolean;
    readonly cancelled: boolean;
  },
): boolean {
  if (!observation.promptDispatched) return false;
  if (observation.evidence === "acp-prompt-response" && observation.cancelled) return false;
  return getContextualProviderCapabilities(driver).acceptanceEvidence.includes(
    observation.evidence,
  );
}

/** Accept native provenance only; a slash-command completion is not compaction proof.
 * The caller must deduplicate native aliases and fence the persistent context epoch.
 */
export function supportsContextualCompactionSignal(driver: string, nativeSignal: string): boolean {
  return getContextualProviderCapabilities(driver).nativeCompactionSignals.includes(nativeSignal);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
/** Reads only native durable cursor identities. A local thread id is not a native context. */
export function providerContextIdForSession(driver: string, resumeCursor: unknown): string | null {
  const cursor = objectRecord(resumeCursor);
  if (!cursor) return null;
  if (driver === "codex") return nonempty(cursor.threadId) ?? null;
  if (driver === "claude" || driver === "claudeAgent")
    return nonempty(cursor.resume) ?? nonempty(cursor.sessionId) ?? null;
  if (
    ["cursor", "grok", "githubCopilot", "opencode", "antigravity"].includes(driver) &&
    cursor.schemaVersion === 1
  )
    return nonempty(cursor.sessionId) ?? null;
  return null;
}
/** Host persists this key atomically with advancing its logical context epoch.
 * Unknown native identity returns null: never infer compaction from token count,
 * reconnect, local event UUID, command completion, or a session-only event.
 * Codex aliases collapse per native turn; multiple compactions in one turn are
 * conservatively treated as one boundary to avoid duplicate evidence re-supply.
 */
export function contextualCompactionBoundaryKey(
  event: import("@lecturn/contracts").ProviderRuntimeEvent,
  providerContextId: string | null,
): string | null {
  if (
    !providerContextId ||
    event.type !== "thread.state.changed" ||
    event.payload.state !== "compacted"
  )
    return null;
  const payload = objectRecord(event.raw?.payload);
  if (!payload) return null;
  const driver = String(event.provider);
  if (driver === "codex" && event.raw?.source === "codex.app-server.notification") {
    const item = objectRecord(payload.item);
    const valid =
      event.raw.method === "thread/compacted" ||
      (event.raw.method === "item/completed" &&
        (item?.type === "contextCompaction" || item?.type === "context_compaction"));
    const nativeTurn = nonempty(payload.turnId) ?? event.providerRefs?.providerTurnId;
    if (valid && nonempty(payload.threadId) === providerContextId && nativeTurn)
      return `codex:${providerContextId}:turn:${nativeTurn}`;
  }
  if (
    (driver === "claudeAgent" || driver === "claude") &&
    event.raw?.source === "claude.sdk.message" &&
    payload.type === "system" &&
    payload.subtype === "compact_boundary" &&
    payload.session_id === providerContextId
  ) {
    const uuid = nonempty(payload.uuid);
    if (uuid) return `claude:${providerContextId}:${uuid}`;
  }
  // OpenCode's session.compacted currently provides only sessionID. It proves
  // compaction occurred, but cannot be deduplicated across restart/replay.
  return null;
}
