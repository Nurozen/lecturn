import {
  holdRemaining,
  squireCardOrigins,
  type SquireEnvironmentState,
  type SquireRuleNames,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  SquireActionLogEntry,
  SquireActionLogKind,
  SquireCardId,
  SquireCardKind,
  SquireId,
  SquireRule,
  SquireSnapshot,
  ThreadId,
} from "@lecturn/contracts";

// ── Page state ────────────────────────────────────────────────

export type SquirePageState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly entry: SquireSnapshotEntry;
      readonly isLead: boolean;
    };

/** `capable` is null until the server config arrives, so a slow config never reads as "off". */
export function squirePageState(
  capable: boolean | null,
  state: SquireEnvironmentState | null,
  squireId: SquireId,
): SquirePageState {
  if (capable === false) return { status: "unavailable" };
  if (capable === null || state === null) return { status: "loading" };
  const entry = state.squires.find((candidate) => candidate.squire.id === squireId);
  if (entry === undefined) return { status: "unavailable" };
  return { status: "ready", entry, isLead: entry.squire.role === "lead" };
}

// ── Layout ────────────────────────────────────────────────────

/** Main width from which the 340 px companion panel fits beside the chat. */
const SQUIRE_VIEW_WIDE_PX = 1100;
export const SQUIRE_COMPANION_PANEL_PX = 340;

/** The side of the panel breakpoint a width is on, so a resize re-renders only on a cross. */
export const squireViewWide = (mainWidthPx: number) => mainWidthPx >= SQUIRE_VIEW_WIDE_PX;

// ── Activity ──────────────────────────────────────────────────

/**
 * True for outcomes that happen outside a turn, which have no row in the home thread.
 * Every other kind is already a thread row or card state. Exhaustive, so a new log kind
 * fails typecheck until it is classified.
 */
const IN_ACTIVITY: Readonly<Record<Exclude<SquireActionLogKind, "unknown">, boolean>> = {
  "event.received": false,
  "tool.called": false,
  "decision.recorded": false,
  "card.created": false,
  "action.held": false,
  "action.executed": true,
  "action.undone": true,
  "action.cancelled": true,
  "action.accepted": false,
  "notification.pushed": false,
  "notification.delivery": true,
  "quiet.recorded": false,
  "control.reverted": false,
  "task.routed": false,
  "rule.created": false,
  "rule.removed": false,
  "rule.matched": false,
  "sweep.ran": false,
  "sweep.finding": false,
  "trigger.received": true,
  "trigger.rate-limited": true,
  "trigger.rejected": true,
  "automation.prompted": false,
  "automation.paused": false,
  "automation.resumed": false,
  "message.sent": false,
  "message.rejected": false,
  "room.proposed": true,
  "room.opened": true,
  "room.closed": true,
  "room.reopened": true,
  "room.routed": true,
  "room.rerouted": true,
  "room.routing-fallback": true,
};

export const SQUIRE_ACTIVITY_KINDS: ReadonlyArray<SquireActionLogKind> = (
  Object.keys(IN_ACTIVITY) as Array<keyof typeof IN_ACTIVITY>
).filter((kind) => IN_ACTIVITY[kind]);

const words = (text: string) => text.replaceAll(/[-_]/g, " ");

export function squireActivityLabel(entry: Pick<SquireActionLogEntry, "kind" | "data">): string {
  const data = entry.data;
  switch (entry.kind) {
    case "action.executed":
      if (data.action === "steer") return "Sent a steer";
      if (data.action === "create_thread") return "Created a thread";
      return "Ran an action";
    case "action.undone":
      return "Undone before it ran";
    case "action.cancelled":
      return data.to === "outdated" ? "Held action outdated" : "Held action cancelled";
    case "notification.delivery":
      return typeof data.outcome === "string"
        ? `Notification: ${words(data.outcome)}`
        : "Notification delivered";
    case "trigger.received":
      return "Trigger received";
    case "trigger.rate-limited":
      return "Trigger rate-limited";
    case "trigger.rejected":
      return "Trigger rejected";
    default: {
      const [area, action] = entry.kind.split(".");
      return action === undefined
        ? words(entry.kind)
        : `${area![0]!.toUpperCase()}${area!.slice(1)} ${words(action)}`;
    }
  }
}

/** How many rows the companion panel's "Recent" list shows. */
const SQUIRE_RECENT_ACTIVITY_LIMIT = 4;

