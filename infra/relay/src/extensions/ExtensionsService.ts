import { RelayDb } from "../db.ts";
import { Clock, Context, Crypto, DateTime, Effect, Encoding, Exit, Layer, Schema } from "effect";
import {
  ContextualEvaluationRequest,
  ContextualJudgment,
  ContextualConflictCheckRequest,
  ContextualConflictJudgment,
  ContextualEquivalenceCheckRequest,
  ContextualEquivalenceJudgment,
  DecisionEvaluationRequest,
  DecisionEvaluationJudgment,
  ExtensionEvaluatorResult,
  type ExtensionFeatureId,
  type ExtensionServiceStatus,
  type ExtensionEvaluationStatusRequest,
} from "@lecturn/contracts";
import type { EnvironmentCredentialPrincipal } from "../environments/EnvironmentCredentials.ts";
import { decisionError, decisionStorage } from "../decisions/DecisionsAccess.ts";
import { makeExtensionsUsageStore, type UsageResult } from "../decisions/DecisionUsageStore.ts";
import type { ExtensionsConfig } from "./ExtensionsConfig.ts";
import { makeExtensionsFundingStore } from "./ExtensionsFundingStore.ts";
import {
  makeExtensionsEvaluatorClient,
  type ExtensionEvaluatorBinding,
  type ExtensionEvaluatorIdentity,
} from "./ExtensionsEvaluatorClient.ts";

