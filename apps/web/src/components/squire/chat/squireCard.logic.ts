import type { SquireKnownPayload } from "@lecturn/client-runtime/state/squire";
import type {
  AssistantCitation,
  EnvironmentId,
  SquireCard,
  SquireSteerKind,
  UserInputQuestion,
} from "@lecturn/contracts";
import { UnknownUnionMember } from "@lecturn/contracts";

import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "@lecturn/client-runtime/state/pending-user-input";

export function squireSteerKindLabel(kind: SquireSteerKind | null): string | null {
  if (kind === null || kind === "other") return null;
  const words = kind.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The recommendation as text: a steer or first prompt, or an inactivity check's note. Overlaps,
 * Squire proposals, and control proposals render their own blocks.
 */
export function squireCardRecommendation(payload: SquireKnownPayload): string | null {
  switch (payload.type) {
    case "steer":
      return payload.steer;
    case "thread-proposal":
      return payload.firstPrompt;
    case "fyi":
      return payload.text;
    default:
      return null;
  }
}

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