/**
 * Log kinds that never get their own Recent row: each only accompanies a row that already says
 * what happened (a card's decision and push), or is delivery detail the Activity popover lists.
 */
const RECENT_HIDDEN: ReadonlySet<SquireActionLogKind> = new Set([
  "action.accepted",
  "decision.recorded",
  "notification.pushed",
  "notification.delivery",
  "unknown",
]);

/** The action-log kinds the companion panel reads for its Recent list. */
export const SQUIRE_RECENT_KINDS: ReadonlyArray<SquireActionLogKind> = (
  Object.keys(IN_ACTIVITY) as Array<keyof typeof IN_ACTIVITY>
).filter((kind) => !RECENT_HIDDEN.has(kind));

/** Enough log rows that the folded and hidden ones still leave a full Recent list. */
export const SQUIRE_RECENT_LOG_LIMIT = 24;

// Reads of one thread; the log row names it. Other lookups (lists, rooms) stay out of Recent.
const LOOK_TOOLS: ReadonlySet<string> = new Set(["squire_get_summary", "squire_get_detail"]);

const RAISED_BY_KIND: Readonly<Record<SquireCardKind, string>> = {
  steer: "Recommended a steer",
  question: "Raised a question",
  overlap: "Raised an overlap",
  proposal: "Proposed a thread",
  fyi: "Raised an FYI",
};

const NO_DATA: Readonly<Record<string, unknown>> = {};
const NO_NAMES = { threadTitle: null, cardTitle: null } as const;

/**
 * A Recent row's user-facing label, or null for a row that never shows (see RECENT_HIDDEN, and
 * tool calls whose outcome row says what they did). `names` are the thread and card the row
 * points at, when the client knows them.
 */
export function squireRecentLabel(
  entry: Pick<SquireActionLogEntry, "kind" | "data">,
  names: { readonly threadTitle: string | null; readonly cardTitle: string | null },
): string | null {
  const data = entry.data;
  if (RECENT_HIDDEN.has(entry.kind)) return null;
  switch (entry.kind) {
    case "event.received":
      return data.kind === "voice-note" ? "Heard a voice note" : "Event batch received";
    case "tool.called":
      if (typeof data.tool !== "string" || !LOOK_TOOLS.has(data.tool)) return null;
      return names.threadTitle === null ? "Looked at a thread" : `Looked at ${names.threadTitle}`;
    case "card.created": {
      if (data.source === "notify") return "Notified you";
      if (data.kind === "proposal") return squireProposedLabel(data, names.cardTitle);
      if (names.cardTitle !== null) return `Raised: ${names.cardTitle}`;
      return typeof data.kind === "string" && Object.hasOwn(RAISED_BY_KIND, data.kind)
        ? RAISED_BY_KIND[data.kind as SquireCardKind]
        : "Raised a card";
    }
    case "action.held":
      return names.cardTitle === null ? "Held an action" : `Holding: ${names.cardTitle}`;
    case "action.executed":
      if (data.action === "steer") {
        return names.threadTitle === null ? "Sent a steer" : `Sent a steer to ${names.threadTitle}`;
      }
      if (data.action === "create_thread") return "Started a thread";
      if (data.action === "create_squire") return "Created a Squire";
      if (data.action === "room-open") return "Opened a room";
      return squireActivityLabel(entry);
    case "quiet.recorded":
      return "Stayed quiet";
    case "message.sent":
      return data.roomId === undefined ? "Messaged a Squire" : "Posted in a room";
    case "task.routed":
      return "Routed a task";
    default:
      return squireActivityLabel(entry);
  }
}

// The server titles a Squire proposal's card "New Squire: <name>".
const SQUIRE_PROPOSAL_TITLE_PREFIX = "New Squire:";

/** A proposal's Recent label: a Squire proposal names the Squire, a room proposal says so. */
function squireProposedLabel(
  data: Readonly<Record<string, unknown>>,
  cardTitle: string | null,
): string {
  if (data.room !== undefined) return "Proposed a room";
  if (data.proposal !== "squire") return "Proposed a thread";
  const name =
    typeof data.name === "string"
      ? data.name.trim()
      : cardTitle?.startsWith(SQUIRE_PROPOSAL_TITLE_PREFIX)
        ? cardTitle.slice(SQUIRE_PROPOSAL_TITLE_PREFIX.length).trim()
        : (cardTitle?.trim() ?? "");
  return name === "" ? "Proposed a Squire" : `Proposed a Squire: ${name}`;
}

