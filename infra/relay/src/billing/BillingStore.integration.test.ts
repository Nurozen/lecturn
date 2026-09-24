import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { makeBillingStore, operationId, currentPersonalPaidFacts } from "./BillingStore.ts";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const database = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return { $client: sql } as RelayDb["Service"];
  }),
).pipe(
  Layer.provide(
    PgClient.layer({ url: Redacted.make(databaseUrl ?? "postgresql://127.0.0.1/unused") }),
  ),
);

describe.skipIf(!databaseUrl)("BillingStore PostgreSQL", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, RelayDb>) => effect.pipe(Effect.provide(database));
  it.effect("serializes concurrent checkout leases and rejects stale saves after deletion", () =>
    run(
      Effect.gen(function* () {
        const store = yield* makeBillingStore;
        const user = `test-${yield* operationId}`;
        const results = yield* Effect.all(
          [store.acquire(user, 1000), store.acquire(user, 1000)].map(Effect.result),
          { concurrency: "unbounded" },
        );
        expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
        const winner = results.find((r) => r._tag === "Success");
        if (!winner || winner._tag !== "Success") throw new Error("No lease acquired");
        winner.success.state.operation = {
          id: "durable-operation",
          createdAt: 1000,
          interval: "month",
          trialEligible: true,
        };
        yield* store.save(winner.success, 1001);
        yield* store.tombstone(user, 1002, `deletion:${user}`);
        expect((yield* Effect.result(store.save(winner.success, 1003)))._tag).toBe("Failure");
        const persisted = yield* store.load(user);
        expect(Number(persisted?.deleted_at)).toBe(1002);
        expect(persisted?.state.operation?.id).toBe("durable-operation");
        const retry = yield* store.acquire(user, 1003);
        expect(retry.generation).toBeGreaterThan(winner.success.generation);
        yield* store.release(winner.success);
        expect((yield* Effect.result(store.acquire(user, 1003)))._tag).toBe("Failure");
        yield* store.release(retry);
      }),
    ),
  );
  it.effect(
    "deduplicates receipts durably and recovers an expired operation without changing its identity",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* makeBillingStore;
          const user = `test-${yield* operationId}`;
          const first = yield* store.acquire(user, 2000);
          first.state.operation = {
            id: "original",
            createdAt: 2000,
            interval: "year",
            trialEligible: true,
          };
          yield* store.save(first, 2001);
          const resumed = yield* store.acquire(user, 2121);
          expect(resumed.state.operation?.id).toBe("original");
          expect((yield* Effect.result(store.save(first, 2122)))._tag).toBe("Failure");
          const event = {
            id: `stripe:test:${user}`,
            customer_id: null,
            user_id: user,
            kind: "test",
          };
          yield* Effect.all([store.receipt(event, 2000), store.receipt(event, 2000)], {
            concurrency: "unbounded",
          });
          expect((yield* store.pending(100)).filter((row) => row.id === event.id)).toHaveLength(1);
          yield* store.complete(event.id, 2122);
          expect((yield* store.pending(100)).filter((row) => row.id === event.id)).toHaveLength(0);
          yield* store.release(resumed);
        }),
      ),
  );
  it.effect(
    "backs off poison inbox work and failed account refreshes without starving other accounts",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* makeBillingStore;
          const user = `test-${yield* operationId}`;
          const event = {
            id: `stripe:test:${user}`,
            customer_id: null,
            user_id: user,
            kind: "test",
          };
          yield* store.receipt(event, 3000);
          yield* store.attempted(event.id, 3000);
          expect((yield* store.pending(100, 3029)).some((row) => row.id === event.id)).toBe(false);
          expect((yield* store.pending(100, 3030)).some((row) => row.id === event.id)).toBe(true);
          const account = yield* store.acquire(user, 3000);
          yield* store.release(account);
          yield* store.deferReconcile(user, 4000);
          expect((yield* store.stale(4299, 100)).some((row) => row.user_id === user)).toBe(false);
          expect((yield* store.stale(4300, 100)).some((row) => row.user_id === user)).toBe(true);
        }),
      ),
  );
  it.effect("persists paid provenance and clears it durably on account deletion", () =>
    run(
      Effect.gen(function* () {
        const store = yield* makeBillingStore;
        const user = `test-paid-${yield* operationId}`;
        const account = yield* store.acquire(user, 5000);
        account.paid_facts = {
          source: "stripe_personal_subscription",
          subscriptionId: "sub_fixture",
          invoiceId: "in_fixture",
          interval: "year",
          paidPeriodStart: 4900,
          paidPeriodEnd: 500000,
          subscriptionAnniversary: 4900,
          reconciledAt: 5000,
        };
        yield* store.save(account, 5001);
        const loaded = yield* store.load(user);
        expect(loaded?.paid_facts).toEqual(account.paid_facts);
        expect(currentPersonalPaidFacts(loaded, 5002, 300)).toEqual(account.paid_facts);
        expect(currentPersonalPaidFacts(loaded, 5300, 300)).toBeNull();
        const { $client: sql } = yield* RelayDb;
        yield* sql`INSERT INTO relay_decision_funding(environment_id,public_key,generation,payer_id,state) VALUES (${user},'key',1,${user},'active')`;
        yield* sql`INSERT INTO relay_decision_funding_challenges(id,environment_id,public_key,generation,expires_at,payer_id) VALUES (${user},${user},'key',1,9000,${user})`;
        yield* sql`INSERT INTO relay_decision_grants(id,user_id,starts_at,ends_at,monthly_input_tokens,operator,reason) VALUES (${user},${user},4000,9000,1000,'test','fixture')`;
        yield* sql`UPDATE relay_billing_accounts SET decisions_account_label='deleted-sponsor@example.test' WHERE user_id=${user}`;
        yield* store.tombstone(user, 5003, `delete:${user}`);
        const funding = yield* sql<{
          state: string;
          generation: number;
        }>`SELECT state,generation FROM relay_decision_funding WHERE environment_id=${user}`;
        expect(funding[0]).toEqual({ state: "revoked", generation: 2 });
        const challenges = yield* sql<{
          revoked: boolean;
        }>`SELECT revoked FROM relay_decision_funding_challenges WHERE id=${user}`;
        expect(challenges[0]?.revoked).toBe(true);
        const grants = yield* sql<{
          revoked_at: unknown;
        }>`SELECT revoked_at FROM relay_decision_grants WHERE id=${user}`;
        expect(Number(grants[0]?.revoked_at)).toBe(5003);
        const label = yield* sql<{
          decisions_account_label: string | null;
        }>`SELECT decisions_account_label FROM relay_billing_accounts WHERE user_id=${user}`;
        expect(label[0]?.decisions_account_label).toBeNull();
        const deleted = yield* store.load(user);
        expect(deleted?.paid_facts).toBeNull();
        expect((yield* Effect.result(store.save(account, 5004)))._tag).toBe("Failure");
        expect(currentPersonalPaidFacts(deleted, 5004, 300)).toBeNull();
      }),
    ),
  );
});
