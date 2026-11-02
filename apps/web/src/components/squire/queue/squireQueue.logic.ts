import {
  SQUIRE_KIND_LABEL,
  squireQueue,
  squireRaiserLabel,
  squireReceiptState,
  squireSameText,
  squireSettledLabel,
  type SquireKnownPayload,
  type SquireQueueChip,
} from "@lecturn/client-runtime/state/squire";
import type {
  AssistantCitation,
  EnvironmentId,
  Squire,
  SquireCard,
  SquireCardId,
  SquireCardKind,
  SquireCardResolution,
  SquireCardRow,
  SquireId,
  SquireRoutingReceipt,
  SquireSteerKind,
  UserInputQuestion,
} from "@lecturn/contracts";
import { UnknownUnionMember } from "@lecturn/contracts";

import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "../../../pendingUserInput";

// Shared with the mobile app; re-exported so the queue's callers keep one import.
export {
  SQUIRE_KIND_LABEL,
  SQUIRE_QUEUE_PAGE_SIZE,
  squireAcceptOffer,
  squireActedLabel,
  squireApprovalAnswer,
  squireAskCopy,
  squireCardActionable,
  squireCardCaption,
  squireCardOrigins,
  squireCardPrimaryLabel,
  squireCardTimeline,
  squireControlText,
  squireDiffStatsLabel,
  squireEditedText,
  squireFollowUpDraft,
  squireOffersFollowUp,
  squireOfferRuleInput,
  squireOverlapProviderNames,
  squireProposalProviderName,
  squirePullRequestChips,
  squireQuestionPanelQuestions,
  squireQuestionRepeatsTitle,
  squireQuestionWhyFallback,
  squireRaiserLabel,
  squireRowAction,
  squireRowProviderName,
  squireRowTargetName,
  squireTimelineRows,
  squireUndoOffer,
  squireWaitingSince,
  squireWhyText,
  type SquireChipTone,
  type SquireKnownPayload,
  type SquireRowAction,
  type SquireRuleNames,
} from "@lecturn/client-runtime/state/squire";

// ── Queue ─────────────────────────────────────────────────────

const QUEUED_STATUSES: ReadonlySet<string> = new Set(["held", "open", "accepting", "executing"]);

/**
 * The open queue: chips, "Needs a decision", and "FYI" from one list, so counts and groups never
 * disagree. A card the user just acted on leaves at once (`acted`, until a refetch drops it or
 * moves it on), and a selected card that is no longer open becomes a one-line confirmation
 * outside the groups instead of staying among open items. A selected card that is still open
 * but not on a loaded page (a deep link) is kept in place. Rows keep server order: newest first.
 */
export function squireQueueView<Row extends SquireCardRow>(
  rows: ReadonlyArray<Row>,
  options: {
    readonly chip: SquireQueueChip;
    readonly teamFilter: SquireId | null;
    readonly selected: (Row & { readonly resolution?: SquireCardResolution | null }) | null;
    /** Older FYI pages remain on the server. */
    readonly hasMore: boolean;
    /** The user's own successful acts by card, with what they did. */
    readonly acted?: ReadonlyMap<SquireCardId, string>;
    /**
     * Rows another panel above the queue already shows (the Lead's onboarding proposals): still
     * counted by the chips, so the counts agree with the header, but left out of the groups.
     */
    readonly shownAbove?: ReadonlySet<string>;
  },
) {
  const acted = options.acted ?? new Map<SquireCardId, string>();
  const { selected } = options;
  // Only a row the server still shows as open is the user's act in flight; any other state
  // is the server's newer word.
  const actedOn = (row: Row) => row.status === "open" && acted.has(row.id);
  const selectedOpen =
    selected === null ? null : (rows.find((row) => row.id === selected.id) ?? null);
  const confirmation =
    selected === null
      ? null
      : !QUEUED_STATUSES.has(selected.status)
        ? { row: selected, label: squireSettledLabel(selected) }
        : actedOn(selectedOpen ?? selected)
          ? { row: selected, label: acted.get(selected.id)! }
          : null;
  const open = rows.filter(
    (row) => !actedOn(row) && (confirmation === null || row.id !== confirmation.row.id),
  );
  const pinned =
    selected !== null && confirmation === null && selectedOpen === null
      ? [selected, ...open]
      : open;
  const filter = { chip: options.chip, squireId: options.teamFilter };
  const queue = squireQueue(pinned, filter);
  const above = options.shownAbove ?? new Set<string>();
  const listed =
    above.size === 0
      ? queue
      : squireQueue(
          pinned.filter((row) => !above.has(row.id)),
          filter,
        );
  const shownCount = (groups: typeof queue.groups) =>
    groups.reduce((sum, group) => sum + group.items.length, 0);
  const decisions = listed.groups.find((group) => group.key === "decision")?.items ?? [];
  // Holds wait on nobody, so they get their own group with their countdown and Undo.
  const held = decisions.filter((row) => row.status === "held");
  const deciding = decisions.filter((row) => row.status !== "held");
  return {
    chips: queue.chips.map((chip) => ({
      ...chip,
      // An unloaded page can only hold FYI rows' older neighbours, so the count is a floor.
      countLabel:
        options.hasMore && (chip.chip === "all" || chip.chip === "fyi")
          ? `${chip.count}+`
          : String(chip.count),
    })),
    held: held.length === 0 ? null : { label: "Held", items: held },
    decision: deciding.length === 0 ? null : { label: "Needs a decision", items: deciding },
    fyi: listed.groups.find((group) => group.key === "fyi") ?? null,
    /** Rows under the current chip and filter that show above instead of in the groups. */
    aboveCount: shownCount(queue.groups) - shownCount(listed.groups),
    /**
     * Every open item is a proposal the panel above shows (onboarding with nothing else open),
     * so the chip row and the empty line would only repeat that panel.
     */
    onlyAbove: squireOnlyShownAbove(pinned, above, options),
    confirmation,
  };
}