export interface SquireRecentEntry {
  readonly key: string;
  readonly kind: SquireActionLogKind;
  readonly data: Readonly<Record<string, unknown>>;
  readonly threadId: ThreadId | null;
  readonly cardId: SquireCardId | null;
  readonly at: string;
  /** Identical consecutive actions fold into one row ("Sent a steer to X ×2"). */
  readonly count?: number;
}

/** What makes two Recent rows read the same: kind, the action or kind it names, and its target. */
const recentSignature = (entry: Pick<SquireRecentEntry, "kind" | "data" | "threadId" | "cardId">) =>
  JSON.stringify([
    entry.kind,
    entry.data.action ?? entry.data.kind ?? entry.data.tool ?? null,
    entry.threadId,
    entry.kind === "card.created" || entry.kind === "action.held" ? entry.cardId : null,
  ]);

/**
 * The companion panel's "Recent" list from the action log, newest first: rows that never show
 * are dropped, a delivery batch is one row, and a turn's thread reads are one row.
 */
export function squireRecentEntries(
  log: ReadonlyArray<
    Pick<
      SquireActionLogEntry,
      "id" | "kind" | "data" | "threadId" | "cardId" | "runId" | "createdAt"
    >
  >,
  limit: number = SQUIRE_RECENT_ACTIVITY_LIMIT,
): ReadonlyArray<SquireRecentEntry> {
  const rows: SquireRecentEntry[] = [];
  const folded = new Set<string>();
  for (const entry of log.toSorted((a, b) => b.id - a.id)) {
    if (rows.length >= limit) break;
    if (squireRecentLabel(entry, NO_NAMES) === null) continue;
    const fold =
      entry.kind === "event.received" && typeof entry.data.batchId === "string"
        ? `batch:${entry.data.batchId}`
        : entry.kind === "tool.called" && entry.runId !== null
          ? `look:${entry.runId}`
          : null;
    if (fold !== null) {
      if (folded.has(fold)) continue;
      folded.add(fold);
    }
    const row: SquireRecentEntry = {
      key: String(entry.id),
      kind: entry.kind,
      data: entry.data,
      threadId: entry.threadId,
      cardId: entry.cardId,
      at: entry.createdAt,
    };
    const previous = rows.at(-1);
    if (previous !== undefined && recentSignature(previous) === recentSignature(row)) {
      rows[rows.length - 1] = { ...previous, count: (previous.count ?? 1) + 1 };
      continue;
    }
    rows.push(row);
  }
  return rows;
}

/** A Recent row's text, with its fold count when it stands for several identical actions. */
export function squireRecentRowText(label: string, count: number | undefined): string {
  return count === undefined || count < 2 ? label : `${label} ×${count}`;
}

/**
 * Recent rows from the snapshot alone, while the log loads and for the hover card. It carries
 * only kinds, so labels are generic; a batch's later `event.received` rows have no gesture.
 */
export function squireRecentFromSnapshot(
  activity: ReadonlyArray<
    Pick<SquireSnapshot["recentActivity"][number], "sequence" | "kind" | "at" | "gesture">
  >,
  limit: number = SQUIRE_RECENT_ACTIVITY_LIMIT,
): ReadonlyArray<SquireRecentEntry> {
  return activity
    .filter(
      (entry) =>
        squireRecentLabel({ kind: entry.kind, data: NO_DATA }, NO_NAMES) !== null &&
        (entry.kind !== "event.received" || entry.gesture !== undefined),
    )
    .toSorted((a, b) => b.sequence - a.sequence)
    .slice(0, limit)
    .map((entry) => ({
      key: String(entry.sequence),
      kind: entry.kind,
      data: NO_DATA,
      threadId: null,
      cardId: null,
      at: entry.at,
    }));
}

// ── Banners ───────────────────────────────────────────────────

/**
 * Whole seconds left on a hold, and when that number next changes, so the banner re-renders
 * once a second and stops once the hold runs out.
 */
export function squireHoldCountdown(
  receivedAt: number,
  executesInMs: number,
  now: number,
): { readonly seconds: number; readonly nextChangeInMs: number | null } {
  const remaining = holdRemaining(receivedAt, executesInMs, now);
  if (remaining <= 0) return { seconds: 0, nextChangeInMs: null };
  return { seconds: Math.ceil(remaining / 1000), nextChangeInMs: remaining % 1000 || 1000 };
}

