import { Clock, DateTime, Effect, Schema } from "effect";
import {
  DecisionEvaluationError,
  type DecisionAllowance,
  type ExtensionFeatureId,
  type ExtensionAllowance,
  type DecisionEvaluationJudgment,
  type DecisionEvaluationResult,
} from "@lecturn/contracts";
import { RelayDb } from "../db.ts";
import type { EnvironmentCredentialPrincipal } from "../environments/EnvironmentCredentials.ts";
import {
  decisionError,
  decisionStorage,
  makeDecisionsAccess,
  type DecisionsAccessConfig,
} from "./DecisionsAccess.ts";

export interface DecisionUsageConfig extends DecisionsAccessConfig {
  readonly priceNanoUsdPerInputToken: number;
  readonly attemptHoldNanoUsd: number;
  readonly runBudgetNanoUsd: number;
  readonly maxAttemptsPerRun: number;
  readonly maxAttemptsPerRequest: number;
  readonly accountConcurrency: number;
  readonly environmentConcurrency: number;
  readonly requestsPerMinute: number;
  readonly accountExposureNanoUsd: number;
  readonly globalExposureNanoUsd: number;
  readonly unknownHoldSeconds: number;
  readonly resultRetentionSeconds: number;
  readonly maxActualInputTokens: number;
}
export const decisionUsageDefaults = {
  priceNanoUsdPerInputToken: 42,
  attemptHoldNanoUsd: 10_000_000,
  runBudgetNanoUsd: 30_000_000,
  maxAttemptsPerRun: 24,
  maxAttemptsPerRequest: 2,
  accountConcurrency: 2,
  environmentConcurrency: 1,
  requestsPerMinute: 60,
  accountExposureNanoUsd: 100_000_000,
  globalExposureNanoUsd: 1_000_000_000,
  unknownHoldSeconds: 120,
  resultRetentionSeconds: 86400,
  maxActualInputTokens: 64000,
} as const;
export interface DecisionUsageReservation {
  readonly principal: EnvironmentCredentialPrincipal;
  readonly payerId: string;
  readonly fundingGeneration: number;
  readonly requestId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly templateVersion: string;
  readonly model: string;
  readonly explicitRetry?: boolean;
  readonly backend?: "legacy" | "private-evaluator";
}
export type UsageResult<J> = Omit<DecisionEvaluationResult, "judgments"> & {
  readonly judgments: readonly J[];
  readonly qualificationId?: string | undefined;
};
export type DecisionUsageAdmission<J = DecisionEvaluationJudgment> =
  | {
      readonly kind: "admitted";
      readonly attemptId: string;
      readonly allowance: DecisionAllowance;
      readonly backend: string;
      readonly admissibilityEpoch: number;
    }
  | { readonly kind: "replay"; readonly result: UsageResult<J> }
  | { readonly kind: "in-progress" };