const requestSchema = Schema.Union([
  ContextualEvaluationRequest,
  ContextualConflictCheckRequest,
  ContextualEquivalenceCheckRequest,
  DecisionEvaluationRequest,
]);
const decodeEvaluatorResult = Schema.decodeUnknownEffect(ExtensionEvaluatorResult);
const decodeRequest = Schema.decodeUnknownEffect(requestSchema);
const decodeContextual = Schema.decodeUnknownEffect(Schema.Array(ContextualJudgment));
const decodeConflicts = Schema.decodeUnknownEffect(Schema.Array(ContextualConflictJudgment));
const decodeEquivalence = Schema.decodeUnknownEffect(Schema.Array(ContextualEquivalenceJudgment));
const decodeDecisions = Schema.decodeUnknownEffect(Schema.Array(DecisionEvaluationJudgment));
const invalid = () => decisionError("invalid", "Invalid extension evaluation");
/** Canonical JSON makes identity independent of request object insertion order. */
export function extensionCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(extensionCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${extensionCanonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function extensionJudgmentsMatch(
  request: typeof requestSchema.Type,
  result: ExtensionEvaluatorResult,
): boolean {
  const targets = "pairs" in request ? request.pairs : request.targets;
  const ids = result.judgments.map((j) => ("pairId" in j ? j.pairId : j.targetId));
  if (
    ids.length !== targets.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !targets.some((t) => t.id === id))
  )
    return false;
  if (result.policyVersion === "contextual-conflict-v1" && "pairs" in request)
    return result.judgments.every((j) => {
      const p = request.pairs.find((p) => p.id === j.pairId)!;
      return (
        j.leftEvidenceIds.every((id) => p.left.evidence.some((e) => e.id === id)) &&
        j.rightEvidenceIds.every((id) => p.right.evidence.some((e) => e.id === id))
      );
    });
  if (
    (result.policyVersion === "contextual-v1" ||
      result.policyVersion === "contextual-localization-v1") &&
    "targets" in request
  )
    return result.judgments.every((j) => {
      const target = request.targets.find((t) => t.id === j.targetId);
      return (
        target &&
        "evidence" in target &&
        j.selectedEvidenceIds.every((id) => target.evidence.some((e) => e.id === id)) &&
        (j.selectedEvidenceSpans === undefined ||
          (j.selectedEvidenceSpans.length === j.selectedEvidenceIds.length &&
            j.selectedEvidenceSpans.every(
              (span) =>
                j.selectedEvidenceIds.includes(span.evidenceId) &&
                target.evidence.some(
                  (e) => e.id === span.evidenceId && span.start >= e.start && span.end <= e.end,
                ),
            )))
      );
    });
  return true;
}
export const makeExtensionsService = (
  config: ExtensionsConfig,
  approvalOrigin: string,
  binding: Effect.Effect<ExtensionEvaluatorBinding | undefined>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const { $client: sql } = yield* RelayDb;
    const funding = yield* makeExtensionsFundingStore(config, approvalOrigin);
    const evaluator = makeExtensionsEvaluatorClient(binding, config.shared.requestTimeoutMs);
    const usage = {
      decisions: yield* makeExtensionsUsageStore<unknown>({
        ...config.shared,
        ...config.decisions,
        featureId: "decisions",
      }),
      contextual: yield* makeExtensionsUsageStore<unknown>({
        ...config.shared,
        ...config.contextual,
        featureId: "contextual",
      }),
    };
    const fingerprint = Effect.fn("Extensions.fingerprint")(function* (request: unknown) {
      return yield* crypto
        .digest("SHA-256", new TextEncoder().encode(extensionCanonicalJson(request)))
        .pipe(Effect.map(Encoding.encodeHex), Effect.mapError(invalid));
    });
    const status = Effect.fn("Extensions.status")(function* (
      payerId: string,
    ): Effect.fn.Return<
      ExtensionServiceStatus,
      import("@lecturn/contracts").DecisionEvaluationError
    > {
      const available = yield* evaluator.available;
      const features = [];
      let allowance: ExtensionServiceStatus["allowance"] = null;
      for (const featureId of ["decisions", "contextual"] as const) {
        const access = yield* funding[featureId].access.status(payerId);
        features.push({
          featureId,
          available,
          enabled: access.enabled,
          eligible: access.eligible,
          reason: access.reason,
        });
        if (access.eligible && !allowance)
          allowance = yield* usage[featureId].getSharedAllowance(payerId);
      }
      return { features, allowance };
    });
    const evaluate = Effect.fn("Extensions.evaluate")(function* (
      host: EnvironmentCredentialPrincipal,
      raw: unknown,
      operation: "relevance" | "conflicts" | "equivalence" | "decisions",
    ) {
      const decoded = yield* decodeRequest(raw, { onExcessProperty: "error" }).pipe(
        Effect.mapError(invalid),
      );
      const explicitRetry = "explicitRetry" in decoded && decoded.explicitRetry === true;
      const request =
        "explicitRetry" in decoded
          ? (({ explicitRetry: _retry, ...content }) => content)(decoded)
          : decoded;
      const featureId: ExtensionFeatureId =
        "featureId" in request ? request.featureId : "decisions";
      if (!config[featureId].enabled)
        return yield* decisionError("unavailable", "This extension is unavailable");
      if (
        ("task" in request && request.task.environmentId !== host.environmentId) ||
        ("environmentId" in request && request.environmentId !== host.environmentId)
      )
        return yield* decisionError("forbidden", "Task belongs to another environment");
      const policyVersion =
        operation === "decisions"
          ? "decisions-v1"
          : operation === "conflicts"
            ? "contextual-conflict-v1"
            : operation === "equivalence"
              ? "decisions-equivalence-v1"
              : "contextual-v1";
      if (
        (operation === "conflicts") !== "pairs" in request ||
        (operation === "decisions") !== !("featureId" in request) ||
        (operation === "equivalence") !==
          (request.templateVersion === "decisions-equivalence-v1") ||
        (operation === "relevance" && featureId !== "contextual")
      )
        return yield* invalid();
      const { payerId } = yield* funding[featureId].requireFunding(host, request.fundingGeneration);
      const store = usage[featureId];
      const requestFingerprint = yield* fingerprint(request);
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admission = yield* store.reserve({
            principal: host,
            payerId,
            fundingGeneration: request.fundingGeneration,
            requestId: request.requestId,
            runId: request.runId,
            fingerprint: requestFingerprint,
            templateVersion: policyVersion,
            model: "extensions-v1",
            backend: "private-evaluator",
            ...(explicitRetry ? { explicitRetry: true } : {}),
          });
          let result: UsageResult<unknown>;
          if (admission.kind === "replay") {
            const { qualificationId: storedQualification, ...cached } = admission.result;
            result = cached;
            if (operation === "equivalence" && storedQualification) {
              const qualification = yield* Effect.gen(function* () {
                const pending = yield* store.pendingAttempt({
                  principal: host,
                  payerId,
                  fundingGeneration: request.fundingGeneration,
                  requestId: request.requestId,
                });
                const attempt = pending.attempt;
                if (
                  !attempt ||
                  attempt.backend !== "private-evaluator" ||
                  attempt.policy_version !== "decisions-equivalence-v1"
                )
                  return undefined;
                const current = yield* evaluator.status({
                  environmentId: host.environmentId,
                  attemptId: attempt.id,
                  featureId,
                  policyVersion: attempt.policy_version,
                  model: "extensions-v1",
                  requestFingerprint: attempt.request_fingerprint,
                  admissibilityEpoch: attempt.created_at,
                });
                return current.status === "completed" &&
                  current.result.policyVersion === "decisions-equivalence-v1" &&
                  current.result.qualificationId === storedQualification
                  ? storedQualification
                  : undefined;
              }).pipe(Effect.orElseSucceed(() => undefined));
              if (qualification) result = { ...cached, qualificationId: qualification };
            }
          } else {
            if (admission.kind === "in-progress")
              return yield* decisionError(
                "in-progress",
                "This evaluation is pending; check its status",
              );
            if (!(yield* evaluator.available)) {
              yield* store.failBeforeDispatch(admission.attemptId);
              return yield* decisionError("unavailable", "This extension is unavailable");
            }
            if (admission.backend !== "private-evaluator") {
              yield* store.failBeforeDispatch(admission.attemptId);
              return yield* decisionError(
                "conflict",
                "This request belongs to the legacy evaluator",
              );
            }
            const identity: ExtensionEvaluatorIdentity = {
              environmentId: host.environmentId,
              attemptId: admission.attemptId,
              featureId,
              policyVersion,
              model: "extensions-v1",
              requestFingerprint,
              admissibilityEpoch: admission.admissibilityEpoch,
            };
            const dispatched = yield* store
              .markDispatched(admission.attemptId)
              .pipe(
                Effect.tapError(() =>
                  store.failBeforeDispatch(admission.attemptId).pipe(Effect.ignore),
                ),
              );
            if (!dispatched)
              return yield* decisionError("in-progress", "This evaluation cannot be dispatched");
            const response = yield* restore(evaluator.evaluate(identity, request)).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : store.markUnknown(admission.attemptId).pipe(Effect.ignore),
              ),
            );
            if (response.status !== "completed") {
              if (response.status === "refused" && response.dispatched === false)
                yield* store.refuse(admission.attemptId);
              else yield* store.markUnknown(admission.attemptId);
              return yield* decisionError(
                response.status === "expired"
                  ? "expired"
                  : response.status === "refused"
                    ? "unavailable"
                    : "in-progress",
                "This evaluation did not produce a confirmed result",
              );
            }
            if (!extensionJudgmentsMatch(request, response.result)) {
              yield* store.markUnknown(admission.attemptId);
              return yield* decisionError(
                "unavailable",
                "Evaluator evidence references did not match the request",
              );
            }
            const settled = yield* store.settle(admission.attemptId, response.result);
            if (settled.kind === "late")
              return yield* decisionError(
                "expired",
                "Evaluation completed after its accounting deadline",
              );
            result = settled.result;
          }
          const verifiedResult = yield* decodeEvaluatorResult({
            policyVersion: result.templateVersion,
            model: result.model,
            inputTokens: result.inputTokens,
            judgments: result.judgments,
            ...(operation === "equivalence" && result.qualificationId
              ? { qualificationId: result.qualificationId }
              : {}),
          }).pipe(Effect.mapError(invalid));
          if (!extensionJudgmentsMatch(request, verifiedResult)) return yield* invalid();
          // Successful settlement never grants a stale caller permission to retrieve retained results.
          yield* funding[featureId].requireFunding(host, request.fundingGeneration);
          const allowance = yield* store.getSharedAllowance(payerId);
          const { qualificationId: _qualification, ...unqualifiedResult } = result;
          const common = {
            ...unqualifiedResult,
            templateVersion: request.templateVersion,
            policyVersion: request.templateVersion,
            allowance,
          };
          if (operation === "decisions")
            return {
              ...common,
              judgments: yield* decodeDecisions(result.judgments).pipe(Effect.mapError(invalid)),
            };
          if (operation === "conflicts")
            return {
              ...common,
              judgments: yield* decodeConflicts(result.judgments).pipe(Effect.mapError(invalid)),
              coverage: {
                complete: true,
                missingAntecedents: false,
                truncated: false,
                unexaminedCount: 0,
              },
            };
          if (operation === "equivalence")
            return {
              ...common,
              ...(verifiedResult.policyVersion === "decisions-equivalence-v1" &&
              verifiedResult.qualificationId
                ? { qualificationId: verifiedResult.qualificationId }
                : {}),
              judgments: yield* decodeEquivalence(result.judgments).pipe(Effect.mapError(invalid)),
            };
          return {
            ...common,
            judgments: yield* decodeContextual(result.judgments).pipe(Effect.mapError(invalid)),
          };
        }),
      );
    }, Effect.withTracerEnabled(false));
    const evaluationStatus = Effect.fn("Extensions.evaluationStatus")(function* (
      host: EnvironmentCredentialPrincipal,
      input: ExtensionEvaluationStatusRequest,
    ) {
      const { payerId } = yield* funding[input.featureId].requireFunding(
        host,
        input.fundingGeneration,
      );
      const store = usage[input.featureId];
      let pending = yield* store.pendingAttempt({
        principal: host,
        payerId,
        fundingGeneration: input.fundingGeneration,
        requestId: input.requestId,
      });
      const attempt = pending.attempt;
      if (
        attempt &&
        attempt.backend === "private-evaluator" &&
        ["dispatched", "unknown", "expired"].includes(attempt.status)
      ) {
        const result = yield* evaluator.status({
          environmentId: host.environmentId,
          attemptId: attempt.id,
          featureId: input.featureId,
          policyVersion: attempt.policy_version,
          model: "extensions-v1",
          requestFingerprint: attempt.request_fingerprint,
          admissibilityEpoch: attempt.created_at,
        });
        if (result.status === "completed") yield* store.settle(attempt.id, result.result);
        else if (result.status === "refused" && result.dispatched === false)
          yield* store.refuse(attempt.id);
        pending = yield* store.pendingAttempt({
          principal: host,
          payerId,
          fundingGeneration: input.fundingGeneration,
          requestId: input.requestId,
        });
      }
      const state =
        pending.request.status === "succeeded"
          ? ("succeeded" as const)
          : pending.request.status === "unknown"
            ? ("unknown" as const)
            : pending.request.status === "expired"
              ? ("expired" as const)
              : pending.request.status === "failed"
                ? ("refused-before-dispatch" as const)
                : ("pending" as const);
      return {
        featureId: input.featureId,
        requestId: input.requestId,
        state,
        inputTokens: state === "succeeded" ? pending.request.debited_input_tokens : null,
        allowance: yield* store.getSharedAllowance(payerId),
      };
    });
    const reconcilePrivate = Effect.fn("Extensions.reconcilePrivate")(function* () {
      if (!(yield* evaluator.available)) return;
      for (const featureId of ["decisions", "contextual"] as const) {
        const store = usage[featureId];
        for (const attempt of yield* store.recoveryAttempts())
          yield* Effect.gen(function* () {
            const response = yield* evaluator.status({
              environmentId: attempt.environment_id,
              attemptId: attempt.id,
              featureId,
              policyVersion: attempt.policy_version,
              model: "extensions-v1",
              requestFingerprint: attempt.request_fingerprint,
              admissibilityEpoch: attempt.created_at,
            });
            if (response.status === "completed") yield* store.settle(attempt.id, response.result);
            else if (response.status === "refused") yield* store.refuse(attempt.id);
          }).pipe(Effect.ignore);
      }
    });
    const cleanupPrivate = Effect.fn("Extensions.cleanupPrivate")(function* () {
      if (!(yield* evaluator.available)) return;
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const cutoff =
        now -
        Math.max(config.shared.resultRetentionSeconds, config.shared.unknownHoldSeconds, 3600);

      const rows = yield* decisionStorage(
        sql<{
          environment_id: string;
          minimum_admissibility_epoch: number;
          cutoff: number;
        }>`WITH due AS (SELECT environment_id FROM relay_extensions_evaluator_cleanup WHERE next_check_at<=${now} ORDER BY next_check_at,environment_id LIMIT 10 FOR UPDATE SKIP LOCKED) UPDATE relay_extensions_evaluator_cleanup c SET next_check_at=${now + 3600} FROM due WHERE c.environment_id=due.environment_id RETURNING c.environment_id,c.minimum_admissibility_epoch::float8,GREATEST(c.minimum_admissibility_epoch,LEAST(${cutoff},COALESCE((SELECT min(a.created_at) FROM relay_decision_usage_attempts a WHERE a.environment_id=c.environment_id AND a.backend='private-evaluator' AND a.cost_nano IS NULL),${cutoff})))::float8 AS cutoff`,
      );
      for (const row of rows)
        yield* evaluator
          .cleanup(
            row.environment_id,
            row.cutoff,
            DateTime.formatIso(DateTime.makeUnsafe(cutoff * 1000)),
          )
          .pipe(
            Effect.andThen(
              decisionStorage(
                sql`UPDATE relay_extensions_evaluator_cleanup SET minimum_admissibility_epoch=GREATEST(minimum_admissibility_epoch,${row.cutoff}) WHERE environment_id=${row.environment_id}`,
              ),
            ),
            Effect.ignore,
          );
    });
    return {
      funding,
      usage,
      evaluate,
      evaluationStatus,
      status,
      evaluator,
      reconcilePrivate,
      cleanupPrivate,
    };
  });
export class ExtensionsService extends Context.Service<
  ExtensionsService,
  Effect.Success<ReturnType<typeof makeExtensionsService>>
>()("lecturn-relay/extensions/ExtensionsService") {}
export const extensionsLayer = (
  config: ExtensionsConfig,
  origin: string,
  binding: Effect.Effect<ExtensionEvaluatorBinding | undefined>,
) => Layer.effect(ExtensionsService, makeExtensionsService(config, origin, binding));
