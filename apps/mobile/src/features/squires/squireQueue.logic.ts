import { seedUserInputDraftAnswers } from "@lecturn/client-runtime/state/thread-requests";
import type { ThreadUserInputQuestion } from "@lecturn/client-runtime/state/thread-requests";
import {
  holdRemaining,
  squireQueue,
  squireQuestionPanelQuestions,
  squireSettledLabel,
  squireUndoOffer,
  type SquireEnvironmentState,
  type SquireKnownPayload,
  type SquireQueueChip,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import { UnknownUnionMember, type SquireItemsActInput } from "@lecturn/contracts";
import type {
  EnvironmentId,
  ProviderApprovalDecision,
  SquireCardId,
  SquireCardKind,
  SquireCardResolution,
  SquireCardRow,
  SquireId,
  SquireItemAction,
  SquireQuestionRequest,
  SquireRuleOffer,
  ThreadId,
} from "@lecturn/contracts";

import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";

// Shared with web; re-exported so the queue's callers keep one import.
export {
  SQUIRE_KIND_LABEL,
  SQUIRE_QUEUE_PAGE_SIZE,
  squireAcceptOffer,
  squireActedLabel,
  squireApprovalAnswer,
  squireAskCopy,
  squireCardActionable,
  squireCardOrigins,
  squireCardPrimaryLabel,
  squireEditedText,
  squireFollowUpDraft,
  squireOfferRuleInput,
  squireQuestionRepeatsTitle,
  squireRowAction,
  squireSettledLabel,
  squireUndoOffer,
  type SquireKnownPayload,
  type SquireRowAction,
  type SquireRuleNames,
} from "@lecturn/client-runtime/state/squire";

// Mirrors apps/web/src/components/squire/queue/squireQueue.logic.ts where the wording must
// match across clients but the shape differs; the web module is not importable from the app.

type QuestionPayload = Extract<SquireKnownPayload, { readonly type: "question" }>;

// ── Screen ────────────────────────────────────────────────────

export type SquireScreenState =
  | { readonly status: "unsupported" }
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | {
      readonly status: "ready";
      readonly entry: SquireSnapshotEntry;
      readonly isLead: boolean;
      /** The Lead's team strip; empty for any other Squire. */
      readonly team: ReadonlyArray<SquireSnapshotEntry>;
    };

/** `supported` is false for old servers too, which strip the capability key. */
export function squireScreenState(
  supported: boolean,
  state: SquireEnvironmentState | null,
  squireId: SquireId,
): SquireScreenState {
  if (!supported) return { status: "unsupported" };
  if (state === null) return { status: "loading" };
  const entry = state.squires.find((candidate) => candidate.squire.id === squireId);
  if (entry === undefined) return { status: "missing" };
  const isLead = entry.squire.role === "lead";
  return {
    status: "ready",
    entry,
    isLead,
    team: isLead ? state.squires.filter((candidate) => candidate.squire.role !== "lead") : [],
  };
}

/** D7: a Lead waiting on a provider has no home thread, so it offers setup instead of Chat. */
export function squireHeaderActions(
  squire: Pick<SquireSnapshotEntry["squire"], "status" | "lifecycle" | "homeThreadId">,
) {
  const needsProvider = squire.lifecycle === "needs_provider";
  return {
    chatThreadId: needsProvider ? null : squire.homeThreadId,
    setupPrompt: needsProvider ? "Choose a provider on desktop or the web." : null,
    pause:
      squire.status === "paused"
        ? { label: "Resume", next: "active" as const }
        : { label: "Pause", next: "paused" as const },
  };
}

/** Tapping the filtered portrait again clears the filter. */
export function squireTeamFilterToggle(
  current: SquireId | null,
  tapped: SquireId,
): SquireId | null {
  return current === tapped ? null : tapped;
}

// ── Holds (P10.1) ─────────────────────────────────────────────

export interface SquireHeldRow {
  readonly cardId: SquireCardId;
  readonly kind: SquireCardKind;
  readonly targetThreadId: ThreadId | null;
  readonly squireId: SquireId;
  readonly receivedAt: number;
  readonly executesInMs: number;
  /** The open card of the same raiser, thread, and kind this hold sits beside (P7.6). */
  readonly heldOverCardId?: SquireCardId;
}

/** The Lead's view holds its team's actions too, under the same team filter as its queue. */
export function squireHeldRows(
  viewed: SquireSnapshotEntry,
  team: ReadonlyArray<SquireSnapshotEntry>,
  teamFilter: SquireId | null,
): ReadonlyArray<SquireHeldRow> {
  const entries = [viewed, ...team].filter(
    (entry) => teamFilter === null || entry.squire.id === teamFilter,
  );
  return entries.flatMap((entry) =>
    entry.held.map((hold) => ({
      ...hold,
      squireId: entry.squire.id,
      receivedAt: entry.receivedAt,
    })),
  );
}

export function squireHoldSeconds(receivedAt: number, executesInMs: number, now: number): number {
  return Math.ceil(holdRemaining(receivedAt, executesInMs, now) / 1000);
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
 * P7.6: a hold is not an item, so it sits beside the open card of the same raiser, thread, and
 * kind (`heldOverCardId`). When that card is listed, the hold shows under it as one block, and
 * the held card's own row and banner are left out; any other hold keeps its banner.
 */
export function squireHoldPairing<Row extends Pick<SquireCardRow, "id" | "status">>(
  listed: ReadonlyArray<Row>,
  holds: ReadonlyArray<SquireHeldRow>,
): {
  /** The hold shown under each open card, by that card. */
  readonly byOpen: ReadonlyMap<SquireCardId, SquireHeldRow>;
  /** Holds shown on their own, as banners. */
  readonly lone: ReadonlyArray<SquireHeldRow>;
  /** The listed rows, without the held cards shown under their open card. */
  readonly rows: ReadonlyArray<Row>;
} {
  const open = new Set(listed.filter((row) => row.status === "open").map((row) => row.id));
  const byOpen = new Map<SquireCardId, SquireHeldRow>();
  const lone: SquireHeldRow[] = [];
  for (const hold of holds) {
    const over = hold.heldOverCardId;
    if (over !== undefined && open.has(over) && !byOpen.has(over)) byOpen.set(over, hold);
    else lone.push(hold);
  }
  const paired = new Set([...byOpen.values()].map((hold) => hold.cardId));
  return { byOpen, lone, rows: listed.filter((row) => !paired.has(row.id)) };
}

// ── Queue ─────────────────────────────────────────────────────

const QUEUED_STATUSES: ReadonlySet<string> = new Set(["held", "open", "accepting", "executing"]);

/**
 * The open queue: chips, "Needs a decision", and "FYI" from one list, so counts and groups never
 * disagree. A row the user just acted on leaves at once and shows as a one-line confirmation
 * until a refetch drops it; a pre-expanded card that is not on a loaded page is kept in place.
 * Rows keep server order: newest first.
 */
export function squireQueueView<Row extends SquireCardRow>(
  rows: ReadonlyArray<Row>,
  options: {
    readonly chip: SquireQueueChip;
    readonly teamFilter: SquireId | null;
    readonly selected: (Row & { readonly resolution?: SquireCardResolution | null }) | null;
    readonly hasMore: boolean;
    readonly acted?: ReadonlyMap<SquireCardId, string>;
  },
) {
  const acted = options.acted ?? new Map<SquireCardId, string>();
  const { selected } = options;
  // Only a row the server still shows as open is the user's act in flight; any other state
  // is the server's newer word.
  const actedOn = (row: Row) => row.status === "open" && acted.has(row.id);
  const confirmations: Array<{ readonly row: Row; readonly label: string }> = [];
  for (const row of rows) {
    const label = acted.get(row.id);
    if (label !== undefined && actedOn(row)) confirmations.push({ row, label });
  }
  const selectedLoaded =
    selected === null ? null : (rows.find((row) => row.id === selected.id) ?? null);
  if (selected !== null && selectedLoaded === null) {
    const label = acted.get(selected.id);
    if (!QUEUED_STATUSES.has(selected.status)) {
      confirmations.push({ row: selected, label: label ?? squireSettledLabel(selected) });
    } else if (label !== undefined && actedOn(selected)) {
      confirmations.push({ row: selected, label });
    }
  }
  const confirmed = new Set(confirmations.map((entry) => entry.row.id));
  const open = rows.filter((row) => !confirmed.has(row.id));
  const pinned =
    selected !== null && selectedLoaded === null && !confirmed.has(selected.id)
      ? [selected, ...open]
      : open;
  const queue = squireQueue(pinned, { chip: options.chip, squireId: options.teamFilter });
  return {
    chips: queue.chips.map((chip) => ({
      ...chip,
      // An unloaded page can only hold FYI rows' older neighbours, so the count is a floor.
      countLabel:
        options.hasMore && (chip.chip === "all" || chip.chip === "fyi")
          ? `${chip.count}+`
          : String(chip.count),
    })),
    decision: queue.groups.find((group) => group.key === "decision") ?? null,
    fyi: queue.groups.find((group) => group.key === "fyi") ?? null,
    confirmations,
  };
}

export function squireCardRecommendation(
  payload: SquireKnownPayload,
): { readonly text: string; readonly editable: boolean } | null {
  switch (payload.type) {
    case "steer":
      return { text: payload.steer, editable: true };
    case "thread-proposal":
      return { text: payload.firstPrompt, editable: true };
    case "squire-proposal":
      return { text: payload.brief, editable: false };
    case "fyi":
      return { text: payload.text, editable: false };
    default:
      return null;
  }
}

// ── Rules (P8.1) ──────────────────────────────────────────────

export type SquireRuleOfferPromptView = NonNullable<ReturnType<typeof squireUndoOffer>>;

// ── Acting ────────────────────────────────────────────────────

export type SquireAnswer =
  | { readonly decision: ProviderApprovalDecision }
  | { readonly answers: Record<string, string | ReadonlyArray<string>> };

/**
 * `squire.items.act` input. A question's answer goes to the card, which the server routes to
 * the target thread's pending request, so the thread need not be the one selected on the phone.
 */
export function squireItemsActInput(
  requestId: string,
  cardIds: ReadonlyArray<SquireCardId>,
  action: SquireItemAction,
  extra: { readonly text?: string | undefined; readonly answer?: SquireAnswer | undefined } = {},
): typeof SquireItemsActInput.Type {
  return {
    requestId,
    cardIds: [...cardIds],
    action,
    ...(extra.text === undefined ? {} : { text: extra.text }),
    ...(extra.answer === undefined ? {} : { answer: extra.answer }),
  };
}

export type SquireActOutcome =
  | { readonly ok: true; readonly ruleOffer: SquireRuleOffer | undefined }
  | { readonly ok: false; readonly error: string };

/** A transport failure and a per-card refusal both stay on the card, never as a toast. */
export function squireActOutcome(
  result:
    | { readonly _tag: "Success"; readonly value: SquireActResultValue }
    | { readonly _tag: "Failure" },
  cardId: SquireCardId,
  failureMessage: string | null,
): SquireActOutcome {
  if (result._tag === "Failure") {
    return { ok: false, error: failureMessage ?? "The item could not be updated. Try again." };
  }
  const outcome = result.value.results.find((entry) => entry.cardId === cardId);
  if (outcome?.error) return { ok: false, error: outcome.error.message };
  return { ok: true, ruleOffer: outcome?.ruleOffer };
}

interface SquireActResultValue {
  readonly results: ReadonlyArray<{
    readonly cardId: SquireCardId;
    readonly error: { readonly message: string } | null;
    readonly ruleOffer?: SquireRuleOffer;
  }>;
}

// ── Question answers (P7.4) ───────────────────────────────────

export type SquireQuestionMode =
  | { readonly type: "approval" }
  | { readonly type: "user-input" }
  | { readonly type: "secret" }
  | { readonly type: "in-thread"; readonly reason: string };

/**
 * How a question card answers: in place with the thread's own options, read from the card's
 * live copy of the request (D66), or in the thread. A request whose provider is gone cannot be
 * answered from here, so it sends the user to the thread instead of offering dead buttons.
 */
export function squireQuestionMode(payload: SquireKnownPayload): SquireQuestionMode | null {
  if (payload.type !== "question") return null;
  // Secret cards carry no request copy; the form needs the thread's secret item.
  if (payload.requestKind === "secret") return { type: "secret" };
  const request = payload.request;
  if (request === undefined) {
    return { type: "in-thread", reason: "This question is no longer waiting here." };
  }
  if (request instanceof UnknownUnionMember) {
    return { type: "in-thread", reason: "Answer this question in the thread." };
  }
  if (!request.canRespond) {
    return {
      type: "in-thread",
      reason: "The provider for this request is no longer running. Open the thread to continue.",
    };
  }
  if (request.type === "approval") return { type: "approval" };
  // A free-text-only question needs the thread's composer.
  return request.questions.every((question) => question.options.length > 0)
    ? { type: "user-input" }
    : { type: "in-thread", reason: "This question needs a written answer." };
}

export type SquireUserInputRequest = Extract<
  Exclude<SquireQuestionRequest, UnknownUnionMember>,
  { readonly type: "user-input" }
>;

/**
 * The thread's question shape, with a lone question that only repeats the card title left
 * blank. Answers key by question id, so blanking the text changes nothing sent.
 */
export function squireUserInputQuestions(
  request: SquireUserInputRequest,
  title: string,
): ReadonlyArray<ThreadUserInputQuestion> {
  return squireQuestionPanelQuestions(
    request.questions.map((question) => ({
      ...question,
      multiSelect: question.multiSelect ?? false,
    })),
    title,
  );
}

/** Drafts with each question's initial answer filled in, as the thread seeds them. */
export function squireSeededDrafts(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  drafts: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputDraftAnswer> {
  return seedUserInputDraftAnswers(questions, drafts);
}

/** The thread's own answer shape, keyed by question id; null until every question has one. */
export function squireUserInputAnswer(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  drafts: Record<string, PendingUserInputDraftAnswer>,
): SquireAnswer | null {
  const answers = buildPendingUserInputAnswers(questions, squireSeededDrafts(questions, drafts));
  return answers === null ? null : { answers };
}

export type { QuestionPayload as SquireQuestionPayload };

// ── Opened (D52) ──────────────────────────────────────────────

/**
 * One `squire.items.markOpened` per card per app session: the first open cancels the card's
 * phone escalation, and a card some surface already opened needs none. A failed send releases
 * the card so the next open retries.
 */
export function createSquireOpenedTracker() {
  const sent = new Set<string>();
  const key = (environmentId: EnvironmentId, cardId: SquireCardId) =>
    JSON.stringify([environmentId, cardId]);
  return {
    take(
      environmentId: EnvironmentId,
      cardId: SquireCardId,
      openedAt: string | null | undefined,
    ): boolean {
      const id = key(environmentId, cardId);
      if (sent.has(id)) return false;
      sent.add(id);
      return openedAt == null;
    },
    release(environmentId: EnvironmentId, cardId: SquireCardId): void {
      sent.delete(key(environmentId, cardId));
    },
  };
}

export const squireOpenedThisSession = createSquireOpenedTracker();

/** A turn summary FYI names its thread; the read model's `outcome` says what happened there. */
export function squireRowTitle(row: Pick<SquireCardRow, "title" | "kind" | "outcome">): string {
  const outcome = row.kind === "fyi" ? (row.outcome?.trim() ?? "") : "";
  return outcome === "" ? row.title : `${row.title} · ${outcome}`;
}
