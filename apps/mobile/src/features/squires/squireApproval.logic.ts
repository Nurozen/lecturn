import { seedUserInputDraftAnswers } from "@lecturn/client-runtime/state/thread-requests";
import type { ThreadUserInputQuestion } from "@lecturn/client-runtime/state/thread-requests";
import {
  squireApprovalControls,
  squireLeadShowsIntro,
  squireQuestionPanelQuestions,
  squireUndoOffer,
  type SquireApprovalEntry,
  type SquireEnvironmentState,
  type SquireKnownPayload,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import { UnknownUnionMember, type SquireItemsActInput } from "@lecturn/contracts";
import type {
  ProviderApprovalDecision,
  SquireCardId,
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

// Shared with web; re-exported so the chat's callers keep one import.
export {
  SQUIRE_KIND_LABEL,
  squireApprovalAnswer,
  squireFollowUpDraft,
  squireOffersFollowUp,
  squireOfferRuleInput,
  squireQuestionRepeatsTitle,
  squireUndoOffer,
  type SquireKnownPayload,
} from "@lecturn/client-runtime/state/squire";

// Mirrors the web client where the wording must
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

/** A Lead waiting on a provider has no home thread, so it offers setup instead of Chat. */
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

export type SquireRouteDestination =
  | { readonly kind: "details" }
  | { readonly kind: "chat"; readonly threadId: ThreadId };

/**
 * A Squire's route is its chat. The details page stays for what only it can show: a Squire with
 * no chat yet (no provider, or no home thread), and the Lead's first-run introduction.
 */
export function squireRouteDestination(input: {
  readonly squire: Pick<
    SquireSnapshotEntry["squire"],
    "role" | "status" | "lifecycle" | "homeThreadId" | "onboardedAt"
  >;
  readonly detailsRequested: boolean;
  /** The home thread's visible items; null until its shell has loaded. */
  readonly homeVisibleItemCount: number | null;
}): SquireRouteDestination {
  const { squire } = input;
  if (input.detailsRequested || squire.homeThreadId === null) return { kind: "details" };
  if (squire.lifecycle === "needs_provider") return { kind: "details" };
  if (squire.role === "lead") {
    // A Lead yet to onboard waits for its shell, so the intro never loses to a redirect.
    const introPending = squire.onboardedAt === null && input.homeVisibleItemCount === null;
    if (
      introPending ||
      squireLeadShowsIntro({ lead: squire, homeVisibleItemCount: input.homeVisibleItemCount })
    ) {
      return { kind: "details" };
    }
  }
  return { kind: "chat", threadId: squire.homeThreadId };
}

// ── Approvals ─────────────────────────────────────────────────

export function squireCardRecommendation(
  payload: SquireKnownPayload,
): { readonly text: string } | null {
  switch (payload.type) {
    case "steer":
      return { text: payload.steer };
    case "thread-proposal":
      return { text: payload.firstPrompt };
    case "squire-proposal":
      return { text: payload.brief };
    case "fyi":
      return { text: payload.text };
    default:
      return null;
  }
}

export type SquireChatControls =
  | { readonly kind: "approve"; readonly allowLabel: string; readonly alwaysAllow: boolean }
  | { readonly kind: "answer" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "inactivity" }
  | { readonly kind: "expired"; readonly allowNextTime: boolean }
  | { readonly kind: "none" };

/**
 * What a chat row offers this viewer: the shared controls, narrowed by what this session may do.
 * A question keeps its answer controls, and an overlap or an older server's FYI its Dismiss; an
 * expired approval offers the rule alone. Everything closed offers nothing, since its outcome stays as its line.
 */
export function squireChatControls(input: {
  readonly entry: SquireApprovalEntry<SquireCardRow>;
  /** Null while the card loads; labels fall back. */
  readonly payload: SquireKnownPayload | null;
  readonly canAct: boolean;
  readonly canSaveRule: boolean;
  /** "Saved to rules" already applies to this card this session. */
  readonly ruleSaved: boolean;
}): SquireChatControls {
  const { entry } = input;
  const shared = squireApprovalControls(entry, input.payload);
  const canSave = input.canSaveRule && !input.ruleSaved;
  if (entry.phase !== "open") {
    return entry.expired
      ? { kind: "expired", allowNextTime: canSave && shared.allowNextTime }
      : { kind: "none" };
  }
  if (!input.canAct) return { kind: "none" };
  if (shared.inactivity) return { kind: "inactivity" };
  if (shared.allow !== null) {
    return {
      kind: "approve",
      allowLabel: shared.allow,
      alwaysAllow: canSave && shared.alwaysAllow,
    };
  }
  if (shared.deny === null) return { kind: "none" };
  return entry.row.kind === "question" ? { kind: "answer" } : { kind: "dismiss" };
}

// ── Rules ─────────────────────────────────────────────────────

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

// ── Question answers ──────────────────────────────────────────

export type SquireQuestionMode =
  | { readonly type: "approval" }
  | { readonly type: "user-input" }
  | { readonly type: "secret" }
  | { readonly type: "in-thread"; readonly reason: string };

/**
 * How a question card answers: in place with the thread's own options, read from the card's
 * live copy of the request, or in the thread. A request whose provider is gone cannot be
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
