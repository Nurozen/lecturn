import * as NodeCrypto from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { Clock, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { RelayDb } from "../db.ts";
import {
  decisionUsageDefaults,
  makeDecisionUsageStore,
  type DecisionUsageConfig,
  type DecisionUsageReservation,
} from "./DecisionUsageStore.ts";

const url = process.env.BILLING_TEST_DATABASE_URL;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const baseTime = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-23T12:00:00Z"));
const database = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    return { $client: yield* PgClient.PgClient } as RelayDb["Service"];
  }),
).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(url ?? "postgresql://127.0.0.1/unused") })),
);
const config: DecisionUsageConfig = {
  ...decisionUsageDefaults,
  enabled: true,
  billingMaxAgeSeconds: 600,
  monthlyInputTokens: 10_000_000,
};
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(baseTime);
    return yield* effect;
  }).pipe(Effect.provide(database));
const fixture = Effect.fn("usageTest.fixture")(function* (
  overrides: Partial<DecisionUsageConfig> = {},
) {
  const { $client: sql } = yield* RelayDb;
  const id = NodeCrypto.randomUUID(),
    payerId = `usage-payer-${id}`;
  const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const facts = {
    source: "stripe_personal_subscription",
    subscriptionId: "sub_test",
    invoiceId: "in_test",
    interval: "year",
    paidPeriodStart: time - 100,
    paidPeriodEnd: time + 86400 * 366,
    subscriptionAnniversary: time,
    reconciledAt: time,
  };
  yield* sql`INSERT INTO relay_billing_accounts(user_id,updated_at,paid_facts) VALUES (${payerId},${time},${encodeJson(facts)}::jsonb)`;
  const makeHost = Effect.fn("usageTest.host")(function* (suffix: string) {
    const host = {
      credentialId: `usage-cred-${id}-${suffix}`,
      environmentId: `usage-env-${id}-${suffix}`,
      environmentPublicKey: `usage-key-${id}-${suffix}`,
    };
    yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES (${host.credentialId},${host.environmentId},${host.environmentPublicKey},${host.credentialId},'2026-01-01','2026-01-01')`;
    yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${payerId},${host.environmentId},${host.environmentPublicKey},'https://test.invalid','wss://test.invalid','direct','2026-01-01','2026-01-01')`;
    yield* sql`INSERT INTO relay_decision_funding(environment_id,public_key,generation,payer_id,state) VALUES (${host.environmentId},${host.environmentPublicKey},1,${payerId},'active')`;
    return host;
  });
  const principal = yield* makeHost("a");
  const input: DecisionUsageReservation = {
    principal,
    payerId,
    fundingGeneration: 1,
    requestId: `request-${id}`,
    runId: `run-${id}`,
    fingerprint: "fixture-hash",
    templateVersion: "v1",
    model: "jev-1.13.0",
  };
  return {
    sql,
    id,
    payerId,
    time,
    facts,
    makeHost,
    input,
    store: yield* makeDecisionUsageStore({ ...config, ...overrides }),
  };
});
const judgment = [{ targetId: "target-1", exists: "yes", relevant: "yes" }] as const;
const admitted = Effect.fn("usageTest.admitted")(function* (
  store: Effect.Success<ReturnType<typeof makeDecisionUsageStore>>,
  input: DecisionUsageReservation,
) {
  const result = yield* store.reserve(input);
  expect(result.kind).toBe("admitted");
  if (result.kind !== "admitted") throw new Error("Expected admission");
  return result;
});