function squireOnlyShownAbove(
  rows: ReadonlyArray<Pick<SquireCardRow, "id" | "kind" | "squireId" | "ownerSquireId">>,
  above: ReadonlySet<string>,
  options: { readonly teamFilter: SquireId | null; readonly hasMore: boolean },
): boolean {
  // An unloaded page may hold more, and a team filter hides rows the chips do not count.
  if (above.size === 0 || options.hasMore) return false;
  const all = (items: typeof rows) =>
    squireQueue(items, { squireId: options.teamFilter }).chips.find((chip) => chip.chip === "all")
      ?.count ?? 0;
  return all(rows) > 0 && all(rows.filter((row) => !above.has(row.id))) === 0;
}

/**
 * The header's counts, over the loaded open rows with no chip or team filter: `decisions` is
 * exactly the "Needs a decision" group and `held` the "Held" group, Lead-raised items included.
 * The sidebar badge counts only a Squire's own items, so it can be lower.
 */
export function squireHeaderCounts(rows: ReadonlyArray<Pick<SquireCardRow, "kind" | "status">>): {
  readonly decisions: number;
  readonly held: number;
} {
  let decisions = 0;
  let held = 0;
  for (const row of rows) {
    if (row.kind === "fyi" || !QUEUED_STATUSES.has(row.status)) continue;
    if (row.status === "held") held += 1;
    else decisions += 1;
  }
  return { decisions, held };
}

/**
 * A hold is not an item, so it sits beside the open card of the same raiser, thread, and
 * kind (`heldOverCardId`) rather than replacing it. Each such hold shows under that card as one
 * block instead of as a second row with the same title. A hold whose card is not listed here
 * (filtered, acted on, settled) keeps its own row. Rows keep their order.
 */
export function squireHoldPairing<Row extends Pick<SquireCardRow, "id">>(
  held: ReadonlyArray<Row>,
  open: ReadonlyArray<Pick<SquireCardRow, "id">>,
  heldOverOf: (heldCardId: SquireCardId) => SquireCardId | undefined,
): {
  /** Holds that keep their own row. */
  readonly lone: ReadonlyArray<Row>;
  /** The hold shown under each open card, by that card. */
  readonly byOpen: ReadonlyMap<SquireCardId, Row>;
} {
  const listed = new Set(open.map((row) => row.id));
  const byOpen = new Map<SquireCardId, Row>();
  const lone: Row[] = [];
  for (const row of held) {
    const over = heldOverOf(row.id);
    if (over !== undefined && listed.has(over) && !byOpen.has(over)) byOpen.set(over, row);
    else lone.push(row);
  }
  return { lone, byOpen };
}

/**
 * The empty queue's line. Rows shown above (onboarding proposals) still count, so the queue
 * points up at them instead of saying nothing waits.
 */