export function squireHoldText(
  kind: SquireCardKind,
  targetTitle: string | null,
  seconds: number,
): string {
  const action =
    kind === "steer"
      ? targetTitle === null
        ? "Sending a steer"
        : `Sending a steer to ${targetTitle}`
      : kind === "proposal"
        ? "Creating a thread"
        : "Acting";
  return seconds > 0 ? `${action} in ${seconds}s` : `${action} now`;
}

/**
 * A hold a saved rule started says so, as the notch does ("Auto by rule: <rule>").
 * Null while the card or its rules load, and for holds no rule started.
 */
export function squireHoldRuleLabel(
  card: Parameters<typeof squireCardOrigins>[0] | null,
  rules: ReadonlyArray<SquireRule>,
  names: SquireRuleNames,
): string | null {
  if (card === null || card.ruleId === null) return null;
  return (
    squireCardOrigins(card, rules, names).find((label) => label.startsWith("Auto by rule:")) ?? null
  );
}

/** Shown while any budget is spent, with `squireBudgetCaption`'s wording for the time. */
export function squireBudgetBanner(
  entry: Pick<SquireSnapshot, "budget"> & {
    readonly squire: { readonly budgets: { steersPerDay: number; threadsPerDay: number } };
  },
  formatTime: (iso: string) => string,
): { readonly text: string; readonly detail: string | null } | null {
  const { budget } = entry;
  const { steersPerDay, threadsPerDay } = entry.squire.budgets;
  // A zero allowance is a choice, not an exhausted budget.
  const spent = [
    steersPerDay > 0 && budget.steersLeft === 0 ? `0 of ${steersPerDay} steers left today` : null,
    threadsPerDay > 0 && budget.threadsLeft === 0
      ? `0 of ${threadsPerDay} threads left today`
      : null,
  ].filter((line) => line !== null);
  if (budget.recommendingUntil === undefined && spent.length === 0) return null;
  return {
    text:
      budget.recommendingUntil === undefined
        ? "Budget reached, recommending only"
        : `Budget reached, recommending only until ${formatTime(budget.recommendingUntil)}`,
    detail: spent.length === 0 ? null : spent.join(" · "),
  };
}

// ── Conversation pane ─────────────────────────────────────────

export type SquireConversationPane =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "needs_provider"; readonly title: string; readonly description: string }
  | { readonly kind: "pending" };

/** A Squire without a home thread shows its setup prompt where the conversation would be. */
export function squireConversationPane(
  squire: Pick<SquireSnapshot["squire"], "role" | "lifecycle" | "homeThreadId">,
  hasSupportedProvider?: boolean,
): SquireConversationPane {
  if (squire.homeThreadId !== null) return { kind: "thread", threadId: squire.homeThreadId };
  if (squire.lifecycle !== "needs_provider") return { kind: "pending" };
  if (hasSupportedProvider === false) {
    return {
      kind: "needs_provider",
      title: "No supported provider",
      description: "Set up a provider that can run Squires, then choose it here.",
    };
  }
  return {
    kind: "needs_provider",
    title: squire.role === "lead" ? "Choose a provider for the Lead" : "Choose a provider",
    description: "The conversation starts once a supported provider is chosen.",
  };
}

// ── Settings switch ───────────────────────────────────────────

/**
 * A server with `squireLiveSwitch` applies the saved switch at once, so the two differ only for
 * a moment. Older servers read it at start, so they differ until a restart, and for good when
 * `LECTURN_SQUIRE` overrides it.
 */
export function squireSwitchDescription(input: {
  readonly saved: boolean;
  readonly running: boolean;
  readonly live: boolean;
}): string {
  if (input.saved && input.running) {
    return "On. Each Squire watches the threads you give it and acts within the rules you set.";
  }
  if (input.live) {
    if (input.saved) return "Turning on…";
    if (input.running) return "Turning off…";
    return "Off. Turn on to set up a Lead and Squires.";
  }
  if (input.saved) {
    return "Saved as on. Squires start when this environment's server restarts. If they still don't, its LECTURN_SQUIRE variable is overriding this switch.";
  }
  if (input.running) {
    return "Saved as off. Squires keep running until this environment's server restarts. If they still don't stop, its LECTURN_SQUIRE variable is overriding this switch.";
  }
  return "Off. Turn on, then restart this environment's server, to set up a Lead and Squires.";
}
