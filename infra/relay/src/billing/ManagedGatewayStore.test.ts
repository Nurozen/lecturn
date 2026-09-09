import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { operationId } from "./BillingStore.ts";
import { makeManagedGatewayStore, type ManagedGatewayStoreConfig } from "./ManagedGatewayStore.ts";
const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const database = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    return { $client: yield* PgClient.PgClient } as RelayDb["Service"];
  }),
).pipe(
  Layer.provide(
    PgClient.layer({ url: Redacted.make(databaseUrl ?? "postgresql://127.0.0.1/unused") }),
  ),
);
const run = <A, E>(effect: Effect.Effect<A, E, RelayDb>) => effect.pipe(Effect.provide(database));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const userId = `gateway-${yield* operationId}`;
  const config: ManagedGatewayStoreConfig = {
    enabled: true,
    guardVerified: true,
    enforcementUsers: [userId],
    stage: "stripe-sandbox",
    baseDomain: "example.com",
  };
  const mapping = {
    userId,
    environmentId: "env",
    publicHostname: `${userId}-g-stripe-sandbox.example.com`,
    originHostname: `gw-origin-stripe-sandbox-${userId}.example.com`,
  };
  // Keep the single-label gateway hostname inside the DNS 63-character bound.
  mapping.publicHostname = `${userId.slice(-20)}-g-stripe-sandbox.example.com`;
  mapping.originHostname = `gw-origin-stripe-sandbox-${userId.slice(-20)}.example.com`;
  yield* sql`INSERT INTO relay_billing_accounts(user_id,state,updated_at) VALUES (${userId},'{"accessUntil":100,"accessWindowStart":0}',0)`;
  const store = yield* makeManagedGatewayStore(config);
  return { sql, userId, config, mapping, store };
});
describe.skipIf(!databaseUrl)("ManagedGatewayStore PostgreSQL", () => {
  it.effect("only explicitly ready mappings enter finite authoritative snapshots", () =>
    run(
      Effect.gen(function* () {
        const { store, mapping, userId, sql } = yield* fixture;
        const pending = yield* store.registerPending(mapping);
        expect((yield* store.capture(userId)).environments).toEqual([]);
        expect(yield* store.lookupPublicHostname(mapping.publicHostname)).toBeUndefined();
        expect(yield* store.markReady(pending)).toBe(true);
        const active = yield* store.capture(userId);
        expect(active.accessUntilMs).toBe(100000);
        expect(active.environments).toEqual([
          {
            environmentId: mapping.environmentId,
            publicHostname: mapping.publicHostname,
            originHostname: mapping.originHostname,
          },
        ]);
        yield* sql`UPDATE relay_billing_accounts SET deleted_at=1 WHERE user_id=${userId}`;
        expect((yield* store.capture(userId)).accessUntilMs).toBeNull();
      }),
    ),
  );
  it.effect("concurrent captures serialize generations independently of billing leases", () =>
    run(
      Effect.gen(function* () {
        const { store, userId, sql } = yield* fixture;
        const snapshots = yield* Effect.all(
          Array.from({ length: 8 }, () => store.capture(userId)),
          { concurrency: 8 },
        );
        expect(snapshots.map((s) => s.generation).toSorted((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        expect(
          Number(
            (yield* sql<{
              generation: number;
            }>`SELECT generation FROM relay_billing_accounts WHERE user_id=${userId}`)[0]!
              .generation,
          ),
        ).toBe(0);
      }),
    ),
  );
  it.effect(
    "default-off, guard, cohort, expiry and financial suspension deny even with a grant",
    () =>
      run(
        Effect.gen(function* () {
          const { store, userId, sql, config } = yield* fixture;
          const state = {
            accessUntil: 0,
            grant: {
              id: "owner",
              start: 0,
              end: 200,
              limit: 3,
              reason: "Owner complimentary access",
              operator: "test",
            },
          };
          yield* sql`UPDATE relay_billing_accounts SET state=${json(state)}::jsonb WHERE user_id=${userId}`;
          expect((yield* store.capture(userId)).accessUntilMs).toBe(200000);
          for (const override of [
            { enabled: false },
            { guardVerified: false },
            { enforcementUsers: [] },
          ]) {
            const disabled = yield* makeManagedGatewayStore({ ...config, ...override });
            expect((yield* disabled.capture(userId)).accessUntilMs).toBeNull();
          }
          yield* sql`UPDATE relay_billing_accounts SET state=${json({ ...state, suspended: true })}::jsonb WHERE user_id=${userId}`;
          expect((yield* store.capture(userId)).accessUntilMs).toBeNull();
          yield* sql`UPDATE relay_billing_accounts SET state='{"accessUntil":0}'::jsonb WHERE user_id=${userId}`;
          expect((yield* store.capture(userId)).accessUntilMs).toBeNull();
        }),
      ),
  );
  it.effect(
    "legacy hostname enrollment and stale completion/removal cannot expose replacements",
    () =>
      run(
        Effect.gen(function* () {
          const { store, userId, mapping } = yield* fixture;
          expect(
            (yield* Effect.result(
              store.registerPending({ ...mapping, publicHostname: "legacy.example.com" }),
            ))._tag,
          ).toBe("Failure");
          const first = yield* store.registerPending({
            ...mapping,
            originDnsRecordId: "dns-existing",
          });
          const replacement = yield* store.registerPending(mapping);
          expect(replacement.originDnsRecordId).toBe("dns-existing");
          expect(replacement.generation).toBeGreaterThan(first.generation);
          expect(yield* store.markReady(first)).toBe(false);
          expect(
            yield* store.remove(userId, "env", mapping.originHostname, first.generation),
          ).toBeUndefined();
          expect(
            (yield* Effect.result(
              store.registerPending({
                ...mapping,
                originHostname: mapping.originHostname.replace("sandbox-", "sandbox-new-"),
              }),
            ))._tag,
          ).toBe("Failure");
          expect(yield* store.markReady(replacement)).toBe(true);
          yield* store.remove(userId, "env", replacement.originHostname, replacement.generation);
          expect((yield* store.get(userId, "env"))?.deleting).toBe(true);
          expect((yield* Effect.result(store.registerPending(mapping)))._tag).toBe("Failure");
          expect(yield* store.markReady(replacement)).toBe(false);
          expect(
            yield* store.recordOriginDns({ ...replacement, originDnsRecordId: "new-dns" }),
          ).toBe(false);
          expect(
            yield* store.finalizeRemove({ ...replacement, generation: replacement.generation - 1 }),
          ).toBe(false);
          expect(yield* store.finalizeRemove(replacement)).toBe(true);
          const relink = yield* store.registerPending(mapping);
          expect(relink.generation).toBeGreaterThan(replacement.generation);
          expect(yield* store.markReady(replacement)).toBe(false);
          expect((yield* store.capture(userId)).environments).toEqual([]);
        }),
      ),
  );
  it.effect("pausing fences in-flight activation and DNS recording", () =>
    run(
      Effect.gen(function* () {
        const { store, mapping, userId } = yield* fixture;
        const pending = yield* store.registerPending(mapping);
        expect(yield* store.recordOriginDns({ ...pending, originDnsRecordId: "dns-first" })).toBe(
          true,
        );
        expect(yield* store.markReady(pending)).toBe(true);
        const paused = yield* store.pause(pending);
        expect(paused?.generation).toBeGreaterThan(pending.generation);
        expect(yield* store.markReady(pending)).toBe(false);
        expect(
          yield* store.recordOriginDns({ ...pending, originDnsRecordId: "dns-obsolete" }),
        ).toBe(false);
        expect((yield* store.get(userId, "env"))?.originDnsRecordId).toBe("dns-first");
        expect((yield* store.capture(userId)).environments).toEqual([]);
      }),
    ),
  );
  it.effect("late provider checkpoints cannot replace a newer enrollment's allocation", () =>
    run(
      Effect.gen(function* () {
        const { store, mapping, userId, sql } = yield* fixture;
        yield* sql`INSERT INTO relay_managed_endpoint_allocations(user_id,environment_id,hostname,tunnel_name,created_at,updated_at) VALUES (${userId},'env',${mapping.publicHostname},${userId},'initial','initial')`;
        const obsolete = yield* store.registerPending(mapping);
        expect(
          yield* store.checkpointAllocation({
            ...obsolete,
            step: "tunnel",
            tunnelId: "old-tunnel",
          }),
        ).toBe(true);
        const current = yield* store.registerPending(mapping);
        expect(
          yield* store.checkpointAllocation({ ...current, step: "tunnel", tunnelId: "new-tunnel" }),
        ).toBe(true);
        expect(
          yield* store.checkpointAllocation({ ...current, step: "dns", dnsRecordId: "new-dns" }),
        ).toBe(true);
        expect(yield* store.checkpointAllocation({ ...current, step: "ready" })).toBe(true);
        expect(
          yield* store.checkpointAllocation({
            ...obsolete,
            step: "tunnel",
            tunnelId: "late-old-tunnel",
          }),
        ).toBe(false);
        expect(
          yield* store.checkpointAllocation({
            ...obsolete,
            step: "dns",
            dnsRecordId: "late-old-dns",
          }),
        ).toBe(false);
        expect(yield* store.checkpointAllocation({ ...obsolete, step: "ready" })).toBe(false);
        expect(
          (yield* sql`SELECT tunnel_id,dns_record_id,ready_at FROM relay_managed_endpoint_allocations WHERE user_id=${userId}`)[0],
        ).toEqual({
          tunnel_id: "new-tunnel",
          dns_record_id: "new-dns",
          ready_at: "1970-01-01T00:00:00.000Z",
        });
        yield* store.remove(userId, "env", current.originHostname, current.generation);
        expect(
          yield* store.checkpointAllocation({ ...current, step: "tunnel", tunnelId: "deleted" }),
        ).toBe(false);
      }),
    ),
  );
  it.effect(
    "bounded due claims are disjoint and move the cursor past previously selected users",
    () =>
      run(
        Effect.gen(function* () {
          const { store, sql } = yield* fixture;
          // Existing fixtures are included: compare disjoint claims, not arbitrary table order.
          const first = yield* store.claimDue(2);
          const second = yield* store.claimDue(2);
          expect(first.length).toBeLessThanOrEqual(2);
          expect(second.every((id) => !first.includes(id))).toBe(true);
          const third = yield* store.claimDue(100);
          expect(third.every((id) => !first.includes(id) && !second.includes(id))).toBe(true);
          const due = yield* sql<{
            count: string;
          }>`SELECT count(*) FROM relay_managed_gateway_accounts WHERE next_sync_at=0`;
          expect(Number(due[0]!.count)).toBe(0);
        }),
      ),
  );
});
