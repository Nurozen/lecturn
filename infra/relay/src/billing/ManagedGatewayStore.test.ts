import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Schema } from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Allocations from "../environments/ManagedEndpointAllocations.ts";
import * as Provider from "../environments/ManagedEndpointProvider.ts";
import { ManagedGatewayEnrollment } from "../environments/ManagedGatewayEnrollment.ts";
import { ManagedTunnelLimits } from "../environments/ManagedTunnelLimits.ts";
import { RelayConfiguration } from "../Config.ts";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { operationId } from "./BillingStore.ts";
import * as ManagedAccess from "./ManagedAccess.ts";
import * as ManagedReservations from "./ManagedReservations.ts";
import { makeManagedGatewayStore, type ManagedGatewayStoreConfig } from "./ManagedGatewayStore.ts";
const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const database = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
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
const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 };
const allocationFixture = Effect.gen(function* () {
  const setup = yield* fixture;
  const { sql, userId, mapping, store } = setup;
  yield* sql`INSERT INTO relay_managed_endpoint_allocations(user_id,environment_id,hostname,tunnel_name,created_at,updated_at) VALUES (${userId},'env',${mapping.publicHostname},${userId},'initial','initial')`;
  yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${userId},'env','environment-key',${`https://${mapping.publicHostname}/`},${`wss://${mapping.publicHostname}/ws`},'cloudflare_tunnel','initial','initial')`;
  const allocations = yield* Allocations.make;
  const pending = yield* store.registerPending(mapping);
  const provision = (generation: number, tunnelId: string) =>
    Effect.gen(function* () {
      expect(
        yield* store.checkpointAllocation({ ...mapping, generation, step: "tunnel", tunnelId }),
      ).toBe(true);
      expect(
        yield* store.checkpointAllocation({
          ...mapping,
          generation,
          step: "dns",
          tunnelId,
          dnsRecordId: "dns-current",
        }),
      ).toBe(true);
      expect(
        yield* store.checkpointAllocation({
          ...mapping,
          generation,
          step: "ready",
          tunnelId,
          origin,
        }),
      ).toBe(true);
    });
  return { ...setup, allocations, pending, provision };
});

// Only Cloudflare I/O and the gateway snapshot transport are simulated. Provider
// operations use the same PostgreSQL gateway and allocation stores as the Worker.
const providerFixture = Effect.gen(function* () {
  const setup = yield* fixture;
  const { store, config, userId } = setup;
  const allocations = yield* Allocations.make;
  const input = { userId, environmentId: "provider-env", origin };
  const hooks: {
    sync: Effect.Effect<void>;
    ensureCapacity: Effect.Effect<void>;
    deleteDns: Effect.Effect<void, Provider.ManagedEndpointDnsClientError>;
    getToken: Effect.Effect<string, Provider.ManagedEndpointTunnelClientError>;
  } = {
    sync: Effect.void,
    ensureCapacity: Effect.void,
    deleteDns: Effect.void,
    getToken: Effect.succeed("connector-token"),
  };
  const events: string[] = [];
  const tunnels = new Map<string, { id: string; name: string }>();
  const records = new Map<
    string,
    { id: string; name: string; type: string; content: string; proxied: boolean }
  >();
  let nextTunnel = 0;
  let nextRecord = 0;
  const unavailable = () =>
    new ManagedAccess.ManagedAccessUnavailable({ message: "Gateway unavailable" });
  const available = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(unavailable));
  const mappingFor = (owner: string, environmentId: string) =>
    available(store.get(owner, environmentId)).pipe(
      Effect.map((mapping) =>
        mapping ? { ...mapping, originDnsRecordId: mapping.originDnsRecordId ?? null } : null,
      ),
    );
  const gateway = ManagedGatewayEnrollment.of({
    enabledFor: () => Effect.succeed(true),
    get: ({ userId, environmentId }) => mappingFor(userId, environmentId),
    registerPending: (input) =>
      available(store.registerPending(input)).pipe(
        Effect.map((mapping) => ({
          ...mapping,
          originDnsRecordId: mapping.originDnsRecordId ?? null,
        })),
      ),
    checkpointAllocation: (input) => available(store.checkpointAllocation(input)),
    withAllocation: (input, effect) =>
      store.withAllocation(input, effect).pipe(Effect.catchTag("BillingError", unavailable)),
    recordOriginDns: (input) => available(store.recordOriginDns(input)),
    markReady: (input) =>
      Effect.gen(function* () {
        const mapping = yield* mappingFor(input.userId, input.environmentId);
        if (!mapping || mapping.deleting || mapping.generation !== input.generation) return false;
        return yield* available(store.markReady(mapping));
      }),
    pause: (input) =>
      available(store.pause(input)).pipe(Effect.map((mapping) => mapping !== undefined)),
    remove: (input) =>
      Effect.gen(function* () {
        const mapping = yield* mappingFor(input.userId, input.environmentId);
        if (!mapping || mapping.generation !== input.generation) return false;
        return (
          (yield* available(
            store.remove(
              input.userId,
              input.environmentId,
              mapping.originHostname,
              input.generation,
            ),
          )) !== undefined
        );
      }),
    finalizeRemove: (input) => available(store.finalizeRemove(input)),
    sync: () => Effect.suspend(() => hooks.sync),
  });
  const provider = yield* Provider.make.pipe(
    Effect.provideService(RelayConfiguration, {
      relayIssuer: "https://relay.example.test",
      apns: {
        environment: "sandbox",
        teamId: "team",
        keyId: "key",
        privateKey: Redacted.make("private-key"),
        bundleId: "test",
      },
      apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
      clerkSecretKey: Redacted.make("clerk-secret"),
      clerkPublishableKey: "pk_test_test",
      clerkJwtAudience: "relay",
      cloudMintPrivateKey: Redacted.make("cloud-key"),
      cloudMintPublicKey: "cloud-public-key",
      managedEndpointBaseDomain: config.baseDomain,
      managedEndpointNamespace: config.stage,
    }),
    Effect.provideService(Allocations.ManagedEndpointAllocations, allocations),
    Effect.provideService(ManagedGatewayEnrollment, gateway),
    Effect.provideService(ManagedAccess.ManagedAccess, ManagedAccess.disabled),
    Effect.provide(ManagedReservations.layer({ enabled: false })),
    Effect.provideService(ManagedTunnelLimits, {
      ensureCapacity: () => Effect.suspend(() => hooks.ensureCapacity),
    }),
    Effect.provideService(Provider.ManagedEndpointTunnelClient, {
      list: () => Effect.sync(() => ({ result: [...tunnels.values()] })),
      create: ({ name }) =>
        Effect.sync(() => {
          const tunnel = { id: `tunnel-${++nextTunnel}`, name };
          tunnels.set(tunnel.id, tunnel);
          return tunnel;
        }),
      get: (tunnelId) =>
        Effect.suspend(() => {
          const tunnel = tunnels.get(tunnelId);
          return tunnel
            ? Effect.succeed(tunnel)
            : Effect.fail(
                new Provider.ManagedEndpointTunnelClientError({
                  operation: "get",
                  tunnelId,
                  cause: { _tag: "NotFound" },
                }),
              );
        }),
      putConfiguration: () => Effect.void,
      getToken: () => Effect.suspend(() => hooks.getToken),
      delete: (tunnelId) =>
        Effect.sync(() => {
          events.push(`delete-tunnel:${tunnelId}`);
          tunnels.delete(tunnelId);
        }),
    }),
    Effect.provideService(Provider.ManagedEndpointDnsClient, {
      listRecords: (name) =>
        Effect.sync(() => [...records.values()].filter((record) => record.name === name)),
      createRecord: (input) =>
        Effect.sync(() => {
          const record = { ...input, id: `dns-${++nextRecord}` };
          records.set(record.id, record);
          return record;
        }),
      updateRecord: () => Effect.die("Gateway DNS must not overwrite conflicting records"),
      deleteRecord: (id) =>
        Effect.suspend(() => hooks.deleteDns).pipe(
          Effect.andThen(
            Effect.sync(() => {
              events.push(`delete-dns:${id}`);
              records.delete(id);
            }),
          ),
        ),
    }),
    Effect.provide(NodeCrypto.layer),
  );
  return { ...setup, allocations, provider, input, hooks, events, tunnels, records };
});
describe.skipIf(!databaseUrl)("ManagedGatewayStore PostgreSQL", () => {
  it.effect(
    "recovers a legacy allocation with a verified origin and rejects other tunnel checkpoints",
    () =>
      run(
        Effect.gen(function* () {
          const { store, allocations, pending, mapping, provision } = yield* allocationFixture;
          const before = yield* allocations.get(mapping);
          expect(before).toMatchObject({
            tunnelId: null,
            readyAt: null,
            origin: null,
            generation: 0,
          });
          expect(
            yield* store.withAllocation(pending, provision(pending.generation, "replacement")),
          ).toEqual(Option.some(undefined));
          expect(
            yield* allocations.enableRecovery({
              ...mapping,
              tunnelId: "replacement",
              environmentPublicKey: "environment-key",
              origin,
            }),
          ).toBe(true);
          expect(
            yield* store.checkpointAllocation({
              ...pending,
              step: "dns",
              tunnelId: "old-tunnel",
              dnsRecordId: "old-dns",
            }),
          ).toBe(false);
          expect(
            yield* store.checkpointAllocation({
              ...pending,
              step: "ready",
              tunnelId: "old-tunnel",
              origin: { ...origin, localHttpPort: 9999 },
            }),
          ).toBe(false);
          expect(yield* allocations.get(mapping)).toMatchObject({
            tunnelId: "replacement",
            dnsRecordId: "dns-current",
            origin,
            generation: 4,
          });
        }),
      ),
  );
  it.effect(
    "clears old recovery metadata and advances the allocation claim on tunnel replacement",
    () =>
      run(
        Effect.gen(function* () {
          const { store, sql, allocations, pending, mapping, provision } = yield* allocationFixture;
          yield* provision(pending.generation, "retired");
          yield* allocations.enableRecovery({
            ...mapping,
            tunnelId: "retired",
            environmentPublicKey: "environment-key",
            origin,
          });
          const ready = (yield* allocations.get(mapping))!;
          yield* allocations.claimRelease({
            ...mapping,
            tunnelId: "retired",
            generation: ready.generation,
            markReleased: true,
          });
          expect(
            yield* store.checkpointAllocation({
              ...pending,
              step: "tunnel",
              tunnelId: "replacement",
            }),
          ).toBe(true);
          expect(
            (yield* sql`SELECT ready_at,origin,recovery_enabled_at,recovery_environment_public_key,tunnel_released_at,generation FROM relay_managed_endpoint_allocations WHERE user_id=${mapping.userId}`)[0],
          ).toEqual({
            ready_at: null,
            origin: null,
            recovery_enabled_at: null,
            recovery_environment_public_key: null,
            tunnel_released_at: null,
            generation: 6,
          });
        }),
      ),
  );
  it.effect(
    "a completed gateway reprovision invalidates an older release before DNS or tunnel deletion",
    () =>
      run(
        Effect.gen(function* () {
          const { store, allocations, pending, mapping, provision } = yield* allocationFixture;
          yield* provision(pending.generation, "adopted");
          const current = (yield* allocations.get(mapping))!;
          const releaseGeneration = (yield* allocations.claimRelease({
            ...mapping,
            tunnelId: "adopted",
            generation: current.generation,
          }))!;
          yield* store.pause(pending);
          const replacement = yield* store.registerPending(mapping);
          yield* store.withAllocation(replacement, provision(replacement.generation, "adopted"));
          const deleted: string[] = [];
          const result = yield* store.withAllocation(
            mapping,
            allocations.withClaimedTunnel(
              { ...mapping, tunnelId: "adopted", generation: releaseGeneration },
              Effect.sync(() => deleted.push("dns", "tunnel")),
            ),
          );
          expect(Option.flatten(result)).toEqual(Option.none());
          expect(deleted).toEqual([]);
        }),
      ),
  );
  it.effect(
    "holds the allocation through provider operations so a waiting release loses its claim",
    () =>
      run(
        Effect.gen(function* () {
          const { store, sql, allocations, pending, mapping, provision } = yield* allocationFixture;
          yield* provision(pending.generation, "adopted");
          const current = (yield* allocations.get(mapping))!;
          const acquired = yield* Deferred.make<void>();
          const finishProvider = yield* Deferred.make<void>();
          const owner = yield* store
            .withAllocation(
              pending,
              Effect.gen(function* () {
                yield* Deferred.succeed(acquired, undefined);
                yield* Deferred.await(finishProvider);
                yield* provision(pending.generation, "adopted");
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(acquired);
          const release = yield* allocations
            .claimRelease({ ...mapping, tunnelId: "adopted", generation: current.generation })
            .pipe(Effect.forkChild);
          // NOWAIT is a deterministic competing connection, not a timing assertion.
          const lock = yield* Effect.result(
            sql`SELECT user_id FROM relay_managed_endpoint_allocations WHERE user_id=${mapping.userId} FOR UPDATE NOWAIT`,
          );
          expect(lock._tag).toBe("Failure");
          yield* Deferred.succeed(finishProvider, undefined);
          yield* Fiber.join(owner);
          expect(yield* Fiber.join(release)).toBeNull();
          expect((yield* allocations.get(mapping))?.generation).toBe(current.generation + 3);
        }),
      ),
  );
  it.effect("rejects obsolete enrollment guards", () =>
    run(
      Effect.gen(function* () {
        const { store, pending, mapping } = yield* allocationFixture;
        yield* store.registerPending(mapping);
        expect(
          yield* store.withAllocation(pending, Effect.die("obsolete provider effect ran")),
        ).toEqual(Option.none());
      }),
    ),
  );
  it.effect("provider recovery persists the origin on a legacy suspended allocation", () =>
    run(
      Effect.gen(function* () {
        const { provider, input, sql, tunnels, records, allocations } = yield* providerFixture;
        const initial = yield* provider.provision(input);
        yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${input.userId},${input.environmentId},'environment-key',${initial.endpoint.httpBaseUrl},${initial.endpoint.wsBaseUrl},'cloudflare_tunnel','initial','initial')`;
        yield* sql`UPDATE relay_managed_endpoint_allocations SET origin=NULL,ready_at=NULL,tunnel_released_at='legacy-release' WHERE user_id=${input.userId}`;
        tunnels.clear();
        records.clear();
        const recovered = yield* provider.provision(input);
        expect(recovered.runtime.tunnelId).not.toBe(initial.runtime.tunnelId);
        expect(yield* allocations.get(input)).toMatchObject({ origin, tunnelReleasedAt: null });
        expect(
          yield* allocations.enableRecovery({
            ...input,
            tunnelId: recovered.runtime.tunnelId!,
            environmentPublicKey: "environment-key",
          }),
        ).toBe(true);
      }),
    ),
  );
  it.effect("a token failure preserves provider checkpoints for deprovision cleanup", () =>
    run(
      Effect.gen(function* () {
        const { provider, input, hooks, allocations, tunnels, records } = yield* providerFixture;
        hooks.getToken = Effect.fail(
          new Provider.ManagedEndpointTunnelClientError({
            operation: "get-token",
            cause: "synthetic token failure",
          }),
        );
        expect(yield* provider.provision(input).pipe(Effect.flip)).toMatchObject({
          _tag: "ManagedEndpointProvisioningFailed",
          stage: "get-tunnel-token",
        });
        expect(yield* allocations.get(input)).toMatchObject({
          tunnelId: "tunnel-1",
          dnsRecordId: "dns-1",
          readyAt: null,
          generation: 2,
        });
        expect(tunnels.size).toBe(1);
        expect(records.size).toBe(2);
        expect(yield* provider.deprovision(input)).toBe(true);
        expect(tunnels.size).toBe(0);
        expect(records.size).toBe(0);
        expect(yield* allocations.get(input)).toBeNull();
      }),
    ),
  );
  it.effect("a DNS cleanup failure preserves the confirmed tunnel release marker", () =>
    run(
      Effect.gen(function* () {
        const { provider, input, hooks, allocations, tunnels, records } = yield* providerFixture;
        yield* provider.provision(input);
        const before = (yield* allocations.get(input))!;
        hooks.deleteDns = Effect.fail(
          new Provider.ManagedEndpointDnsClientError({
            operation: "delete-record",
            cause: "synthetic DNS failure",
          }),
        );
        expect(
          yield* provider.release({ ...input, markReleased: true }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ManagedEndpointDeprovisioningFailed",
          stage: "delete-dns-record",
        });
        const released = (yield* allocations.get(input))!;
        expect(released.generation).toBeGreaterThan(before.generation);
        expect(released.tunnelReleasedAt).not.toBeNull();
        expect(tunnels.size).toBe(0);
        hooks.deleteDns = Effect.void;
        expect(yield* provider.release(input)).toBe(true);
        expect(records.size).toBe(0);
      }),
    ),
  );
  it.effect("a stale provider release cannot delete a reprovisioned tunnel or its DNS", () =>
    run(
      Effect.gen(function* () {
        const { provider, input, hooks, events, tunnels, records } = yield* providerFixture;
        const initial = yield* provider.provision(input);
        const paused = yield* Deferred.make<void>();
        const finishSync = yield* Deferred.make<void>();
        hooks.sync = Deferred.succeed(paused, undefined).pipe(
          Effect.andThen(Deferred.await(finishSync)),
        );
        const release = yield* provider.release(input).pipe(Effect.forkChild);
        yield* Deferred.await(paused);
        hooks.sync = Effect.void;
        const replacement = yield* provider.provision(input);
        expect(replacement.runtime.tunnelId).toBe(initial.runtime.tunnelId);
        yield* Deferred.succeed(finishSync, undefined);
        expect(yield* Fiber.join(release)).toBe(false);
        expect(events).toEqual([]);
        expect(tunnels.has(replacement.runtime.tunnelId!)).toBe(true);
        expect(records.size).toBe(2);
      }),
    ),
  );
  it.effect("serializes destructive tunnel and DNS release with a newer provision", () =>
    run(
      Effect.gen(function* () {
        const { provider, input, hooks, sql, tunnels, records } = yield* providerFixture;
        const initial = yield* provider.provision(input);
        const deletingDns = yield* Deferred.make<void>();
        const finishDelete = yield* Deferred.make<void>();
        const provisionStarted = yield* Deferred.make<void>();
        hooks.deleteDns = Deferred.succeed(deletingDns, undefined).pipe(
          Effect.andThen(Deferred.await(finishDelete)),
        );
        const release = yield* provider.release(input).pipe(Effect.forkChild);
        yield* Deferred.await(deletingDns);
        hooks.ensureCapacity = Deferred.succeed(provisionStarted, undefined).pipe(Effect.asVoid);
        const provision = yield* provider.provision(input).pipe(Effect.forkChild);
        yield* Deferred.await(provisionStarted);
        const locked = yield* Effect.result(
          sql`SELECT user_id FROM relay_managed_gateway_accounts WHERE user_id=${input.userId} FOR UPDATE NOWAIT`,
        );
        expect(locked._tag).toBe("Failure");
        yield* Deferred.succeed(finishDelete, undefined);
        expect(yield* Fiber.join(release)).toBe(true);
        const replacement = yield* Fiber.join(provision);
        expect(replacement.runtime.tunnelId).not.toBe(initial.runtime.tunnelId);
        expect([...tunnels.keys()]).toEqual([replacement.runtime.tunnelId]);
        expect(records.size).toBe(2);
        expect(
          [...records.values()].every(
            (record) => record.content === `${replacement.runtime.tunnelId}.cfargotunnel.com`,
          ),
        ).toBe(true);
      }),
    ),
  );
  it.effect("cuts off revoked company funding without changing the owner's personal window", () =>
    run(
      Effect.gen(function* () {
        const { mapping, userId, sql, config } = yield* fixture;
        const store = yield* makeManagedGatewayStore({ ...config, teamsEnabled: true });
        yield* sql`INSERT INTO relay_team_accounts(organization_id,owner_user_id,purchased_seats,access_until,access_window_start,created_at,updated_at) VALUES (${userId},${userId},5,200,0,0,0)`;
        yield* sql`INSERT INTO relay_team_seats(organization_id,user_id,assigned_at) VALUES (${userId},${userId},0)`;
        yield* sql`INSERT INTO relay_team_environment_funding(organization_id,user_id,environment_id,created_at) VALUES (${userId},${userId},${mapping.environmentId},0)`;
        const pending = yield* store.registerPending(mapping);
        yield* store.markReady(pending);
        const active = yield* store.capture(userId);
        expect(active.accessUntilMs).toBe(100000);
        expect(active.environments[0]?.accessUntilMs).toBe(200000);
        yield* sql`DELETE FROM relay_team_seats WHERE organization_id=${userId}`;
        const revoked = yield* store.capture(userId);
        expect(revoked.accessUntilMs).toBe(100000);
        expect(revoked.environments[0]?.accessUntilMs).toBeNull();
      }),
    ),
  );
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
          yield* store.checkpointAllocation({
            ...current,
            step: "dns",
            tunnelId: "new-tunnel",
            dnsRecordId: "new-dns",
          }),
        ).toBe(true);
        expect(
          yield* store.checkpointAllocation({
            ...current,
            step: "ready",
            tunnelId: "new-tunnel",
            origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          }),
        ).toBe(true);
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
            tunnelId: "old-tunnel",
            dnsRecordId: "late-old-dns",
          }),
        ).toBe(false);
        expect(
          yield* store.checkpointAllocation({
            ...obsolete,
            step: "ready",
            tunnelId: "old-tunnel",
            origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          }),
        ).toBe(false);
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