export function squireQueueEmptyText(chip: SquireQueueChip, aboveCount: number): string {
  if (aboveCount > 0) {
    return `${aboveCount} ${aboveCount === 1 ? "proposal" : "proposals"} above`;
  }
  return chip === "all"
    ? "Nothing is waiting on you."
    : `No open ${SQUIRE_KIND_LABEL[chip].toLowerCase()} items.`;
}

/**
 * A row's secondary line, in both layouts. In the Lead view: the raising Squire, then the
 * thread or project, never the provider, so every row reads alike. The target is left out when
 * it only repeats the title. The raiser and target stay apart so the raiser never truncates.
 */
export function squireRowMeta(input: {
  readonly title: string;
  readonly raiser: Pick<Squire, "name" | "role"> | null;
  readonly targetName: string | null;
}): { readonly raiser: string | null; readonly target: string | null } | null {
  const target =
    input.targetName === null || squireSameText(input.targetName, input.title)
      ? null
      : input.targetName;
  const raiser = input.raiser === null ? null : squireRaiserLabel(input.raiser);
  return raiser === null && target === null ? null : { raiser, target };
}

/**
 * Only a turn summary FYI is titled by its thread alone, with what happened in its text; a
 * notify FYI's title is already its message. So only these rows read the card for their text.
 */
export function squireFyiNeedsText(row: Pick<SquireCardRow, "kind" | "fyiSource">): boolean {
  return row.kind === "fyi" && row.fyiSource === "summary";
}

/**
 * An FYI row's one line: "<thread> · <what happened>". The summary's text repeats the title as
 * "<title>: <outcome>", so the prefix is dropped; a text that only repeats the title adds nothing.
 */
export function squireFyiRowText(title: string, text: string | null): string {
  const body = text?.trim().split("\n")[0]?.trim() ?? "";
  const prefix = `${title.trim()}:`;
  const what = body.toLowerCase().startsWith(prefix.toLowerCase())
    ? body.slice(prefix.length).trim()
    : body;
  return what === "" || squireSameText(what, title) ? title : `${title} · ${what}`;
}

/**
 * A title shown beside its kind label, without a leading "<kind>:" that would say it twice
 * ("Overlap  Overlap: Fix invoice rounding…"). A title that is only the prefix stays whole.
 */
export function squireTitleBesideKind(title: string, kind: SquireCardKind): string {
  const prefix = `${SQUIRE_KIND_LABEL[kind]}:`;
  if (!title.toLowerCase().startsWith(prefix.toLowerCase())) return title;
  const rest = title.slice(prefix.length).trim();
  return rest === "" ? title : rest;
}

