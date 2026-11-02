import {
  holdRemaining,
  squireStateLine,
  type SquireEnvironmentState,
  type SquireQueueChip,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireActionLogEntry,
  SquireActionLogKind,
  SquireCardId,
  SquireCardKind,
  SquireId,
  SquireRule,
  SquireSnapshot,
  ThreadId,
} from "@lecturn/contracts";

import { squireCardOrigins, type SquireRuleNames } from "./queue/squireQueue.logic";
import type { SquireViewSearch } from "./squireView.logic";

// ── Page state ────────────────────────────────────────────────

export type SquirePageState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly entry: SquireSnapshotEntry;
      readonly isLead: boolean;
      /** The Lead's team strip; empty for any other Squire. */
      readonly team: ReadonlyArray<SquireSnapshotEntry>;
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
  const isLead = entry.squire.role === "lead";
  return {
    status: "ready",
    entry,
    isLead,
    team: isLead ? state.squires.filter((candidate) => candidate.squire.role !== "lead") : [],
  };
}

// ── Layout (D38) ──────────────────────────────────────────────

/** Main width from which the 340 px companion panel fits beside the queue. */
const SQUIRE_VIEW_WIDE_PX = 1100;
/**
 * Main width from which the inbox is offered: its 28rem list, a 30rem detail, the gap, and the
 * page inset. Lower than the panel's, since an open inbox collapses the panel; at a 1280 px
 * window the main is about 1024 px, so the inbox works there.
 */
export const SQUIRE_INBOX_MIN_PX = 960;
export const SQUIRE_COMPANION_PANEL_PX = 340;
/** The header portrait when the companion panel is collapsed or not mounted. */
export const SQUIRE_HEADER_PORTRAIT_PX = 64;
/** The Inbox toggle stays in the topbar below its width, disabled, so the entry never vanishes. */
export const SQUIRE_INBOX_NARROW_HINT = "Inbox needs a wider window";

export interface SquireViewLayout {
  readonly inboxOffered: boolean;
  readonly companionPanel: "shown" | "collapsed";
  readonly queueLayout: "list" | "inbox";
}

const isSquireViewWide = (mainWidthPx: number) => mainWidthPx >= SQUIRE_VIEW_WIDE_PX;

/** Which side of each layout breakpoint a width is on, so a resize re-renders only on a cross. */
export const squireViewBreakpoint = (mainWidthPx: number) =>
  (mainWidthPx >= SQUIRE_INBOX_MIN_PX ? 1 : 0) + (isSquireViewWide(mainWidthPx) ? 1 : 0);

/** The inbox and the 340 px panel do not fit together, so an open inbox collapses the panel. */
export function squireViewLayout(mainWidthPx: number, inboxOpen: boolean): SquireViewLayout {
  const inboxOffered = mainWidthPx >= SQUIRE_INBOX_MIN_PX;
  const inbox = inboxOffered && inboxOpen;
  return {
    inboxOffered,
    companionPanel: isSquireViewWide(mainWidthPx) && !inbox ? "shown" : "collapsed",
    queueLayout: inbox ? "inbox" : "list",
  };
}

// ── Route search ──────────────────────────────────────────────

/** Absent keys stay out of the URL, so "all", no item, and no team filter are the bare route. */
export function nextSquireViewSearch(
  search: SquireViewSearch,
  patch: {
    readonly chip?: SquireQueueChip;
    readonly item?: SquireCardId | null;
    readonly squire?: SquireId | null;
  },
): SquireViewSearch {
  const filter = patch.chip === undefined ? search.filter : patch.chip;
  const item = patch.item === undefined ? search.item : patch.item;
  const squire = patch.squire === undefined ? search.squire : patch.squire;
  return {
    ...(item == null ? {} : { item }),
    ...(filter === undefined || filter === "all" ? {} : { filter }),
    ...(squire == null ? {} : { squire }),
  };
}

// ── Activity (D64) ────────────────────────────────────────────

/**
 * D64: true for outcomes that happen outside a turn, which have no row in the home thread.
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

// ── Header lines ──────────────────────────────────────────────

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The Lead watches nothing itself (P17.3), so its scope line describes its team. While its
 * onboarding shows proposals, the line says so, so it never reads "No Squires yet" beside a
 * count of decisions waiting.
 */
export function squireLeadScopeLine(
  team: ReadonlyArray<{ readonly trackedCount: number }>,
  onboardingProposals = 0,
): string {
  const proposals =
    onboardingProposals > 0 ? count(onboardingProposals, "proposal", "proposals") : null;
  if (team.length === 0) {
    return proposals === null ? "No Squires yet" : `Setting up your Squires · ${proposals}`;
  }
  const watched = team.reduce((sum, member) => sum + member.trackedCount, 0);
  const line = `Leading ${count(team.length, "Squire", "Squires")} · ${count(watched, "thread", "threads")} watched`;
  return proposals === null ? line : `${line} · ${proposals}`;
}

/**
 * The Lead view lists its team's decisions beside its own, so its state line counts them all;
 * the sidebar badge still counts only the Lead's own items (D50).
 */