describe.skipIf(!url)("Decisions usage PostgreSQL", () => {
  it.effect(
    "materializes one window concurrently, dispatches once, debits once and replays content-free judgments",
    () =>
      run(
        Effect.gen(function* () {
          const { store, input, sql, payerId } = yield* fixture();
          const results = yield* Effect.all([store.reserve(input), store.reserve(input)], {
            concurrency: 2,
          });
          expect(results.map((x) => x.kind).toSorted()).toEqual(["admitted", "in-progress"]);
          const first = results.find((x) => x.kind === "admitted");
          if (!first || first.kind !== "admitted") throw new Error("Missing admission");
          expect(first.allowance.reservedInputTokens).toBe(238096);
          expect(yield* store.markDispatched(first.attemptId)).toBe(true);
          expect(yield* store.markDispatched(first.attemptId)).toBe(false);
          const settled = yield* store.settle(first.attemptId, {
            inputTokens: 123,
            judgments: judgment,
          });
          expect(settled.kind).toBe("settled");
          expect((yield* store.getAllowance(payerId)).usedInputTokens).toBe(123);
          yield* store.settle(first.attemptId, { inputTokens: 123, judgments: judgment });
          const replay = yield* store.reserve(input);
          expect(replay.kind).toBe("replay");
          if (replay.kind === "replay")
            expect(replay.result).toMatchObject({
              inputTokens: 123,
              replayed: true,
              judgments: judgment,
              allowance: { reservedInputTokens: 0, usedInputTokens: 123 },
            });
          expect(
            (yield* Effect.flip(store.reserve({ ...input, fingerprint: "different" }))).code,
          ).toBe("conflict");
          expect(
            yield* sql`SELECT * FROM relay_decision_usage_windows WHERE payer_id=${payerId}`,
          ).toHaveLength(1);
          const requests = yield* sql<{
            result_json: unknown;
          }>`SELECT result_json FROM relay_decision_usage_requests WHERE payer_id=${payerId}`;
          expect(requests[0]?.result_json).toEqual(judgment);
        }),
      ),
  );
  it.effect(
    "shares allowance across simultaneous environments and fences revoked funding before dispatch",
    () =>
      run(
        Effect.gen(function* () {
          const { store, input, payerId, makeHost, sql } = yield* fixture({
            attemptHoldNanoUsd: 42000,
            monthlyInputTokens: 1500,
          });
          const other = yield* makeHost("b");
          const requests = [
            input,
            { ...input, principal: other, requestId: `${input.requestId}-b` },
          ];
          const results = yield* Effect.all(
            requests.map((x) => Effect.result(store.reserve(x))),
            { concurrency: 2 },
          );
          expect(results.filter((x) => x._tag === "Success")).toHaveLength(1);
          const failed = results.find((x) => x._tag === "Failure");
          expect(failed?._tag === "Failure" ? failed.failure.code : null).toBe(
            "allowance-exhausted",
          );
          expect((yield* store.getAllowance(payerId)).reservedInputTokens).toBe(1000);
          const succeeded = results.find((x) => x._tag === "Success");
          if (!succeeded || succeeded._tag !== "Success" || succeeded.success.kind !== "admitted")
            throw new Error("Missing admission");
          yield* sql`UPDATE relay_decision_funding SET generation=generation+1,state='revoked',payer_id=NULL WHERE payer_id=${payerId}`;
          expect((yield* Effect.flip(store.markDispatched(succeeded.success.attemptId))).code).toBe(
            "forbidden",
          );
          yield* store.failBeforeDispatch(succeeded.success.attemptId);
          expect((yield* store.getAllowance(payerId)).reservedInputTokens).toBe(0);
          expect(
            (yield* Effect.flip(store.reserve({ ...input, requestId: `${input.requestId}-new` })))
              .code,
          ).toBe("forbidden");
        }),
      ),
  );
  it.effect(
    "allows only an explicit bounded retry and treats superseded success as operator cost",
    () =>
      run(
        Effect.gen(function* () {
          const { store, input, payerId, sql } = yield* fixture();
          const first = yield* admitted(store, input);
          yield* store.markDispatched(first.attemptId);
          yield* store.markUnknown(first.attemptId);
          expect((yield* store.reserve(input)).kind).toBe("in-progress");
          const retry = yield* admitted(store, { ...input, explicitRetry: true });
          expect(retry.allowance.reservedInputTokens).toBe(238096);
          yield* store.markDispatched(retry.attemptId);
          expect(
            yield* store.settle(first.attemptId, { inputTokens: 50, judgments: judgment }),
          ).toEqual({ kind: "late", operatorCostNanoUsd: 2100 });
          yield* store.settle(retry.attemptId, { inputTokens: 123, judgments: judgment });
          yield* store.settle(first.attemptId, { inputTokens: 50, judgments: judgment });
          expect((yield* store.getAllowance(payerId)).usedInputTokens).toBe(123);
          const rows = yield* sql<{
            spent: number;
            count: number;
          }>`SELECT spent_nano::float8 AS spent,attempt_count AS count FROM relay_decision_usage_runs WHERE payer_id=${payerId}`;
          expect(rows[0]).toEqual({ spent: 7266, count: 2 });
        }),
      ),
  );
  it.effect(
    "releases timeout allowance while retaining bounded unknown exposure and records late success without debit",
    () =>
      run(
        Effect.gen(function* () {
          const { store, input, payerId, sql } = yield* fixture({
            accountExposureNanoUsd: 10_000_000,
          });
          const first = yield* admitted(store, input);
          yield* store.markDispatched(first.attemptId);
          const beforeUnknown = yield* store.health;
          yield* store.markUnknown(first.attemptId);
          expect((yield* store.health).unknownAttempts).toBe(beforeUnknown.unknownAttempts + 1);
          yield* TestClock.adjust("121 seconds");
          expect((yield* store.health).overdueAttempts).toBeGreaterThanOrEqual(1);
          yield* store.reconcile();
          yield* store.reconcile();
          const afterTimeout = yield* store.health;
          expect(afterTimeout.overdueAttempts).toBe(0);
          expect(afterTimeout.unknownAttempts).toBeGreaterThanOrEqual(
            beforeUnknown.unknownAttempts + 1,
          );
          expect(afterTimeout.exposureNanoUsd).toBeGreaterThanOrEqual(10_000_000);
          expect((yield* store.getAllowance(payerId)).reservedInputTokens).toBe(0);
          const account = yield* sql<{
            exposure: number;
          }>`SELECT exposure_nano::float8 AS exposure FROM relay_decision_usage_accounts WHERE payer_id=${payerId}`;
          expect(account[0]?.exposure).toBe(10_000_000);
          expect((yield* Effect.flip(store.reserve(input))).code).toBe("expired");
          const fresh = { ...input, requestId: `${input.requestId}-new` };
          expect((yield* Effect.flip(store.reserve(fresh))).code).toBe("unavailable");
          expect(
            (yield* store.settle(first.attemptId, { inputTokens: 200, judgments: judgment })).kind,
          ).toBe("late");
          expect((yield* store.getAllowance(payerId)).usedInputTokens).toBe(0);
          expect((yield* store.health).unknownAttempts).toBe(afterTimeout.unknownAttempts - 1);
          const next = yield* admitted(store, fresh);
          yield* store.failBeforeDispatch(next.attemptId);
        }),
      ),
  );
  it.effect("settles in the reserved window when a monthly allowance renews", () =>
    run(
      Effect.gen(function* () {
        const { store, input, payerId, sql, facts, time } = yield* fixture();
        const before = time + 30 * 86400 - 30;
        yield* TestClock.setTime(before * 1000);
        yield* sql`UPDATE relay_billing_accounts SET paid_facts=${encodeJson({ ...facts, reconciledAt: before })}::jsonb WHERE user_id=${payerId}`;
        const first = yield* admitted(store, input);
        yield* store.markDispatched(first.attemptId);
        yield* TestClock.adjust("60 seconds");
        expect((yield* store.getAllowance(payerId)).usedInputTokens).toBe(0);
        const result = yield* store.settle(first.attemptId, {
          inputTokens: 100,
          judgments: judgment,
        });
        if (result.kind !== "settled") throw new Error("Expected settlement");
        expect(result.result.allowance.windowStart).toBe(
          DateTime.formatIso(DateTime.makeUnsafe(time * 1000)),
        );
        expect(result.result.allowance.usedInputTokens).toBe(100);
        expect((yield* store.getAllowance(payerId)).usedInputTokens).toBe(0);
      }),
    ),
  );
  it.effect("keeps request tombstones after result expiry without rebilling", () =>
    run(
      Effect.gen(function* () {
        const { store, input, payerId, sql } = yield* fixture({
          resultRetentionSeconds: 3,
          maxAttemptsPerRun: 2,
        });
        const first = yield* admitted(store, input);
        yield* store.markDispatched(first.attemptId);
        yield* store.settle(first.attemptId, { inputTokens: 100, judgments: judgment });
        yield* TestClock.adjust("4 seconds");
        yield* store.reconcile();
        expect((yield* Effect.flip(store.reserve(input))).code).toBe("expired");
        expect(
          yield* Effect.flip(
            store.settle(first.attemptId, { inputTokens: 100, judgments: judgment }),
          ),
        ).toMatchObject({ code: "expired" });
        const rows = yield* sql<{
          result_json: unknown;
          attempt_count: number;
        }>`SELECT result_json,attempt_count FROM relay_decision_usage_requests WHERE payer_id=${payerId}`;
        expect(rows[0]).toEqual({ result_json: null, attempt_count: 1 });
        expect((yield* store.getAllowance(payerId)).usedInputTokens).toBe(100);
        expect((yield* Effect.flip(store.reserve({ ...input, explicitRetry: true }))).code).toBe(
          "expired",
        );
        // Explicit recovery is new work with a persisted new identity on the same
        // durable run. The old paid attempt remains tombstoned and is never debited again.
        const replacement = yield* admitted(store, {
          ...input,
          requestId: `${input.requestId}-explicit-recovery`,
          explicitRetry: true,
        });
        yield* store.markDispatched(replacement.attemptId);
        yield* store.settle(replacement.attemptId, { inputTokens: 50, judgments: judgment });
        yield* store.settle(replacement.attemptId, { inputTokens: 50, judgments: judgment });
        expect((yield* store.getAllowance(payerId)).usedInputTokens).toBe(150);
        const durableRun = yield* sql<{
          attempt_count: number;
          spent_nano: number;
        }>`SELECT attempt_count,spent_nano::float8 FROM relay_decision_usage_runs WHERE payer_id=${payerId} AND run_id=${input.runId}`;
        expect(durableRun[0]).toEqual({ attempt_count: 2, spent_nano: 150 * 42 });
        expect(
          (yield* Effect.flip(
            store.reserve({ ...input, requestId: `${input.requestId}-third`, explicitRetry: true }),
          )).code,
        ).toBe("run-budget-exhausted");
      }),
    ),
  );
  it.effect("preserves durable attempt and spending limits across failures and runs", () =>
    run(
      Effect.gen(function* () {
        const { store, input } = yield* fixture({ maxAttemptsPerRun: 2 });
        const first = yield* admitted(store, input);
        yield* store.failBeforeDispatch(first.attemptId);
        const second = yield* admitted(store, { ...input, explicitRetry: true });
        yield* store.failBeforeDispatch(second.attemptId);
        expect((yield* Effect.flip(store.reserve({ ...input, explicitRetry: true }))).code).toBe(
          "run-budget-exhausted",
        );
        expect(
          (yield* Effect.flip(store.reserve({ ...input, requestId: `${input.requestId}-new` })))
            .code,
        ).toBe("run-budget-exhausted");
        const changed = yield* admitted(store, {
          ...input,
          runId: `${input.runId}-different`,
          requestId: `${input.requestId}-different`,
        });
        yield* store.failBeforeDispatch(changed.attemptId);
        const budget = yield* makeDecisionUsageStore({ ...config, runBudgetNanoUsd: 9_999_999 });
        expect(
          (yield* Effect.flip(
            budget.reserve({
              ...input,
              requestId: `input.requestId-budget`,
              runId: `${input.runId}-budget`,
            }),
          )).code,
        ).toBe("run-budget-exhausted");
      }),
    ),
  );
  it.effect("continues reconciliation with admission disabled", () =>
    run(
      Effect.gen(function* () {
        const { store, input, payerId } = yield* fixture();
        yield* admitted(store, input);
        const disabled = yield* makeDecisionUsageStore({ ...config, enabled: false });
        expect(
          (yield* Effect.flip(disabled.reserve({ ...input, requestId: `${input.requestId}-new` })))
            .code,
        ).toBe("forbidden");
        yield* TestClock.adjust("121 seconds");
        yield* disabled.reconcile();
        expect((yield* store.getAllowance(payerId)).reservedInputTokens).toBe(0);
      }),
    ),
  );
  it.effect("caps anomalous user debit and pauses admission for operator review", () =>
    run(
      Effect.gen(function* () {
        const { store, input, payerId, sql } = yield* fixture({ maxActualInputTokens: 64000 });
        yield* Effect.gen(function* () {
          const first = yield* admitted(store, input);
          yield* store.markDispatched(first.attemptId);
          yield* store.settle(first.attemptId, { inputTokens: 65000, judgments: judgment });
          expect((yield* store.getAllowance(payerId)).usedInputTokens).toBe(64000);
          expect((yield* store.health).anomaly).toBe(true);
          const recorded = yield* sql<{
            actual_tokens: number;
            cost_nano: number;
          }>`SELECT actual_tokens::float8,cost_nano::float8 FROM relay_decision_usage_attempts WHERE id=${first.attemptId}`;
          expect(recorded[0]).toEqual({ actual_tokens: 65000, cost_nano: 65000 * 42 });
          expect(
            (yield* Effect.flip(store.reserve({ ...input, requestId: `${input.requestId}-new` })))
              .code,
          ).toBe("unavailable");
        }).pipe(
          Effect.ensuring(
            sql`UPDATE relay_decision_usage_control SET anomaly=false WHERE id=1`.pipe(
              Effect.orDie,
            ),
          ),
        );
      }),
    ),
  );
  it.effect("serializes global exposure admission across different paying accounts", () =>
    run(
      Effect.gen(function* () {
        const first = yield* fixture(),
          second = yield* fixture();
        const current = yield* first.sql<{
          exposure: number;
        }>`SELECT exposure_nano::float8 AS exposure FROM relay_decision_usage_control WHERE id=1`;
        const capped = yield* makeDecisionUsageStore({
          ...config,
          globalExposureNanoUsd: current[0]!.exposure + 10_000_000,
        });
        const results = yield* Effect.all(
          [first.input, second.input].map((input) => Effect.result(capped.reserve(input))),
          { concurrency: 2 },
        );
        expect(results.filter((x) => x._tag === "Success")).toHaveLength(1);
        const failed = results.find((x) => x._tag === "Failure");
        expect(failed?._tag === "Failure" ? failed.failure.code : null).toBe("unavailable");
        for (const result of results)
          if (result._tag === "Success" && result.success.kind === "admitted")
            yield* capped.failBeforeDispatch(result.success.attemptId);
      }),
    ),
  );
  it.effect("enforces per-account concurrency and a durable per-minute admission limit", () =>
    run(
      Effect.gen(function* () {
        const { store, input, makeHost } = yield* fixture({
          accountConcurrency: 1,
          requestsPerMinute: 1,
        });
        const first = yield* admitted(store, input);
        const principal = yield* makeHost("second");
        const next = { ...input, principal, requestId: `${input.requestId}-next` };
        expect((yield* Effect.flip(store.reserve(next))).code).toBe("rate-limited");
        yield* store.failBeforeDispatch(first.attemptId);
        expect((yield* Effect.flip(store.reserve(next))).code).toBe("rate-limited");
        yield* TestClock.adjust("61 seconds");
        const second = yield* admitted(store, next);
        yield* store.failBeforeDispatch(second.attemptId);
      }),
    ),
  );
});
