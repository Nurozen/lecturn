/**
 * The read side of Squire items. A question card stores only the request id
 * and its title: its question text and options are read from the
 * target thread's request on every load, so the card never goes stale and
 * never holds a copy, and a secret request's card never holds the secret.
 */
import {
  CommandId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderUserInputAnswers,
  type RunId,
  RuntimeRequestId,
  SQUIRE_CARD_OUTCOME_MAX_CHARS,
  type SquireAnswerOption,
  SquireCard,
  type SquireCardId,
  SquireCardTrigger,
  type SquireQuestionRequest,
  SquireError,
  SquireItemsActResult,
  type ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import { makeSquireCardDetail } from "./SquireCardDetail.ts";
import * as SquireRepository from "./SquireRepository.ts";

export type SquireItemsError =
  | PersistenceSqlError
  | ProjectionStore.ProjectionStoreV2Error
  | Schema.SchemaError;

export interface SquireQuestion {
  readonly requestKind: "runtime" | "secret";
  readonly question: string;
  readonly options: ReadonlyArray<SquireAnswerOption>;
  readonly pending: boolean;
  /** The pending runtime request in the thread's own shape. */
  readonly request?: SquireQuestionRequest;
}

const TITLE_MAX_CHARS = 120;

/** The card title: the question's first line, bounded. */
export const squireQuestionTitle = (question: string) => {
  const line = question.trim().split("\n")[0]?.trim() ?? "";
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1)}…` : line;
};

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<SquireAnswerOption> = [
  { label: "Accept" },
  { label: "Decline" },
];

// One app approval lets one call through, so an option that widens it to the
// session or forever has nothing to honor it; mirrors the thread's own panel.
const CONNECTED_APP_TOOL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
  { decision: "cancel", label: "Cancel" },
];
const connectedAppToolOptions = (options: ReadonlyArray<ProviderApprovalOption> | undefined) => {
  const scoped = options?.filter(
    (option) => option.decision !== "acceptForSession" && option.decision !== "acceptAlways",
  );
  return scoped === undefined || scoped.length === 0 ? CONNECTED_APP_TOOL_OPTIONS : scoped;
};

/**
 * The thread's own question for a request id, or a secret request's label and
 * reason when `secretTurnItemId` is given. None once the thread or item is gone.
 */
export const readSquireQuestion = Effect.fn("SquireItems.readSquireQuestion")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
  ref: { readonly requestId: string; readonly secretTurnItemId?: TurnItemId | undefined },
): Effect.fn.Return<Option.Option<SquireQuestion>, ProjectionStore.ProjectionStoreV2Error> {
  if (ref.secretTurnItemId !== undefined) {
    const item = yield* projections.getTurnItem({ threadId, itemId: ref.secretTurnItemId });
    if (item?.type !== "secret_request") return Option.none();
    const reason = item.reason.trim();
    return Option.some({
      requestKind: "secret",
      question: reason ? `${item.label}: ${reason}` : item.label,
      // Answered through the secret store, never through the card.
      options: [],
      pending: item.secretStatus === "pending",
    });
  }
  if ((yield* projections.getThreadShell(threadId)) === null) return Option.none();
  const { request, item } = yield* projections.getRuntimeResponseContext(
    threadId,
    RuntimeRequestId.make(ref.requestId),
  );
  if (request === undefined) return Option.none();
  const pending = request.status === "pending";
  const capability = request.responseCapability.type;
  if (item?.type === "user_input_request") {
    return Option.some({
      requestKind: "runtime",
      question: item.questions.map((question) => question.question).join("\n"),
      options: (item.questions[0]?.options ?? []).map((option) => ({
        label: option.label,
        description: option.description,
      })),
      pending,
      ...(pending
        ? {
            request: {
              type: "user-input" as const,
              questions: item.questions,
              canRespond: capability !== "not_resumable",
            },
          }
        : {}),
    });
  }
  const prompt = item?.type === "approval_request" ? item.prompt?.trim() : undefined;
  const itemOptions = item?.type === "approval_request" ? item.options : undefined;
  const options =
    request.connectedAppTool === undefined ? itemOptions : connectedAppToolOptions(itemOptions);
  return Option.some({
    requestKind: "runtime",
    question: prompt || item?.title?.trim() || `Approve ${request.kind}`,
    options:
      options?.map((option) => ({
        label: option.label,
        ...(option.warning === undefined ? {} : { description: option.warning }),
      })) ?? DEFAULT_APPROVAL_OPTIONS,
    pending,
    ...(pending
      ? {
          request: {
            type: "approval" as const,
            ...(options === undefined ? {} : { options }),
            canRespond: capability === "live",
          },
        }
      : {}),
  });
});

const decodeFyiSource = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ source: Schema.String })),
);
export const fyiSourceOf = (payloadJson: string | null): string =>
  payloadJson === null
    ? "unknown"
    : Option.match(decodeFyiSource(payloadJson), {
        onNone: () => "unknown",
        onSome: (payload) => payload.source,
      });

const decodeFyiText = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ source: Schema.String, text: Schema.String })),
);
const squashSpace = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * A turn summary FYI's text is "<title>: <outcome>"; the row shows the outcome
 * beside the title, so it is cut to fit and dropped when it only repeats the title.
 */
export const squireFyiOutcome = (title: string, payloadJson: string | null): string | undefined => {
  const payload = payloadJson === null ? null : Option.getOrNull(decodeFyiText(payloadJson));
  if (payload === null || payload.source !== "summary") return undefined;
  const line = payload.text.trim().split("\n")[0]?.trim() ?? "";
  const prefix = `${title.trim()}:`;
  const what = (
    line.toLowerCase().startsWith(prefix.toLowerCase()) ? line.slice(prefix.length) : line
  ).trim();
  if (what === "" || squashSpace(what) === squashSpace(title)) return undefined;
  const chars = [...what];
  if (chars.length <= SQUIRE_CARD_OUTCOME_MAX_CHARS) return what;
  const cut = chars.slice(0, SQUIRE_CARD_OUTCOME_MAX_CHARS - 1).join("");
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord >= SQUIRE_CARD_OUTCOME_MAX_CHARS / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
};

const decodeProposalProvider = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("thread-proposal"),
      provider: Schema.String,
      providerInstanceId: Schema.NullOr(Schema.String),
    }),
  ),
);
const proposalProviderOf = (payloadJson: string | null) =>
  payloadJson === null
    ? {}
    : Option.match(decodeProposalProvider(payloadJson), {
        onNone: () => ({}),
        onSome: ({ provider, providerInstanceId }) => ({
          proposalProvider: { provider, providerInstanceId },
        }),
      });

const decodeOverlapSquires = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("overlap"),
      threads: Schema.Array(
        Schema.Struct({
          squireId: Schema.String,
          provider: Schema.String,
          providerInstanceId: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);
const overlapSquiresOf = (payloadJson: string | null) =>
  payloadJson === null
    ? {}
    : Option.match(decodeOverlapSquires(payloadJson), {
        onNone: () => ({}),
        onSome: ({ threads }) => ({
          relatedSquireIds: [...new Set(threads.map((thread) => thread.squireId))],
          overlapProviders: threads.map((thread) => thread.provider),
          ...(threads.some((thread) => thread.providerInstanceId !== undefined)
            ? {
                overlapProviderInstanceIds: threads.map(
                  (thread) => thread.providerInstanceId ?? null,
                ),
              }
            : {}),
        }),
      });

const decodeStoredRecommendation = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ recommendation: Schema.optionalKey(Schema.String) })),
);

const decodeStoredRequestedAt = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ requestedAt: Schema.String })),
);
/** A question's request time, stored on its payload since it was recorded; absent before. */
const questionFieldsOf = (payloadJson: string | null) =>
  payloadJson === null
    ? {}
    : Option.match(decodeStoredRequestedAt(payloadJson), {
        onNone: () => ({}),
        onSome: ({ requestedAt }) => ({ requestedAt }),
      });

const fyiFieldsOf = (row: SquireRepository.SquireCardRow) => {
  const outcome = squireFyiOutcome(row.title, row.payload_json);
  return {
    fyiSource: fyiSourceOf(row.payload_json),
    ...(outcome === undefined ? {} : { outcome }),
  };
};

const decodeTriggerOption = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardTrigger));

/** Set only on a card a voice-note turn raised or last updated. */
const speakerVerifiedOf = (row: SquireRepository.SquireCardRow) => {
  if (row.origin !== "voice") return {};
  const verified = Option.getOrUndefined(decodeTriggerOption(row.trigger_json))?.speakerVerified;
  return verified === undefined ? {} : { speakerVerified: verified };
};

/** The compact `SquireCardRow` fields of a stored card, before decoding. */
export const squireCardRowFields = (row: SquireRepository.SquireCardRow) => ({
  ...speakerVerifiedOf(row),
  ...(row.kind === "fyi" ? fyiFieldsOf(row) : {}),
  ...(row.kind === "proposal" ? proposalProviderOf(row.payload_json) : {}),
  ...(row.kind === "overlap" ? overlapSquiresOf(row.payload_json) : {}),
  ...(row.kind === "question" ? questionFieldsOf(row.payload_json) : {}),
  ...(row.resolution === null ? {} : { resolution: row.resolution }),
  id: row.id,
  squireId: row.squire_id,
  ownerSquireId: row.owner_squire_id,
  kind: row.kind,
  status: row.status,
  title: row.title,
  targetThreadId: row.target_thread_id,
  projectId: row.project_id,
  origin: row.origin,
  steerKind: row.steer_kind,
  ruleId: row.rule_id,
  routedTaskId: row.routed_task_id,
  caption: null,
  replacedCount: row.replaced_count,
  executesAt: row.executes_at,
  openedAt: row.opened_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const decodeCard = Schema.decodeUnknownEffect(SquireCard);
const decodeTrigger = Schema.decodeUnknownEffect(Schema.fromJsonString(SquireCardTrigger));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = (json: string | null): unknown => (json === null ? null : decodeJson(json));

/** The answer the target thread's own pending-request components produce. */
export interface SquireQuestionAnswer {
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: ProviderUserInputAnswers;
}

export interface SquireItemsAnswerInput {
  readonly cardId: SquireCardId;
  /** The client's request id; the respond command id derives from it. */
  readonly requestId: string;
  readonly answer: SquireQuestionAnswer;
}

export type SquireItemResult = (typeof SquireItemsActResult.Type)["results"][number];

const squireAnswerCommandId = (cardId: SquireCardId, requestId: string) =>
  CommandId.make(`server:squire:answer:${cardId}:${requestId}`);

export const SECRET_CARD_ANSWER_MESSAGE =
  "A secret is entered in the thread's secret prompt (secrets.answerRequest) or with Open in thread, never through a Squire card.";

export class SquireItems extends Context.Service<
  SquireItems,
  {
    /** The full card for `squire.item.get`; a question card's text and options are read live. */
    readonly get: (
      cardId: SquireCardId,
    ) => Effect.Effect<Option.Option<SquireCard>, SquireItemsError>;
    /**
     * Answers a runtime question card's request with `runtime-request.respond`.
     * The card stays open: the reactor resolves it when the request resolves,
     * however it was answered.
     */
    readonly answer: (
      input: SquireItemsAnswerInput,
    ) => Effect.Effect<SquireItemResult, SquireError>;
  }
>()("lecturn/squire/SquireItems") {}

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const cardDetail = makeSquireCardDetail({ repository, projections });

  const get: SquireItems["Service"]["get"] = Effect.fn("SquireItems.get")(function* (cardId) {
    const found = yield* repository.getCard(cardId);
    if (Option.isNone(found)) return Option.none();
    const row = found.value;
    const trigger = yield* decodeTrigger(row.trigger_json);
    let payload = parse(row.payload_json);
    if (row.kind === "question" && row.target_thread_id !== null && trigger.requestId) {
      const question = yield* readSquireQuestion(projections, row.target_thread_id, {
        requestId: trigger.requestId,
        secretTurnItemId: trigger.secretTurnItemId,
      });
      const stored = Option.getOrNull(decodeStoredRecommendation(row.payload_json ?? ""));
      payload = {
        ...(stored?.recommendation ? { recommendation: stored.recommendation } : {}),
        ...questionFieldsOf(row.payload_json),
        type: "question",
        threadId: row.target_thread_id,
        requestId: trigger.requestId,
        requestKind: trigger.secretTurnItemId === undefined ? "runtime" : "secret",
        // A request whose turn item is gone still names itself through its title.
        question: Option.match(question, { onNone: () => row.title, onSome: (q) => q.question }),
        options: Option.match(question, { onNone: () => [], onSome: (q) => q.options }),
        ...Option.match(question, {
          onNone: () => ({}),
          onSome: (q) => (q.request === undefined ? {} : { request: q.request }),
        }),
      };
    }
    const detail = yield* cardDetail.detail(row, trigger);
    return Option.some(
      yield* decodeCard({
        ...squireCardRowFields(row),
        why: row.why,
        payload,
        evidence: detail.evidence,
        trigger: detail.trigger,
        ask: parse(row.ask_json),
        timeline: detail.timeline,
        resolution: row.resolution,
      }),
    );
  });

  const refused = (
    card: SquireRepository.SquireCardRow,
    code: "outdated" | "invalid_request",
    message: string,
  ): SquireItemResult => ({ cardId: card.id, status: card.status, error: { code, message } });

  /** A request no longer pending was settled elsewhere; the reactor moves the card. */
  const settledElsewhere = (card: SquireRepository.SquireCardRow, status: string | undefined) =>
    refused(
      card,
      "outdated",
      status === "resolved"
        ? "This question was already answered in the thread."
        : "This question is no longer waiting for an answer.",
    );

  const answer: SquireItems["Service"]["answer"] = Effect.fn("SquireItems.answer")(
    function* (input) {
      const found = yield* repository.getCard(input.cardId).pipe(orSquireError("read the item"));
      if (Option.isNone(found) || found.value.kind !== "question") {
        return yield* new SquireError({
          code: "not_found",
          message: "This question no longer exists.",
        });
      }
      const card = found.value;
      if (card.status !== "open")
        return refused(card, "outdated", "This question is no longer open.");
      const trigger = yield* decodeTrigger(card.trigger_json).pipe(orSquireError("read the item"));
      if (trigger.secretTurnItemId !== undefined) {
        return refused(card, "invalid_request", SECRET_CARD_ANSWER_MESSAGE);
      }
      const threadId = card.target_thread_id;
      if (threadId === null || trigger.requestId === undefined) {
        return refused(card, "invalid_request", "This question has no request to answer.");
      }
      if (input.answer.decision === undefined && input.answer.answers === undefined) {
        return refused(card, "invalid_request", "Choose an answer first.");
      }
      const requestId = RuntimeRequestId.make(trigger.requestId);
      const readStatus = projections.getRuntimeRequest(threadId, requestId).pipe(
        Effect.map((request) => request?.status),
        orSquireError("read the thread's request"),
      );
      const status = yield* readStatus;
      if (status !== "pending") return settledElsewhere(card, status);
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(orSquireError("read the thread"));
      const dispatch = orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: squireAnswerCommandId(card.id, input.requestId),
        threadId,
        requestId,
        ...(input.answer.decision === undefined ? {} : { decision: input.answer.decision }),
        ...(input.answer.answers === undefined ? {} : { answers: input.answer.answers }),
      });
      // A Squire's own threads pass the marked-thread allowlist only with this origin.
      const outcome = yield* (
        shell?.squire === undefined ? dispatch : withSquireDispatchOrigin(dispatch)
      ).pipe(Effect.result);
      if (Result.isFailure(outcome)) {
        // Answered elsewhere between the read and the dispatch.
        const after = yield* readStatus;
        if (after !== "pending") return settledElsewhere(card, after);
        return yield* Effect.fail(outcome.failure).pipe(orSquireError("answer the question"));
      }
      return { cardId: card.id, status: card.status, error: null };
    },
  );

  return SquireItems.of({ get, answer });
});

export const layer = Layer.effect(SquireItems, make);

/** The question card's stored trigger: no question text, options, or secret. */
export const questionCardTrigger = (input: {
  readonly runId: RunId | null;
  readonly requestId: string;
  readonly secret: boolean;
}): SquireCardTrigger => ({
  ...(input.runId === null ? {} : { runId: input.runId }),
  requestId: input.requestId,
  ...(input.secret ? { secretTurnItemId: TurnItemId.make(input.requestId) } : {}),
});