export function squireSteerKindLabel(kind: SquireSteerKind | null): string | null {
  if (kind === null || kind === "other") return null;
  const words = kind.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The row's status markers, in the order the row shows them. */
export function squireCardMarkers(
  row: Pick<SquireCardRow, "status" | "replacedCount">,
): ReadonlyArray<"held" | "sending" | "outdated" | "resolved" | "updated"> {
  const markers: Array<"held" | "sending" | "outdated" | "resolved" | "updated"> = [];
  switch (row.status) {
    case "held":
      markers.push("held");
      break;
    case "accepting":
    case "executing":
      markers.push("sending");
      break;
    case "outdated":
      markers.push("outdated");
      break;
    case "resolved":
    case "executed":
    case "dismissed":
      markers.push("resolved");
      break;
    default:
      break;
  }
  if (row.replacedCount > 0 && row.status !== "outdated") markers.push("updated");
  return markers;
}

export const SQUIRE_MARKER_LABEL = {
  held: "Held",
  sending: "Sending…",
  outdated: "Outdated",
  resolved: "Done",
  updated: "Updated",
} as const;

/**
 * The recommendation as text: a steer or first prompt (editable), or an FYI's note. Overlaps,
 * Squire proposals, and control proposals render their own blocks.
 */
export function squireCardRecommendation(
  payload: SquireKnownPayload,
): { readonly text: string; readonly editable: boolean } | null {
  switch (payload.type) {
    case "steer":
      return { text: payload.steer, editable: true };
    case "thread-proposal":
      return { text: payload.firstPrompt, editable: true };
    case "fyi":
      return { text: payload.text, editable: false };
    default:
      return null;
  }
}

// ── Captions and labels ───────────────────────────────────────

export function squireReceiptRows(
  receipts: ReadonlyArray<SquireRoutingReceipt>,
  nameOf: (squireId: SquireId) => string,
) {
  return receipts.map((receipt) => ({
    taskId: receipt.taskId,
    createdAt: receipt.createdAt,
    ...squireReceiptState(receipt, nameOf),
  }));
}

// ── Evidence ──────────────────────────────────────────────────

/**
 * "Open in thread" lands on the triggering message, highlighting its quote, when the
 * card has both; a PR-only trigger opens the thread.
 */
export function squireOpenInThreadTarget(
  environmentId: EnvironmentId,
  card: Pick<SquireCard, "targetThreadId" | "trigger">,
):
  | { readonly type: "citation"; readonly citation: AssistantCitation }
  | { readonly type: "thread"; readonly threadId: NonNullable<SquireCard["targetThreadId"]> }
  | null {
  const threadId = card.targetThreadId;
  if (threadId === null) return null;
  const messageId = card.trigger.triggerMessageId;
  const quote = card.trigger.quote?.trim() ?? "";
  if (messageId === undefined || quote === "") return { type: "thread", threadId };
  return {
    type: "citation",
    citation: {
      version: 1,
      environmentId,
      threadId,
      messageId,
      text: quote,
      // The quote's offsets are unknown; the source view finds it by text.
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    },
  };
}

// ── Question answers ──────────────────────────────────────────

/** The thread's own answer shape, keyed by question id; null until every question has one. */
export function squireUserInputAnswer(
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: Record<string, PendingUserInputDraftAnswer>,
) {
  const answers = buildPendingUserInputAnswers(questions, drafts);
  return answers === null ? null : { answers };
}

export type SquireQuestionMode =
  | { readonly type: "approval" }
  | { readonly type: "user-input" }
  | { readonly type: "secret" }
  | { readonly type: "in-thread"; readonly reason: string };

/** How a question card answers: in place with the thread's own options, or in the thread. */
export function squireQuestionMode(payload: SquireKnownPayload): SquireQuestionMode | null {
  if (payload.type !== "question") return null;
  if (payload.requestKind === "secret") return { type: "secret" };
  const request = payload.request;
  if (request === undefined) {
    return { type: "in-thread", reason: "This question is no longer waiting here." };
  }
  if (request instanceof UnknownUnionMember) {
    return { type: "in-thread", reason: "Answer this question in the thread." };
  }
  if (request.type === "approval") return { type: "approval" };
  // A free-text-only question needs the thread's composer.
  return request.questions.every((question) => question.options.length > 0)
    ? { type: "user-input" }
    : { type: "in-thread", reason: "This question needs a written answer." };
}

// ── Inbox detail ──────────────────────────────────────────────

/**
 * An overlap's repository is the server's identity for it: a project id when the threads share
 * a project, else a remote key or path. The project's own name reads best; otherwise the last
 * path segment, which is the folder or repo name.
 */
export function squireRepositoryLabel(repository: string, projectTitle: string | null): string {
  const title = projectTitle?.trim() ?? "";
  if (title !== "") return title;
  const segment =
    repository
      .replace(/[\\/]+$/, "")
      .split(/[\\/:]/)
      .at(-1) ?? repository;
  return segment.replace(/\.git$/, "") || repository;
}

/**
 * The inbox detail's subtitle, by what the card is about: an overlap names its repository and
 * how many threads collide, a proposal what it would create and where, a control proposal the
 * Squire it acts on, and anything on a thread that thread and its provider.
 */
export function squireCardSubtitle(
  card: Pick<SquireCard, "targetThreadId">,
  payload: SquireKnownPayload | null,
  names: {
    readonly threadTitle: string | null;
    readonly provider: string | null;
    readonly projectTitle: string | null;
    readonly proposalScope: string | null;
    readonly squireName: (squireId: SquireId) => string;
  },
): ReadonlyArray<string> {
  const parts = (...segments: ReadonlyArray<string | null>) =>
    segments.filter((segment) => segment !== null && segment.trim() !== "") as string[];
  switch (payload?.type) {
    case "overlap":
      return parts(
        squireRepositoryLabel(payload.repository, names.projectTitle),
        `${payload.threads.length} threads`,
      );
    case "thread-proposal":
      return parts("New thread", names.projectTitle);
    case "squire-proposal":
      return parts("New Squire", names.proposalScope);
    case "room-proposal":
      return ["New room"];
    case "control":
      return payload.squireId === null ? [] : [names.squireName(payload.squireId)];
    default:
      return card.targetThreadId === null
        ? parts(names.projectTitle)
        : parts(names.threadTitle ?? "Thread", names.provider);
  }
}
