import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { makeBillingStore, operationId } from "./BillingStore.ts";

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
});
