import { describe, expect, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { RelayDb } from "../db.ts";
import { makeBillingStore, operationId } from "./BillingStore.ts";
import { makeBillingGrantOperations } from "./BillingGrants.ts";

const url = process.env.BILLING_TEST_DATABASE_URL;
const database = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    return { $client: yield* PgClient.PgClient } as RelayDb["Service"];
  }),
).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(url ?? "postgresql://127.0.0.1/unused") })),
);

describe.skipIf(!url)("audited grants PostgreSQL", () => {
  it.effect(
    "inventories prebilling link-only and allocation-only owners without creating billing accounts",
    () =>
      Effect.gen(function* () {
        const { $client: sql } = yield* RelayDb;
        const ops = yield* makeBillingGrantOperations;
        const suffix = yield* operationId;
        const linkUser = `legacy-${suffix}-link`;
        const allocationUser = `legacy-${suffix}-allocation`;
        yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at)
        VALUES (${linkUser},'legacy-env','key','https://example.test','wss://example.test','external','1970-01-01T00:00:00Z','1970-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO relay_managed_endpoint_allocations(user_id,environment_id,hostname,tunnel_id,tunnel_name,created_at,updated_at)
        VALUES (${allocationUser},'legacy-env',${`${suffix}.example.test`},${suffix},${suffix},'1970-01-01T00:00:00Z','1970-01-01T00:00:00Z')`;
        const rows = yield* ops.inventory(`legacy-${suffix}`, 100);
        expect(rows.find((row) => row.user_id === linkUser)).toMatchObject({
          grant: null,
          deleted_at: null,
          enabled_environments: 0,
        });
        expect(rows.find((row) => row.user_id === allocationUser)).toMatchObject({
          grant: null,
          deleted_at: null,
          enabled_environments: 1,
        });
        expect(
          (yield* sql`SELECT user_id FROM relay_billing_accounts WHERE user_id IN (${linkUser},${allocationUser})`)
            .length,
        ).toBe(0);
      }).pipe(Effect.provide(database)),
  );

  it.effect("atomically fences stale saves, records audit and keeps retries idempotent", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(200_000);
      const store = yield* makeBillingStore;
      const ops = yield* makeBillingGrantOperations;
      const { $client: sql } = yield* RelayDb;
      const user = `grant-${yield* operationId}`;
      const held = yield* store.acquire(user, 200);
      held.state.accessUntil = 400;
      yield* store.save(held, 200);
      const grant = {
        id: `${user}-grant`,
        start: 200,
        end: 300,
        limit: 5,
        reason: "Preserve transition environments",
        operator: "test-operator",
      };
      expect(yield* ops.grant(user, grant)).toEqual({ applied: true });
      expect(yield* ops.grant(user, grant)).toEqual({ applied: false });
      const next = yield* store.load(user);
      expect(next?.state.accessUntil).toBe(400);
      expect(next?.state.grant).toEqual(grant);
      expect(next?.generation).toBeGreaterThan(held.generation);
      expect(next?.lease_token).toBeNull();
      expect((yield* store.save(held, 200).pipe(Effect.result))._tag).toBe("Failure");
      const audits = yield* sql`SELECT id FROM relay_billing_grant_audit WHERE user_id=${user}`;
      expect(audits.length).toBe(1);
      const input = {
        userId: user,
        grantId: grant.id,
        operationId: `${user}-revoke`,
        operator: "test-operator",
        reason: "Owner access removed explicitly",
      };
      expect(yield* ops.revoke(input)).toEqual({ applied: true });
      expect(yield* ops.revoke(input)).toEqual({ applied: false });
      expect((yield* store.load(user))?.state.grant).toBeUndefined();
      expect((yield* store.load(user))?.state.accessUntil).toBe(400);
      // Replaying an old grant cannot resurrect a revoked grant.
      expect(yield* ops.grant(user, grant)).toEqual({ applied: false });
      expect((yield* store.load(user))?.state.grant).toBeUndefined();
    }).pipe(Effect.provide(database)),
  );

  it.effect("rejects tombstoned identities and a stale revoke targeting a replaced grant", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(200_000);
      const store = yield* makeBillingStore;
      const ops = yield* makeBillingGrantOperations;
      const user = `grant-${yield* operationId}`;
      const grant = {
        id: `${user}-first`,
        start: 200,
        end: 300,
        limit: 3,
        reason: "Approved operator test grant",
        operator: "test-operator",
      };
      yield* ops.grant(user, grant);
      yield* ops.grant(user, { ...grant, id: `${user}-second` });
      expect(
        (yield* ops
          .revoke({
            userId: user,
            grantId: grant.id,
            operationId: `${user}-revoke`,
            operator: "test-operator",
            reason: "Stale operator command test",
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* store.tombstone(user, 200, `${user}-deleted`);
      expect(
        (yield* ops.grant(user, { ...grant, id: `${user}-third` }).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(database)),
  );
});