export function squireLeadStateLine(
  lead: Parameters<typeof squireStateLine>[0],
  team: ReadonlyArray<{
    readonly openDecisionCount: number;
    readonly leadRaisedDecisionCount?: number;
  }>,
): string {
  // A Squire's count includes Lead-raised items on its threads, which the Lead's own count
  // already has, so each counts once.
  const total = team.reduce(
    (sum, member) => sum + member.openDecisionCount - (member.leadRaisedDecisionCount ?? 0),
    lead.openDecisionCount,
  );
  const line = squireStateLine({ ...lead, openDecisionCount: total });
  if (line !== "Working" || total === 0) return line;
  return `Working · ${total} ${total === 1 ? "needs" : "need"} a decision`;
}

/**
 * The header's state line. Once the queue loads it counts the rows the queue's groups show, so
 * "N need a decision" is the "Needs a decision" group, Lead-raised items included, and holds
 * count as held; until then the snapshot's counts. The Lead's queue combines its team's.
 */
export function squireHeaderStateLine(
  input: Parameters<typeof squireStateLine>[0],
  queue: { readonly decisions: number; readonly held: number } | null,
  team: ReadonlyArray<{ readonly openDecisionCount: number }> | null,
): string {
  if (queue === null) {
    return team === null ? squireStateLine(input) : squireLeadStateLine(input, team);
  }
  const counted = { ...input, openDecisionCount: queue.decisions, heldCount: queue.held };
  return team === null ? squireStateLine(counted) : squireLeadStateLine(counted, []);
}

// ── Banners ───────────────────────────────────────────────────

/** The page-level hold banners: every hold until the queue loads, then those it does not show. */
export function squireUnshownHolds<Hold extends { readonly cardId: string }>(
  held: ReadonlyArray<Hold>,
  shownInQueue: ReadonlySet<string> | null,
): ReadonlyArray<Hold> {
  return shownInQueue === null ? held : held.filter((hold) => !shownInQueue.has(hold.cardId));
}

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
 * P8.1, 10c.4: a hold a saved rule started says so, as the notch does ("Auto by rule: <rule>").
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

/** P9.2: shown while any budget is spent, with `squireBudgetCaption`'s wording for the time. */
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

// ── Conversation pane (D63) ───────────────────────────────────

export type SquireConversationPane =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "needs_provider"; readonly title: string; readonly description: string }
  | { readonly kind: "pending" };

/** D7: a Squire without a home thread shows its setup prompt where the conversation would be. */
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

/**
 * The queue is the view's primary surface. Collapsed, the conversation is one slim line that
 * expands when focused. Expanded, the queue keeps its content height up to the larger of
 * `queueMinPx` and `queueMaxShare` of the view, so an open card's sticky actions stay on screen,
 * and the conversation takes the rest: most of the view when the queue is short.
 */
export type SquireConversationLayout =
  | { readonly kind: "none" }
  | { readonly kind: "prompt" }
  | { readonly kind: "slim" }
  | { readonly kind: "expanded"; readonly queueMaxShare: number; readonly queueMinPx: number };

export function squireConversationLayout(
  pane: SquireConversationPane,
  collapsed: boolean,
): SquireConversationLayout {
  if (pane.kind === "pending") return { kind: "none" };
  if (pane.kind === "needs_provider") return { kind: "prompt" };
  // A tall inline card (an MCP App) needs most of a 900 px window to read as more than its
  // header, so the pane gets everything the queue does not use; the queue's floor still wins.
  return collapsed ? { kind: "slim" } : { kind: "expanded", queueMaxShare: 0.4, queueMinPx: 360 };
}

/** The queue's CSS max-height while the pane is expanded; the pane flexes into the rest. */
export const squireExpandedQueueMaxHeight = (
  layout: Extract<SquireConversationLayout, { kind: "expanded" }>,
) => `max(${layout.queueMinPx}px, ${layout.queueMaxShare * 100}%)`;

/**
 * The expanded pane's height in a view `viewPx` tall whose queue content is `queuePx`, as the
 * page's flex rules resolve it.
 */
export function squireExpandedConversationPx(
  layout: Extract<SquireConversationLayout, { kind: "expanded" }>,
  viewPx: number,
  queuePx: number,
): number {
  const queueCap = Math.max(layout.queueMinPx, viewPx * layout.queueMaxShare);
  return Math.max(0, viewPx - Math.min(queuePx, queueCap));
}

/** The collapsed pane's one-line hint. */
export function squireConversationHint(
  homeShell: { readonly visibleItemCount: number } | null,
  working: boolean,
): string {
  if (working) return "Working…";
  const count = homeShell?.visibleItemCount ?? 0;
  if (count === 0) return "No messages yet";
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

/** Collapsed until the user opens it, so a new view leads with the queue. */
export const SQUIRE_CONVERSATION_COLLAPSED_DEFAULT = true;

export const squireConversationCollapsedKey = (environmentId: EnvironmentId, squireId: SquireId) =>
  `lecturn:squire-conversation-collapsed:${environmentId}:${squireId}`;

/**
 * Where a mini composer message goes when its send fails: the home thread's draft, since the
 * real composer is unmounted while collapsed. Blank text hands nothing over; an existing draft
 * is kept, with the new text after it, so nothing typed is dropped.
 */
export function squireMiniComposerDraft(text: string, draft: string | null): string | null {
  const next = text.trim();
  if (next.length === 0) return null;
  const kept = draft?.trimEnd() ?? "";
  return kept.length === 0 ? next : `${kept}\n\n${next}`;
}