interface UsageRequest<J> {
  backend: string;
  payer_id: string;
  request_id: string;
  environment_id: string;
  public_key: string;
  credential_id: string;
  funding_generation: number;
  run_id: string;
  fingerprint: string;
  model: string;
  template_version: string;
  window_start: number;
  window_end: number;
  hold_tokens: number;
  debited_input_tokens: number;
  status: string;
  attempt_count: number;
  active_attempt_id: string | null;
  result_json: readonly J[] | null;
  qualification_id: string | null;
  result_expires_at: number | null;
}
interface Attempt {
  feature_id: ExtensionFeatureId;
  backend: string;
  policy_version: string;
  request_fingerprint: string;
  created_at: number;
  id: string;
  payer_id: string;
  request_id: string;
  run_id: string;
  environment_id: string;
  window_start: number;
  hold_nano: number;
  price_nano: number;
  status: string;
  deadline: number;
  actual_tokens: number | null;
  cost_nano: number | null;
}
const isDecisionError = Schema.is(DecisionEvaluationError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const nowSeconds = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
const iso = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

export const makeExtensionsUsageStore = <J = DecisionEvaluationJudgment>(
  config: DecisionUsageConfig,
) =>
  Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    const access = yield* makeDecisionsAccess(config);
    const featureId = config.featureId ?? "decisions";
    const transaction = <A>(effect: Effect.Effect<A, DecisionEvaluationError>) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(192837465)`;
            yield* sql`SELECT set_config('lecturn.extensions_reservation_epoch','1',true)`;
            return yield* effect;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isDecisionError(error)
              ? error
              : decisionError("unavailable", "Decisions storage is temporarily unavailable"),
          ),
        );
    const requestRow = (payerId: string, requestId: string) =>
      decisionStorage(
        sql<
          UsageRequest<J>
        >`SELECT backend,payer_id,request_id,environment_id,public_key,credential_id,funding_generation,run_id,fingerprint,model,template_version,window_start::float8,window_end::float8,hold_tokens::float8,debited_input_tokens::float8,status,attempt_count,active_attempt_id,result_json,qualification_id,result_expires_at::float8 FROM relay_decision_usage_requests WHERE feature_id=${featureId} AND payer_id=${payerId} AND request_id=${requestId} FOR UPDATE`,
      ).pipe(Effect.map((rows) => rows[0]));
    const attemptRow = (attemptId: string) =>
      decisionStorage(
        sql<Attempt>`SELECT feature_id,backend,policy_version,request_fingerprint,created_at::float8,id,payer_id,request_id,run_id,environment_id,window_start::float8,hold_nano::float8,price_nano::float8,status,deadline::float8,actual_tokens::float8,cost_nano::float8 FROM relay_decision_usage_attempts WHERE feature_id=${featureId} AND id=${attemptId}`,
      ).pipe(Effect.map((rows) => rows[0]));
    const lockAccount = Effect.fn("DecisionUsage.lockAccount")(function* (payerId: string) {
      yield* decisionStorage(
        sql`INSERT INTO relay_decision_usage_accounts(payer_id) VALUES (${payerId}) ON CONFLICT DO NOTHING`,
      );
      const rows = yield* decisionStorage(
        sql<{
          exposure_nano: number;
        }>`SELECT exposure_nano::float8 FROM relay_decision_usage_accounts WHERE payer_id=${payerId} FOR UPDATE`,
      );
      return rows[0]!;
    });
    const lockWindow = Effect.fn("DecisionUsage.lockWindow")(function* (
      payerId: string,
      start: number,
      end: number,
    ) {
      yield* decisionStorage(
        sql`INSERT INTO relay_decision_usage_windows(payer_id,window_start,window_end) VALUES (${payerId},${start},${end}) ON CONFLICT DO NOTHING`,
      );
      yield* decisionStorage(
        sql`SELECT 1 FROM relay_decision_usage_windows WHERE payer_id=${payerId} AND window_start=${start} FOR UPDATE`,
      );
    });
    const allowance = Effect.fn("DecisionUsage.allowance")(function* (
      payerId: string,
      start: number,
      end: number,
      limit: number,
    ): Effect.fn.Return<DecisionAllowance, DecisionEvaluationError> {
      const rows = yield* decisionStorage(
        sql<{
          used: number;
          reserved: number;
          limit_input_tokens: number | null;
        }>`SELECT limit_input_tokens::float8,used_input_tokens::float8 AS used,reserved_input_tokens::float8 AS reserved FROM relay_decision_usage_windows WHERE payer_id=${payerId} AND window_start=${start}`,
      );
      const used = rows[0]?.used ?? 0,
        reserved = rows[0]?.reserved ?? 0;
      const pinnedLimit = rows[0]?.limit_input_tokens ?? limit;
      return {
        windowStart: iso(start),
        windowEnd: iso(end),
        limitInputTokens: pinnedLimit,
        usedInputTokens: used,
        reservedInputTokens: reserved,
        remainingInputTokens: Math.max(0, pinnedLimit - used - reserved),
      };
    });
    const getAllowance = Effect.fn("DecisionUsage.getAllowance")(function* (payerId: string) {
      const eligibility = yield* access.status(payerId);
      if (!eligibility.eligible || !eligibility.window)
        return yield* decisionError("forbidden", "Decisions requires an eligible paid account");
      const time = yield* nowSeconds;
      const prior = yield* decisionStorage(
        sql<{
          start: number;
          end: number;
        }>`SELECT window_start::float8 AS start,window_end::float8 AS end FROM relay_decision_usage_windows WHERE payer_id=${payerId} AND window_start<=${time} AND window_end>${time} ORDER BY window_start DESC LIMIT 1`,
      );
      return yield* allowance(
        payerId,
        prior[0]?.start ?? eligibility.window.start,
        prior[0]?.end ?? eligibility.window.end,
        eligibility.limitInputTokens,
      );
    });
    const assertFunding = Effect.fn("DecisionUsage.assertFunding")(function* (
      input: Pick<DecisionUsageReservation, "principal" | "payerId" | "fundingGeneration">,
    ) {
      const host = input.principal;
      const rows =
        yield* decisionStorage(sql`SELECT 1 FROM relay_decision_funding f WHERE f.feature_id=${featureId} AND f.environment_id=${host.environmentId} AND f.public_key=${host.environmentPublicKey} AND f.generation=${input.fundingGeneration} AND f.payer_id=${input.payerId} AND f.state='active'
      AND EXISTS(SELECT 1 FROM relay_environment_credentials c WHERE c.credential_id=${host.credentialId} AND c.environment_id=f.environment_id AND c.environment_public_key=f.public_key AND c.revoked_at IS NULL)
      AND EXISTS(SELECT 1 FROM relay_environment_links l WHERE l.environment_id=f.environment_id AND l.environment_public_key=f.public_key AND l.revoked_at IS NULL) FOR UPDATE OF f`);
      if (!rows.length)
        return yield* decisionError("forbidden", "Decisions funding changed or was revoked");
    });
    const lockControl = Effect.fn("DecisionUsage.lockControl")(function* () {
      const rows = yield* decisionStorage(
        sql<{
          exposure_nano: number;
          anomaly: boolean;
        }>`SELECT exposure_nano::float8,anomaly FROM relay_decision_usage_control WHERE id=1 FOR UPDATE`,
      );
      if (!rows[0])
        return yield* decisionError("unavailable", "Decisions accounting is unavailable");
      return rows[0];
    });
    const storedResult = Effect.fn("DecisionUsage.storedResult")(function* (
      request: UsageRequest<J>,
      limit: number,
      replayed: boolean,
    ): Effect.fn.Return<UsageResult<J>, DecisionEvaluationError> {
      return {
        requestId: request.request_id,
        runId: request.run_id,
        model: request.model,
        templateVersion: request.template_version,
        judgments: request.result_json ?? [],
        ...(request.template_version === "decisions-equivalence-v1" &&
        request.backend === "private-evaluator" &&
        request.qualification_id
          ? { qualificationId: request.qualification_id }
          : {}),
        inputTokens: request.debited_input_tokens,
        allowance: yield* allowance(
          request.payer_id,
          request.window_start,
          request.window_end,
          limit,
        ),
        replayed,
      };
    });
    const reserve = Effect.fn("DecisionUsage.reserve")(function* (
      input: DecisionUsageReservation,
    ): Effect.fn.Return<DecisionUsageAdmission<J>, DecisionEvaluationError> {
      return yield* transaction(
        Effect.gen(function* () {
          const time = yield* nowSeconds;
          const account = yield* lockAccount(input.payerId);
          const eligibility = yield* access.status(input.payerId);
          if (!eligibility.eligible || !eligibility.window)
            return yield* decisionError("forbidden", "Decisions requires an eligible paid account");
          const prior = yield* decisionStorage(
            sql<{
              start: number;
              end: number;
              limit_input_tokens: number | null;
            }>`SELECT window_start::float8 AS start,window_end::float8 AS end,limit_input_tokens::float8 FROM relay_decision_usage_windows WHERE payer_id=${input.payerId} AND window_start<=${time} AND window_end>${time} ORDER BY window_start DESC LIMIT 1 FOR UPDATE`,
          );
          const { start, end } = prior[0] ?? eligibility.window;
          yield* lockWindow(input.payerId, start, end);
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_windows SET limit_input_tokens=COALESCE(limit_input_tokens,${eligibility.limitInputTokens}),pool_basis=COALESCE(pool_basis,${eligibility.basis ?? "subscription"}) WHERE payer_id=${input.payerId} AND window_start=${start}`,
          );
          yield* assertFunding(input);
          yield* decisionStorage(
            sql`INSERT INTO relay_decision_usage_requests(feature_id,backend,payer_id,request_id,environment_id,public_key,credential_id,funding_generation,run_id,fingerprint,model,template_version,window_start,window_end,created_at) VALUES (${featureId},${input.backend ?? "legacy"},${input.payerId},${input.requestId},${input.principal.environmentId},${input.principal.environmentPublicKey},${input.principal.credentialId},${input.fundingGeneration},${input.runId},${input.fingerprint},${input.model},${input.templateVersion},${start},${end},${time}) ON CONFLICT DO NOTHING`,
          );
          const request = (yield* requestRow(input.payerId, input.requestId))!;
          if (
            request.fingerprint !== input.fingerprint ||
            request.run_id !== input.runId ||
            request.model !== input.model ||
            request.template_version !== input.templateVersion ||
            request.environment_id !== input.principal.environmentId ||
            request.public_key !== input.principal.environmentPublicKey ||
            request.funding_generation !== input.fundingGeneration
          )
            return yield* decisionError(
              "conflict",
              "Request identity was already used with different inputs",
            );
          if (request.status === "succeeded") {
            if (
              !request.result_json ||
              !request.result_expires_at ||
              request.result_expires_at <= time
            )
              return yield* decisionError("expired", "The stored Decisions result expired");
            return {
              kind: "replay" as const,
              result: yield* storedResult(request, eligibility.limitInputTokens, true),
            };
          }
          if (request.status === "expired" || request.window_start !== start)
            return yield* decisionError(
              "expired",
              "This Decisions request can no longer be retried",
            );
          if (request.attempt_count > 0 && request.status === "pending")
            return { kind: "in-progress" as const };
          if (request.attempt_count > 0 && !input.explicitRetry)
            return { kind: "in-progress" as const };
          if (request.attempt_count >= config.maxAttemptsPerRequest)
            return yield* decisionError(
              "run-budget-exhausted",
              "This request reached its attempt limit",
            );
          yield* decisionStorage(
            sql`INSERT INTO relay_decision_usage_runs(feature_id,payer_id,run_id) VALUES (${featureId},${input.payerId},${input.runId}) ON CONFLICT DO NOTHING`,
          );
          const runs = yield* decisionStorage(
            sql<{
              attempt_count: number;
              spent_nano: number;
            }>`SELECT attempt_count,spent_nano::float8 FROM relay_decision_usage_runs WHERE feature_id=${featureId} AND payer_id=${input.payerId} AND run_id=${input.runId} FOR UPDATE`,
          );
          const run = runs[0]!;
          if (
            run.attempt_count >= config.maxAttemptsPerRun ||
            run.spent_nano + config.attemptHoldNanoUsd > config.runBudgetNanoUsd
          )
            return yield* decisionError(
              "run-budget-exhausted",
              "This analysis reached its spending limit",
            );
          const counts = yield* decisionStorage(
            sql<{
              account_live: number;
              environment_live: number;
              recent: number;
            }>`SELECT count(*) FILTER(WHERE status IN ('admitted','dispatched'))::integer AS account_live,(SELECT count(*)::integer FROM relay_decision_usage_attempts e WHERE e.status IN ('admitted','dispatched') AND e.environment_id=${input.principal.environmentId}) AS environment_live,count(*) FILTER(WHERE created_at>${time - 60})::integer AS recent FROM relay_decision_usage_attempts WHERE payer_id=${input.payerId}`,
          );
          const count = counts[0]!;
          if (
            count.account_live >= config.accountConcurrency ||
            count.environment_live >= config.environmentConcurrency ||
            count.recent >= config.requestsPerMinute
          )
            return yield* decisionError("rate-limited", "Decisions is busy; retry shortly");
          const control = yield* lockControl();
          if (
            control.anomaly ||
            account.exposure_nano + config.attemptHoldNanoUsd > config.accountExposureNanoUsd ||
            control.exposure_nano + config.attemptHoldNanoUsd > config.globalExposureNanoUsd
          )
            return yield* decisionError("unavailable", "Decisions spending is temporarily paused");
          const holdTokens = Math.ceil(
            config.attemptHoldNanoUsd / config.priceNanoUsdPerInputToken,
          );
          const additionalHold = Math.max(0, holdTokens - request.hold_tokens);
          const current = yield* allowance(input.payerId, start, end, eligibility.limitInputTokens);
          if (current.remainingInputTokens < additionalHold)
            return yield* decisionError(
              "allowance-exhausted",
              "Your Decisions allowance is exhausted",
            );
          const attempts = yield* decisionStorage(
            sql<{
              id: string;
            }>`INSERT INTO relay_decision_usage_attempts(feature_id,backend,policy_version,request_fingerprint,id,payer_id,request_id,run_id,environment_id,window_start,hold_nano,price_nano,status,deadline,created_at) VALUES (${featureId},${request.backend},${input.templateVersion},${input.fingerprint},${time}::text || ':' || gen_random_uuid()::text,${input.payerId},${input.requestId},${input.runId},${input.principal.environmentId},${start},${config.attemptHoldNanoUsd},${config.priceNanoUsdPerInputToken},'admitted',${time + config.unknownHoldSeconds},${time}) RETURNING id`,
          );
          const attemptId = attempts[0]!.id;
          if (request.backend === "private-evaluator")
            yield* decisionStorage(
              sql`INSERT INTO relay_extensions_evaluator_cleanup(environment_id) VALUES (${input.principal.environmentId}) ON CONFLICT DO NOTHING`,
            );
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_windows SET reserved_input_tokens=reserved_input_tokens+${additionalHold} WHERE payer_id=${input.payerId} AND window_start=${start}`,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_requests SET status='pending',attempt_count=attempt_count+1,active_attempt_id=${attemptId},credential_id=${input.principal.credentialId},hold_tokens=hold_tokens+${additionalHold} WHERE feature_id=${featureId} AND payer_id=${input.payerId} AND request_id=${input.requestId}`,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_runs SET attempt_count=attempt_count+1,spent_nano=spent_nano+${config.attemptHoldNanoUsd} WHERE feature_id=${featureId} AND payer_id=${input.payerId} AND run_id=${input.runId}`,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_accounts SET exposure_nano=exposure_nano+${config.attemptHoldNanoUsd} WHERE payer_id=${input.payerId}`,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_control SET exposure_nano=exposure_nano+${config.attemptHoldNanoUsd} WHERE id=1`,
          );
          return {
            kind: "admitted" as const,
            attemptId,
            backend: request.backend,
            admissibilityEpoch: time,
            allowance: yield* allowance(input.payerId, start, end, eligibility.limitInputTokens),
          };
        }),
      );
    });
    const lockedAttempt = Effect.fn("DecisionUsage.lockedAttempt")(function* (attemptId: string) {
      const initial = yield* attemptRow(attemptId);
      if (!initial) return yield* decisionError("invalid", "Unknown Decisions attempt");
      yield* lockAccount(initial.payer_id);
      yield* decisionStorage(
        sql`SELECT 1 FROM relay_decision_usage_windows WHERE payer_id=${initial.payer_id} AND window_start=${initial.window_start} FOR UPDATE`,
      );
      yield* decisionStorage(
        sql`SELECT 1 FROM relay_decision_funding WHERE feature_id=${featureId} AND environment_id=${initial.environment_id} FOR UPDATE`,
      );
      const request = (yield* requestRow(initial.payer_id, initial.request_id))!;
      const attempt = (yield* attemptRow(attemptId))!;
      yield* decisionStorage(
        sql`SELECT 1 FROM relay_decision_usage_runs WHERE feature_id=${featureId} AND payer_id=${attempt.payer_id} AND run_id=${attempt.run_id} FOR UPDATE`,
      );
      yield* lockControl();
      return { request, attempt };
    });
    const releaseHold = Effect.fn("DecisionUsage.releaseHold")(function* (
      request: UsageRequest<J>,
      status: string,
    ) {
      if (request.hold_tokens > 0)
        yield* decisionStorage(
          sql`UPDATE relay_decision_usage_windows SET reserved_input_tokens=reserved_input_tokens-${request.hold_tokens} WHERE payer_id=${request.payer_id} AND window_start=${request.window_start}`,
        );
      yield* decisionStorage(
        sql`UPDATE relay_decision_usage_requests SET hold_tokens=0,status=${status} WHERE feature_id=${featureId} AND payer_id=${request.payer_id} AND request_id=${request.request_id}`,
      );
    });
    const resolveExposure = Effect.fn("DecisionUsage.resolveExposure")(function* (
      attempt: Attempt,
      cost: number,
    ) {
      yield* decisionStorage(
        sql`UPDATE relay_decision_usage_accounts SET exposure_nano=exposure_nano-${attempt.hold_nano} WHERE payer_id=${attempt.payer_id}`,
      );
      yield* decisionStorage(
        sql`UPDATE relay_decision_usage_control SET exposure_nano=exposure_nano-${attempt.hold_nano} WHERE id=1`,
      );
      yield* decisionStorage(
        sql`UPDATE relay_decision_usage_runs SET spent_nano=spent_nano-${attempt.hold_nano}+${cost} WHERE feature_id=${featureId} AND payer_id=${attempt.payer_id} AND run_id=${attempt.run_id}`,
      );
    });
    const markDispatched = Effect.fn("DecisionUsage.markDispatched")(function* (attemptId: string) {
      return yield* transaction(
        Effect.gen(function* () {
          const { attempt, request } = yield* lockedAttempt(attemptId);
          if (
            attempt.status !== "admitted" ||
            request.active_attempt_id !== attemptId ||
            attempt.deadline <= (yield* nowSeconds)
          )
            return false;
          yield* assertFunding({
            principal: {
              credentialId: request.credential_id,
              environmentId: request.environment_id,
              environmentPublicKey: request.public_key,
            },
            payerId: request.payer_id,
            fundingGeneration: request.funding_generation,
          });
          if (!(yield* access.status(request.payer_id)).eligible)
            return yield* decisionError("forbidden", "Decisions requires an eligible paid account");
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_attempts SET status='dispatched' WHERE id=${attemptId}`,
          );
          return true;
        }),
      );
    });
    const finishFailure = (attemptId: string, beforeDispatch: boolean) =>
      transaction(
        Effect.gen(function* () {
          const { attempt, request } = yield* lockedAttempt(attemptId);
          if (attempt.status === "failed") return;
          if (
            beforeDispatch
              ? attempt.status !== "admitted"
              : !["admitted", "dispatched", "unknown", "expired"].includes(attempt.status)
          )
            return yield* decisionError(
              "conflict",
              "This attempt cannot be released as an uncharged failure",
            );
          yield* resolveExposure(attempt, 0);
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_attempts SET status='failed',cost_nano=0 WHERE id=${attemptId}`,
          );
          if (request.active_attempt_id === attemptId && request.status !== "succeeded")
            yield* releaseHold(request, request.status === "expired" ? "expired" : "failed");
        }),
      );
    const failBeforeDispatch = Effect.fn("DecisionUsage.failBeforeDispatch")((attemptId: string) =>
      finishFailure(attemptId, true),
    );
    const refuse = Effect.fn("DecisionUsage.refuse")((attemptId: string) =>
      finishFailure(attemptId, false),
    );
    const markUnknown = Effect.fn("DecisionUsage.markUnknown")(function* (attemptId: string) {
      yield* transaction(
        Effect.gen(function* () {
          const { attempt, request } = yield* lockedAttempt(attemptId);
          if (attempt.status === "unknown") return;
          if (attempt.status !== "dispatched")
            return yield* decisionError("conflict", "This attempt was not dispatched");
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_attempts SET status='unknown' WHERE id=${attemptId}`,
          );
          if (request.active_attempt_id === attemptId && request.status !== "succeeded")
            yield* decisionStorage(
              sql`UPDATE relay_decision_usage_requests SET status='unknown' WHERE feature_id=${featureId} AND payer_id=${request.payer_id} AND request_id=${request.request_id}`,
            );
        }),
      );
    });
    const settle = Effect.fn("DecisionUsage.settle")(function* (
      attemptId: string,
      input: {
        readonly inputTokens: number;
        readonly judgments: readonly J[];
        readonly qualificationId?: string | undefined;
      },
    ): Effect.fn.Return<
      { kind: "settled"; result: UsageResult<J> } | { kind: "late"; operatorCostNanoUsd: number },
      DecisionEvaluationError
    > {
      if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0)
        return yield* decisionError("invalid", "Invalid Decisions usage");
      return yield* transaction(
        Effect.gen(function* () {
          const { attempt, request } = yield* lockedAttempt(attemptId);
          const qualificationId =
            request.template_version === "decisions-equivalence-v1" &&
            request.backend === "private-evaluator"
              ? (input.qualificationId ?? null)
              : null;
          if (
            qualificationId !== null &&
            (qualificationId.length === 0 ||
              qualificationId.length > 256 ||
              qualificationId.trim() !== qualificationId)
          )
            return yield* decisionError("invalid", "Invalid evaluation qualification");
          if (attempt.status === "succeeded" && request.status === "succeeded") {
            if (
              !request.result_json ||
              !request.result_expires_at ||
              request.result_expires_at <= (yield* nowSeconds)
            )
              return yield* decisionError("expired", "The stored Decisions result expired");
            return {
              kind: "settled" as const,
              result: yield* storedResult(
                request,
                (yield* access.status(request.payer_id)).limitInputTokens,
                true,
              ),
            };
          }
          if (attempt.status === "late")
            return { kind: "late" as const, operatorCostNanoUsd: attempt.cost_nano ?? 0 };
          if (!["dispatched", "unknown", "expired"].includes(attempt.status))
            return yield* decisionError("conflict", "This attempt cannot settle");
          const time = yield* nowSeconds;
          const rawCost = input.inputTokens * attempt.price_nano;
          const cost = Number.isSafeInteger(rawCost) ? rawCost : Number.MAX_SAFE_INTEGER;
          const anomaly =
            input.inputTokens > config.maxActualInputTokens ||
            cost > attempt.hold_nano ||
            !Number.isSafeInteger(rawCost);
          if (anomaly)
            yield* decisionStorage(
              sql`UPDATE relay_decision_usage_control SET anomaly=true WHERE id=1`,
            );
          yield* resolveExposure(attempt, cost);
          const late =
            attempt.status === "expired" ||
            attempt.deadline <= time ||
            request.active_attempt_id !== attemptId ||
            request.status === "succeeded" ||
            request.status === "expired";
          if (late) {
            yield* decisionStorage(
              sql`UPDATE relay_decision_usage_attempts SET status='late',actual_tokens=${input.inputTokens},cost_nano=${cost} WHERE id=${attemptId}`,
            );
            if (
              request.active_attempt_id === attemptId &&
              request.status !== "succeeded" &&
              request.status !== "expired"
            )
              yield* releaseHold(request, "expired");
            return { kind: "late" as const, operatorCostNanoUsd: cost };
          }
          const debit = Math.min(
            input.inputTokens,
            request.hold_tokens,
            config.maxActualInputTokens,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_windows SET reserved_input_tokens=reserved_input_tokens-${request.hold_tokens},used_input_tokens=used_input_tokens+${debit} WHERE payer_id=${request.payer_id} AND window_start=${request.window_start}`,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_requests SET status='succeeded',hold_tokens=0,debited_input_tokens=${debit},result_json=${encodeJson(input.judgments)}::jsonb,qualification_id=${qualificationId},result_expires_at=${time + config.resultRetentionSeconds} WHERE feature_id=${featureId} AND payer_id=${request.payer_id} AND request_id=${request.request_id}`,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_usage_attempts SET status='succeeded',actual_tokens=${input.inputTokens},cost_nano=${cost} WHERE id=${attemptId}`,
          );
          const resultRequest = (yield* requestRow(request.payer_id, request.request_id))!;
          const eligibility = yield* access.status(request.payer_id);
          return {
            kind: "settled" as const,
            result: yield* storedResult(resultRequest, eligibility.limitInputTokens, false),
          };
        }),
      );
    });
    const reconcile = Effect.fn("DecisionUsage.reconcile")(function* (at?: number) {
      const time = at ?? (yield* nowSeconds);
      const rows = yield* decisionStorage(
        sql<{
          id: string;
        }>`SELECT id FROM relay_decision_usage_attempts WHERE feature_id=${featureId} AND status IN ('admitted','dispatched','unknown') AND deadline<=${time} ORDER BY deadline LIMIT 100`,
      );
      for (const row of rows)
        yield* transaction(
          Effect.gen(function* () {
            const { attempt, request } = yield* lockedAttempt(row.id);
            if (
              !["admitted", "dispatched", "unknown"].includes(attempt.status) ||
              attempt.deadline > time
            )
              return;
            if (attempt.status === "admitted") yield* resolveExposure(attempt, 0);
            yield* decisionStorage(
              sql`UPDATE relay_decision_usage_attempts SET status=${attempt.status === "admitted" ? "failed" : "expired"},cost_nano=${attempt.status === "admitted" ? 0 : null} WHERE id=${attempt.id}`,
            );
            if (request.active_attempt_id === attempt.id && request.status !== "succeeded")
              yield* releaseHold(request, "expired");
          }),
        );
      yield* decisionStorage(
        sql`UPDATE relay_decision_usage_requests SET result_json=NULL,qualification_id=NULL WHERE feature_id=${featureId} AND result_expires_at<=${time} AND result_json IS NOT NULL`,
      );
      return rows.length;
    });
    const getSharedAllowance = Effect.fn("ExtensionsUsage.getSharedAllowance")(function* (
      payerId: string,
    ): Effect.fn.Return<ExtensionAllowance, DecisionEvaluationError> {
      const base = yield* getAllowance(payerId);
      const start = Date.parse(base.windowStart) / 1000;
      const rows = yield* decisionStorage(
        sql<{
          feature_id: ExtensionFeatureId;
          used: number;
          reserved: number;
        }>`SELECT feature_id,sum(debited_input_tokens)::float8 AS used,sum(hold_tokens)::float8 AS reserved FROM relay_decision_usage_requests WHERE payer_id=${payerId} AND window_start=${start} GROUP BY feature_id`,
      );
      const descriptor = yield* decisionStorage(
        sql<{
          pool_basis: "subscription" | "grant" | null;
        }>`SELECT pool_basis FROM relay_decision_usage_windows WHERE payer_id=${payerId} AND window_start=${start}`,
      );
      return {
        ...base,
        poolId: `extensions:${(yield* decisionStorage(sql<{ id: string }>`SELECT md5(${payerId} || ':' || ${start}::text) AS id`))[0]!.id}`,
        basis: descriptor[0]?.pool_basis ?? (yield* access.status(payerId)).basis ?? "subscription",
        byFeature: rows.map((row) => ({
          featureId: row.feature_id,
          usedInputTokens: row.used,
          reservedInputTokens: row.reserved,
        })),
      };
    });
    const requestBackend = Effect.fn("ExtensionsUsage.requestBackend")(function* (
      input: Pick<
        DecisionUsageReservation,
        "principal" | "payerId" | "fundingGeneration" | "requestId"
      >,
    ) {
      return yield* transaction(
        Effect.gen(function* () {
          yield* assertFunding(input);
          const request = yield* requestRow(input.payerId, input.requestId);
          if (!request) return null;
          if (
            request.environment_id !== input.principal.environmentId ||
            request.public_key !== input.principal.environmentPublicKey ||
            request.funding_generation !== input.fundingGeneration
          )
            return yield* decisionError(
              "forbidden",
              "Evaluation does not belong to this funding grant",
            );
          return request.backend;
        }),
      );
    });
    const pendingAttempt = Effect.fn("ExtensionsUsage.pendingAttempt")(function* (
      input: Pick<
        DecisionUsageReservation,
        "principal" | "payerId" | "fundingGeneration" | "requestId"
      >,
    ) {
      return yield* transaction(
        Effect.gen(function* () {
          yield* assertFunding(input);
          const request = yield* requestRow(input.payerId, input.requestId);
          if (
            !request ||
            request.environment_id !== input.principal.environmentId ||
            request.public_key !== input.principal.environmentPublicKey ||
            request.funding_generation !== input.fundingGeneration
          )
            return yield* decisionError(
              "forbidden",
              "Evaluation does not belong to this funding grant",
            );
          if (!(yield* access.status(input.payerId)).eligible)
            return yield* decisionError("forbidden", "Extensions access is unavailable");
          return {
            request,
            attempt: request.active_attempt_id
              ? yield* attemptRow(request.active_attempt_id)
              : undefined,
          };
        }),
      );
    });
    const replayLegacy = Effect.fn("ExtensionsUsage.replayLegacy")(function* (
      input: Pick<
        DecisionUsageReservation,
        | "principal"
        | "payerId"
        | "fundingGeneration"
        | "requestId"
        | "runId"
        | "templateVersion"
        | "fingerprint"
      >,
    ) {
      return yield* transaction(
        Effect.gen(function* () {
          yield* assertFunding(input);
          const eligibility = yield* access.status(input.payerId);
          if (!eligibility.eligible)
            return yield* decisionError("forbidden", "Extensions access is unavailable");
          const request = yield* requestRow(input.payerId, input.requestId);
          if (
            !request ||
            request.backend === "private-evaluator" ||
            request.environment_id !== input.principal.environmentId ||
            request.public_key !== input.principal.environmentPublicKey ||
            request.funding_generation !== input.fundingGeneration ||
            request.run_id !== input.runId ||
            request.template_version !== input.templateVersion ||
            request.fingerprint !== input.fingerprint
          )
            return yield* decisionError(
              "conflict",
              "Request identity was already used with different inputs",
            );
          if (request.status !== "succeeded")
            return yield* decisionError(
              "in-progress",
              "This retired evaluation cannot be dispatched again",
            );
          if (
            !request.result_json ||
            !request.result_expires_at ||
            request.result_expires_at <= (yield* nowSeconds)
          )
            return yield* decisionError("expired", "The stored Decisions result expired");
          const result = yield* storedResult(request, eligibility.limitInputTokens, true);
          return { ...result, model: "extensions-v1" };
        }),
      );
    });
    const recoveryAttempts = Effect.fn("ExtensionsUsage.recoveryAttempts")(function* () {
      const time = yield* nowSeconds;
      return yield* decisionStorage(
        sql<Attempt>`WITH due AS (SELECT id FROM relay_decision_usage_attempts WHERE feature_id=${featureId} AND backend='private-evaluator' AND status IN ('dispatched','unknown','expired') AND cost_nano IS NULL AND next_check_at<=${time} ORDER BY next_check_at,id LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE relay_decision_usage_attempts a SET next_check_at=${time + 60} FROM due WHERE a.id=due.id RETURNING a.id,a.payer_id,a.request_id,a.run_id,a.environment_id,a.window_start::float8,a.hold_nano::float8,a.price_nano::float8,a.status,a.deadline::float8,a.actual_tokens::float8,a.cost_nano::float8,a.feature_id,a.backend,a.policy_version,a.request_fingerprint,a.created_at::float8`,
      );
    });
    const health = Effect.gen(function* () {
      const [row] = yield* decisionStorage(sql<{
        exposureNanoUsd: number;
        anomaly: boolean;
        overdueAttempts: number;
        unknownAttempts: number;
      }>`SELECT c.exposure_nano::float8 AS "exposureNanoUsd", c.anomaly,
        (SELECT count(*)::int FROM relay_decision_usage_attempts WHERE status IN ('admitted','dispatched','unknown') AND deadline <= ${yield* nowSeconds}) AS "overdueAttempts",
        (SELECT count(*)::int FROM relay_decision_usage_attempts WHERE status IN ('unknown','expired') AND cost_nano IS NULL) AS "unknownAttempts"
        FROM relay_decision_usage_control c WHERE c.id=1`);
      return row ?? { exposureNanoUsd: 0, anomaly: false, overdueAttempts: 0, unknownAttempts: 0 };
    });
    return {
      getSharedAllowance,
      pendingAttempt,
      replayLegacy,
      requestBackend,
      recoveryAttempts,
      health,
      reserve,
      markDispatched,
      settle,
      failBeforeDispatch,
      refuse,
      markUnknown,
      reconcile,
      getAllowance,
    };
  });
export const makeDecisionUsageStore = (config: DecisionUsageConfig) =>
  makeExtensionsUsageStore<DecisionEvaluationJudgment>(config);
export type DecisionUsageStore = Effect.Success<ReturnType<typeof makeDecisionUsageStore>>;
