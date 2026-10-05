import { ExtensionsService } from "../extensions/ExtensionsService.ts";
import { Context, Crypto, Effect, Encoding, Layer, Option, Schema } from "effect";
import {
  DecisionEvaluationRequest,
  type DecisionEvaluationError,
  DecisionEvaluationResult,
  type RelayDecisionsStatus,
} from "@lecturn/contracts";
import type { EnvironmentCredentialPrincipal } from "../environments/EnvironmentCredentials.ts";
import { decisionError, makeDecisionsAccess } from "./DecisionsAccess.ts";
import { makeDecisionFundingStore, type DecisionFundingStore } from "./DecisionFundingStore.ts";
import { makeDecisionUsageStore, type DecisionUsageStore } from "./DecisionUsageStore.ts";
import { DECISION_TEMPLATE, type DecisionsConfig } from "./DecisionsConfig.ts";
const decodeResult = Schema.decodeUnknownEffect(DecisionEvaluationResult);
const decodeRequest = Schema.decodeUnknownEffect(DecisionEvaluationRequest);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(DecisionEvaluationRequest));
export interface DecisionEvaluationDependencies {
  readonly funding: Pick<DecisionFundingStore, "requireFunding">;
  readonly usage: Pick<DecisionUsageStore, "requestBackend" | "replayLegacy">;
  readonly evaluator:
    | ((
        principal: EnvironmentCredentialPrincipal,
        request: DecisionEvaluationRequest,
      ) => Effect.Effect<DecisionEvaluationResult, DecisionEvaluationError>)
    | null;
  readonly fingerprint: (
    request: DecisionEvaluationRequest,
  ) => Effect.Effect<string, DecisionEvaluationError>;
}
/** Retired requests can replay settled results, but never dispatch through another backend. */
export function makeDecisionEvaluation(
  config: DecisionsConfig,
  deps: DecisionEvaluationDependencies,
) {
  return Effect.fn("Decisions.evaluatePinnedBackend")(function* (
    principal: EnvironmentCredentialPrincipal,
    raw: DecisionEvaluationRequest,
  ) {
    const request = yield* decodeRequest(raw, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => decisionError("invalid", "Invalid decision evaluation request")),
    );
    if (!config.enabled || !config.valid)
      return yield* decisionError("unavailable", "Decisions evaluation is disabled");
    if (request.templateVersion !== DECISION_TEMPLATE)
      return yield* decisionError("invalid", "Unsupported decision template");
    const { payerId } = yield* deps.funding.requireFunding(principal, request.fundingGeneration);
    const identity = {
      principal,
      payerId,
      fundingGeneration: request.fundingGeneration,
      requestId: request.requestId,
    };
    const pinned = yield* deps.usage.requestBackend(identity);
    if (pinned !== null && pinned !== "private-evaluator")
      return yield* deps.usage.replayLegacy({
        ...identity,
        runId: request.runId,
        templateVersion: request.templateVersion,
        fingerprint: yield* deps.fingerprint(request),
      });
    if (!deps.evaluator)
      return yield* decisionError("unavailable", "Extensions evaluator is unavailable");
    return yield* deps.evaluator(principal, request);
  }, Effect.withTracerEnabled(false));
}
export const makeDecisionsService = (config: DecisionsConfig, approvalOrigin: string) =>
  Effect.gen(function* () {
    const extensions = yield* Effect.serviceOption(ExtensionsService);
    const crypto = yield* Crypto.Crypto;
    const access = yield* makeDecisionsAccess(config);
    const funding = yield* makeDecisionFundingStore(access, { approvalOrigin });
    const usage = yield* makeDecisionUsageStore(config);
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
    const evaluate = makeDecisionEvaluation(config, {
      funding,
      usage,
      fingerprint,
      evaluator: Option.isNone(extensions)
        ? null
        : (principal, request) =>
            extensions.value
              .evaluate(principal, request, "decisions")
              .pipe(
                Effect.flatMap((result) =>
                  decodeResult(result).pipe(
                    Effect.mapError(() =>
                      decisionError(
                        "unavailable",
                        "Decision evaluation did not return a valid response",
                      ),
                    ),
                  ),
                ),
              ),
    });
    return {
      access,
      funding,
      usage,
      status,
      fundingStatus,
      evaluate,
    };
  });
export class DecisionsService extends Context.Service<
  DecisionsService,
  Effect.Success<ReturnType<typeof makeDecisionsService>>
>()("lecturn-relay/decisions/DecisionsService") {}
export const decisionsLayer = (config: DecisionsConfig, approvalOrigin: string) =>
  Layer.effect(DecisionsService, makeDecisionsService(config, approvalOrigin));
