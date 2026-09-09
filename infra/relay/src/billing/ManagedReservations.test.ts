import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { makeBillingStore, operationId } from "./BillingStore.ts";
import { make } from "./ManagedReservations.ts";

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
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const testAccount = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const userId = `reservation-${yield* operationId}`;
  yield* sql`INSERT INTO relay_billing_accounts(user_id,generation,state,updated_at) VALUES (${userId},1,${encodeJson({ accessUntil: 1000 })}::jsonb,0)`;
  const reservations = yield* make({ enabled: true });
  return { sql, userId, reservations };
});
const run = <A, E>(effect: Effect.Effect<A, E, RelayDb>) => effect.pipe(Effect.provide(database));

it.effect("disabled reservations never request a database service", () =>
  Effect.gen(function* () {
    const reservations = yield* make({ enabled: false });
    expect(yield* reservations.reserve({ userId: "user", environmentId: "env" })).toBeNull();
    expect(yield* reservations.complete(null)).toBe(true);
    expect(yield* reservations.release({ userId: "user", environmentId: "env" })).toBe(true);
  }).pipe(Effect.provideService(RelayDb, {} as RelayDb["Service"])),
);

describe.skipIf(!databaseUrl)("ManagedReservations PostgreSQL", () => {
  it.effect("permits exactly one of two different environments racing for the last slot", () =>
    run(
      Effect.gen(function* () {
        const { userId, reservations } = yield* testAccount;
        yield* reservations.reserve({ userId, environmentId: "first" });
        yield* reservations.reserve({ userId, environmentId: "second" });
        const results = yield* Effect.all(
          ["third", "fourth"].map((environmentId) =>
            reservations.reserve({ userId, environmentId }).pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        const failure = results.find((result) => result._tag === "Failure");
        expect(failure?._tag === "Failure" && failure.failure.code).toBe("quota");
        const billing = yield* makeBillingStore;
        expect(yield* billing.quotaUsed(userId)).toBe(3);
      }),
    ),
  );
  it.effect(
    "reuses one capacity slot while fencing concurrent attempts for the same environment",
    () =>
      run(
        Effect.gen(function* () {
          const { userId, reservations } = yield* testAccount;
          const results = yield* Effect.all(
            [1, 2].map(() => reservations.reserve({ userId, environmentId: "same" })),
            { concurrency: "unbounded" },
          );
          expect(results[0]!.generation).not.toBe(results[1]!.generation);
          const oldest =
            results[0]!.generation < results[1]!.generation ? results[0]! : results[1]!;
          const newest =
            results[0]!.generation > results[1]!.generation ? results[0]! : results[1]!;
          expect(yield* reservations.complete(oldest)).toBe(false);
          expect(yield* reservations.complete(newest)).toBe(true);
          const billing = yield* makeBillingStore;
          expect(yield* billing.quotaUsed(userId)).toBe(1);
          yield* reservations.reserve({ userId, environmentId: "second" });
          yield* reservations.reserve({ userId, environmentId: "third" });
          const retry = yield* reservations.reserve({ userId, environmentId: "same" });
          expect(retry!.generation).toBeGreaterThan(newest.generation);
          expect(yield* billing.quotaUsed(userId)).toBe(3);
        }),
      ),
  );
  it.effect(
    "retains pending/offline capacity until explicit release and fences old completion",
    () =>
      run(
        Effect.gen(function* () {
          const { userId, reservations } = yield* testAccount;
          const old = yield* reservations.reserve({ userId, environmentId: "host" });
          expect(old).not.toBeNull();
          expect(yield* reservations.get({ userId, environmentId: "host" })).toEqual(old);
          yield* reservations.release({ userId, environmentId: "host" });
          yield* reservations.release({ userId, environmentId: "host" });
          const next = yield* reservations.reserve({ userId, environmentId: "host" });
          expect(next!.generation).toBeGreaterThan(old!.generation);
          expect(yield* reservations.complete(old)).toBe(false);
          expect(
            yield* reservations.release({
              userId,
              environmentId: "host",
              generation: old!.generation,
            }),
          ).toBe(false);
          expect(yield* reservations.complete(next)).toBe(true);
        }),
      ),
  );
  it.effect(
    "rejects completion after entitlement generation changes and lets a fresh retry recover",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, userId, reservations } = yield* testAccount;
          const old = yield* reservations.reserve({ userId, environmentId: "host" });
          yield* sql`UPDATE relay_billing_accounts SET generation=generation+1 WHERE user_id=${userId}`;
          expect(yield* reservations.complete(old)).toBe(false);
          const fresh = yield* reservations.reserve({ userId, environmentId: "host" });
          expect(fresh!.accountGeneration).toBe(2);
          expect(fresh!.generation).toBeGreaterThan(old!.generation);
          expect(yield* reservations.complete(fresh)).toBe(true);
        }),
      ),
  );
  it.effect("rejects new reservations and completion after expiry or deletion", () =>
    run(
      Effect.gen(function* () {
        const { sql, userId, reservations } = yield* testAccount;
        const pending = yield* reservations.reserve({ userId, environmentId: "host" });
        yield* sql`UPDATE relay_billing_accounts SET state=${encodeJson({ accessUntil: 0 })}::jsonb WHERE user_id=${userId}`;
        expect(yield* reservations.complete(pending)).toBe(false);
        expect(
          (yield* Effect.flip(reservations.reserve({ userId, environmentId: "next" }))).code,
        ).toBe("subscription_required");
        yield* sql`UPDATE relay_billing_accounts SET state=${encodeJson({ accessUntil: 1000 })}::jsonb,deleted_at=1 WHERE user_id=${userId}`;
        expect(yield* reservations.complete(pending)).toBe(false);
        expect(
          (yield* Effect.flip(reservations.reserve({ userId, environmentId: "next" }))).code,
        ).toBe("subscription_required");
      }),
    ),
  );
  it.effect("counts existing allocations so migration cannot grant three additional slots", () =>
    run(
      Effect.gen(function* () {
        const { sql, userId, reservations } = yield* testAccount;
        for (const environmentId of ["legacy1", "legacy2", "legacy3"])
          yield* sql`INSERT INTO relay_managed_endpoint_allocations(user_id,environment_id,hostname,tunnel_name,created_at,updated_at) VALUES (${userId},${environmentId},${`${userId}-${environmentId}.example`},${`${userId}-${environmentId}`},'test','test')`;
        expect(
          (yield* Effect.flip(reservations.reserve({ userId, environmentId: "extra" }))).code,
        ).toBe("quota");
        // Adopting an existing allocation takes its slot instead of double-counting it.
        yield* reservations.reserve({ userId, environmentId: "legacy1" });
        const billing = yield* makeBillingStore;
        expect(yield* billing.quotaUsed(userId)).toBe(3);
        yield* reservations.release({ userId, environmentId: "legacy2" });
        yield* reservations.reserve({ userId, environmentId: "replacement" });
        expect(yield* billing.quotaUsed(userId)).toBe(3);
      }),
    ),
  );
  it.effect("reports stale or future entitlement projections as unavailable", () =>
    run(
      Effect.gen(function* () {
        const { sql, userId, reservations } = yield* testAccount;
        for (const timestamp of [-900, 1]) {
          yield* sql`UPDATE relay_billing_accounts SET updated_at=${timestamp} WHERE user_id=${userId}`;
          expect(
            (yield* Effect.flip(reservations.reserve({ userId, environmentId: "host" }))).code,
          ).toBe("unavailable");
        }
      }),
    ),
  );
  it.effect(
    "a reservation captured before a new provisioning attempt cannot release its slot",
    () =>
      run(
        Effect.gen(function* () {
          const { userId, reservations } = yield* testAccount;
          yield* reservations.reserve({ userId, environmentId: "host" });
          const captured = yield* reservations.get({ userId, environmentId: "host" });
          const retry = yield* reservations.reserve({ userId, environmentId: "host" });
          expect(
            yield* reservations.release({
              userId,
              environmentId: "host",
              generation: captured!.generation,
            }),
          ).toBe(false);
          expect(yield* reservations.complete(captured)).toBe(false);
          expect(yield* reservations.complete(retry)).toBe(true);
          const billing = yield* makeBillingStore;
          expect(yield* billing.quotaUsed(userId)).toBe(1);
        }),
      ),
  );
});
