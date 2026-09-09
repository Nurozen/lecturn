import { describe, expect, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { RelayDb } from "../db.ts";
import { makeBillingStore, operationId } from "./BillingStore.ts";
import { billingOperationsMigration, makeBillingOperations } from "./BillingOperations.ts";

const url = process.env.BILLING_TEST_DATABASE_URL;
const database = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    return { $client: yield* PgClient.PgClient } as RelayDb["Service"];
  }),
).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(url ?? "postgresql://127.0.0.1/unused") })),
);

describe.skipIf(!url)("billing operations PostgreSQL", () => {
  it.effect("persists confirmed missed deletions and revisits retained accounts fairly", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(100_000);
      const { $client: sql } = yield* RelayDb;
      yield* sql.unsafe(billingOperationsMigration);
      const store = yield* makeBillingStore;
      const user = `identity-${yield* operationId}`;
      const kept = `${user}-kept`;
      for (const id of [user, kept]) {
        const account = yield* store.acquire(id, 100);
        yield* store.release(account);
      }
      const lookedUp: string[] = [];
      const ops = yield* makeBillingOperations({
        store,
        identity: (id) =>
          Effect.sync(() => {
            lookedUp.push(id);
            return id === user ? "missing" : "present";
          }),
      });
      yield* ops.reconcileIdentities(100);
      expect(Number((yield* store.load(user))?.deleted_at)).toBe(100);
      expect((yield* store.load(kept))?.deleted_at).toBeNull();
      expect(
        (yield* sql`SELECT id FROM relay_billing_inbox WHERE id=${`identity-reconcile:${user}`}`)
          .length,
      ).toBe(1);
      const calls = lookedUp.filter((id) => id === user || id === kept).length;
      yield* ops.reconcileIdentities(100);
      expect(lookedUp.filter((id) => id === user || id === kept).length).toBe(calls);
      expect((yield* ops.health()).identity_check_failures).toBe(0);
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "audits replay and bounds retention without removing financial or unresolved receipts",
    () =>
      Effect.gen(function* () {
        const now = 100 * 86400;
        yield* TestClock.setTime(now * 1000);
        const { $client: sql } = yield* RelayDb;
        yield* sql.unsafe(billingOperationsMigration);
        const store = yield* makeBillingStore;
        const id = `retention-${yield* operationId}`;
        const ops = yield* makeBillingOperations({
          store,
          identity: () => Effect.succeed("present"),
        });
        for (const suffix of ["old1", "old2", "financial", "pending"])
          yield* sql`INSERT INTO relay_billing_inbox(id,kind,created_at,processed_at,customer_id)
          VALUES (${`${id}-${suffix}`},'test',0,${suffix === "pending" ? null : 1},${suffix === "financial" ? "cus_financial" : null})`;
        const beforeCount = (yield* sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM relay_billing_inbox`)[0]!.count;
        expect(yield* ops.pruneProcessedInbox()).toEqual({ removed: 0 });
        expect(
          yield* ops.pruneProcessedInbox({
            enabled: true,
            limit: 1,
            reason: "Test bounded cleanup",
          }),
        ).toEqual({ removed: 1 });
        expect(
          (yield* sql<{
            count: number;
          }>`SELECT count(*)::integer AS count FROM relay_billing_inbox`)[0]!.count,
        ).toBe(beforeCount - 1);
        expect(
          (yield* sql`SELECT id FROM relay_billing_inbox WHERE id IN (${`${id}-financial`},${`${id}-pending`})`)
            .length,
        ).toBe(2);
        yield* ops.replay(`${id}-financial`, "Recheck after provider recovery");
        expect(
          (yield* sql<{
            processed_at: number | null;
          }>`SELECT processed_at FROM relay_billing_inbox WHERE id=${`${id}-financial`}`)[0]
            ?.processed_at,
        ).toBeNull();
        expect(
          (yield* sql`SELECT id FROM relay_billing_operator_audit WHERE operation='replay' AND target=${`${id}-financial`}`)
            .length,
        ).toBe(1);
        const before = (yield* sql<{
          epoch: number;
        }>`SELECT epoch FROM relay_billing_enforcement_control WHERE id=1`)[0]!;
        const off = yield* ops.suspensionControl(false, "Test emergency rollback");
        expect(off.enabled).toBe(false);
        expect(off.epoch).toBe(before.epoch + 1);
        expect(
          (yield* sql`SELECT id FROM relay_billing_operator_audit WHERE operation='suspension-control' AND target='off'`)
            .length,
        ).toBeGreaterThan(0);
        const health = yield* ops.health();
        expect(health.quarantined_events).toBeGreaterThanOrEqual(2);
        expect(health.oldest_pending_seconds).toBeGreaterThanOrEqual(now);
        expect(
          (yield* ops
            .pruneProcessedInbox({
              enabled: true,
              retentionDays: 89,
              reason: "Too short retention",
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(database)),
  );
});
