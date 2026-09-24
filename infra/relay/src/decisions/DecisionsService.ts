import { Context, Crypto, Effect, Encoding, Exit, Layer, Schema } from "effect";
import {
  DecisionEvaluationRequest,
  type DecisionEvaluationError,
  type DecisionEvaluationResult,
  type RelayDecisionsStatus,
} from "@lecturn/contracts";
import type { EnvironmentCredentialPrincipal } from "../environments/EnvironmentCredentials.ts";
import { decisionError, makeDecisionsAccess } from "./DecisionsAccess.ts";
import { makeDecisionFundingStore, type DecisionFundingStore } from "./DecisionFundingStore.ts";
import { makeDecisionUsageStore, type DecisionUsageStore } from "./DecisionUsageStore.ts";
import { DECISION_MODEL, DECISION_TEMPLATE, type DecisionsConfig } from "./DecisionsConfig.ts";
import {
  observeDecisionEvaluation,
  recordDecisionAttempt,
  recordDecisionTokens,
} from "./DecisionsTelemetry.ts";
import { makeJevClient } from "./JevClient.ts";

const decodeRequest = Schema.decodeUnknownEffect(DecisionEvaluationRequest);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(DecisionEvaluationRequest));
export interface DecisionEvaluationDependencies {
  readonly funding: Pick<DecisionFundingStore, "requireFunding">;
  readonly usage: Pick<
    DecisionUsageStore,
    "reserve" | "markDispatched" | "settle" | "failBeforeDispatch" | "markUnknown"
  >;
  readonly jev: Effect.Success<ReturnType<typeof makeJevClient>>;
  readonly fingerprint: (
    request: DecisionEvaluationRequest,
  ) => Effect.Effect<string, DecisionEvaluationError>;
}
/** Reservation and settlement are uninterruptible; only the metered upstream call is interruptible. */
export function makeDecisionEvaluation(
  config: DecisionsConfig,
  deps: DecisionEvaluationDependencies,
) {
  return Effect.fn("Decisions.evaluate")(
    function* (
      principal: EnvironmentCredentialPrincipal,
      raw: DecisionEvaluationRequest,
    ): Effect.fn.Return<DecisionEvaluationResult, DecisionEvaluationError> {
      const request = yield* decodeRequest(raw, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => decisionError("invalid", "Invalid decision evaluation request")),
      );
      if (!config.enabled || !config.valid)
        return yield* decisionError("unavailable", "Decisions evaluation is disabled");
      if (request.templateVersion !== DECISION_TEMPLATE)
        return yield* decisionError("invalid", "Unsupported decision template");
      const { payerId } = yield* deps.funding.requireFunding(principal, request.fundingGeneration);
      const fingerprint = yield* deps.fingerprint(request);
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admission = yield* deps.usage.reserve({
            principal,
            payerId,
            fundingGeneration: request.fundingGeneration,
            requestId: request.requestId,
            runId: request.runId,
            fingerprint,
            templateVersion: request.templateVersion,
            model: DECISION_MODEL,
            ...(request.explicitRetry ? { explicitRetry: true } : {}),
          });
          if (admission.kind === "replay") return admission.result;
          if (admission.kind === "in-progress")
            return yield* decisionError("in-progress", "This evaluation is already pending");
          const dispatched = yield* deps.usage
            .markDispatched(admission.attemptId)
            .pipe(
              Effect.tapError(() =>
                deps.usage.failBeforeDispatch(admission.attemptId).pipe(Effect.ignore),
              ),
            );
          if (!dispatched)
            return yield* decisionError(
              "in-progress",
              "This evaluation is no longer available for dispatch",
            );
          yield* recordDecisionAttempt("dispatched");
          const evaluated = yield* restore(deps.jev.evaluate(request)).pipe(
            Effect.withTracerEnabled(false),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : deps.usage
                    .markUnknown(admission.attemptId)
                    .pipe(Effect.ignore, Effect.andThen(recordDecisionAttempt("unknown"))),
            ),
          );
          yield* recordDecisionTokens(evaluated.inputTokens);
          const settled = yield* deps.usage
            .settle(admission.attemptId, evaluated)
            .pipe(
              Effect.tapError(() =>
                deps.usage.markUnknown(admission.attemptId).pipe(Effect.ignore),
              ),
            );
          if (settled.kind === "late") {
            yield* recordDecisionAttempt("late");
            return yield* decisionError(
              "expired",
              "This evaluation finished after its deadline; no allowance was charged",
            );
          }
          return settled.result;
        }),
      );
    },
    observeDecisionEvaluation,
    Effect.withTracerEnabled(false),
  );
}
export const makeDecisionsService = (config: DecisionsConfig, approvalOrigin: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const access = yield* makeDecisionsAccess(config);
    const funding = yield* makeDecisionFundingStore(access, { approvalOrigin });
    const usage = yield* makeDecisionUsageStore(config);
    const jev = yield* makeJevClient(config);
    const fingerprint = Effect.fn("Decisions.fingerprint")(function* (
      request: DecisionEvaluationRequest,
    ) {
      const { explicitRetry: _retry, ...content } = request;
      return yield* crypto.digest("SHA-256", new TextEncoder().encode(encodeRequest(content))).pipe(
        Effect.map(Encoding.encodeHex),
        Effect.mapError(() => decisionError("unavailable", "Decision evaluation is unavailable")),
      );
    }, Effect.withTracerEnabled(false));
    const status = Effect.fn("Decisions.status")(function* (
      userId: string,
    ): Effect.fn.Return<RelayDecisionsStatus, DecisionEvaluationError> {
      const result = yield* access.status(userId);
      return {
        enabled: result.enabled,
        eligible: result.eligible,
        reason: result.reason,
        allowance: result.eligible ? yield* usage.getAllowance(userId) : null,
      };
    });
    const fundingStatus = Effect.fn("Decisions.fundingStatus")(function* (
      principal: EnvironmentCredentialPrincipal,
    ) {
      const result = yield* funding.status(principal);
      if (!result.eligible) return result;
      const { payerId } = yield* funding.requireFunding(principal, result.generation);
      return { ...result, allowance: yield* usage.getAllowance(payerId) };
    });
    return {
      access,
      funding,
      usage,
      status,
      fundingStatus,
      evaluate: makeDecisionEvaluation(config, { funding, usage, jev, fingerprint }),
    };
  });
export class DecisionsService extends Context.Service<
  DecisionsService,
  Effect.Success<ReturnType<typeof makeDecisionsService>>
>()("lecturn-relay/decisions/DecisionsService") {}
export const decisionsLayer = (config: DecisionsConfig, approvalOrigin: string) =>
  Layer.effect(DecisionsService, makeDecisionsService(config, approvalOrigin));
