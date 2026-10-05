import { DecisionsService } from "../decisions/DecisionsService.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Effect, Layer, Redacted } from "effect";
import { RelayDb } from "../db.ts";
import { EnvironmentRelinks, layer as relinkLayer } from "./EnvironmentRelinks.ts";
import { EnvironmentLinks, layer as linksLayer } from "./EnvironmentLinks.ts";
import { EnvironmentCredentials } from "./EnvironmentCredentials.ts";
import {
  ManagedEndpointProvider,
  ManagedEndpointDeprovisioningFailed,
} from "./ManagedEndpointProvider.ts";
import { TeamRuntime } from "../teams/TeamRuntime.ts";

const url = process.env.RELAY_PUSH_TEST_DATABASE_URL;
const database = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(
    PgClient.layer({
      url: Redacted.make(url ?? "postgresql://127.0.0.1/unused"),
      connectTimeout: "5 seconds",
    }),
  ),
);

function fixture() {
  const environmentId = `relink-test-${NodeCrypto.randomUUID()}`;
  const users = [`${environmentId}-A`, `${environmentId}-B`];
  const events: string[] = [];
  const decisionRevocations: string[] = [];
  let failCleanup = false;
  const services = Layer.mergeAll(relinkLayer, linksLayer).pipe(
    Layer.provideMerge(database),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DecisionsService, {
          funding: {
            revokeEnvironment: (id: string) =>
              Effect.sync(() => {
                decisionRevocations.push(id);
              }),
          },
        } as unknown as DecisionsService["Service"]),
        Layer.succeed(ManagedEndpointProvider, {
          prepareDeprovision: () => Effect.succeed({ allocation: null, reservationGeneration: 7 }),
          deprovision: () =>
            failCleanup
              ? Effect.fail(
                  new ManagedEndpointDeprovisioningFailed({
                    userId: users[0]!,
                    environmentId,
                    stage: "load-allocation",
                    cause: "test retry",
                  }),
                )
              : Effect.sync(() => {
                  events.push("endpoint");
                }),
        } as unknown as ManagedEndpointProvider["Service"]),
        Layer.succeed(EnvironmentCredentials, {
          revokeForEnvironmentPublicKey: () =>
            Effect.sync(() => {
              events.push("credential");
              return true;
            }),
        } as unknown as EnvironmentCredentials["Service"]),
        Layer.succeed(TeamRuntime, {
          funding: () => Effect.succeed({ organizationId: "prior-team" }),
          unlinked: () =>
            Effect.sync(() => {
              events.push("team");
            }),
        } as unknown as TeamRuntime["Service"]),
      ),
    ),
  );
  const insert = Effect.fn("relinkTest.insert")(function* (userId: string, updatedAt: string) {
    const { $client: sql } = yield* RelayDb;
    yield* sql`INSERT INTO relay_environment_links(user_id, environment_id, environment_label, environment_public_key, endpoint_http_base_url, endpoint_ws_base_url, endpoint_provider_kind, notifications_enabled, live_activities_enabled, managed_tunnels_enabled, created_at, updated_at) VALUES(${userId}, ${environmentId}, 'fixture', 'shared-key', 'https://example.test', 'wss://example.test', 'manual', true, true, false, ${updatedAt}, ${updatedAt}) ON CONFLICT(user_id,environment_id) DO UPDATE SET revoked_at=NULL,updated_at=excluded.updated_at`;
  });
  const cleanup = Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    yield* sql`DELETE FROM relay_environment_link_cleanup WHERE environment_id=${environmentId}`;
    yield* sql`DELETE FROM relay_environment_links WHERE environment_id=${environmentId}`;
    yield* sql`DELETE FROM relay_environment_link_owners WHERE environment_id=${environmentId}`;
  }).pipe(Effect.orDie);
  return {
    environmentId,
    users,
    events,
    decisionRevocations,
    services,
    insert,
    cleanup,
    fail: (value: boolean) => {
      failCleanup = value;
    },
  };
}

describe.skipIf(!url)("PostgreSQL relink ownership", () => {
  it.effect(
    "one-off cleanup preserves the newest shared-key link and releases displaced resources",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const relinks = yield* EnvironmentRelinks;
        const links = yield* EnvironmentLinks;
        const { $client: sql } = yield* RelayDb;
        yield* f.insert(f.users[0]!, "2026-01-01T00:00:00.000Z");
        yield* f.insert(f.users[1]!, "2026-01-02T00:00:00.000Z");
        yield* sql`INSERT INTO relay_environment_link_owners(environment_id,legacy_cleanup_pending) VALUES(${f.environmentId},true)`;
        yield* relinks.drain(f.environmentId);
        expect(yield* links.listForUser({ userId: f.users[0]! })).toEqual([]);
        expect(
          yield* links.listDeliveryUsersForEnvironment({
            environmentId: f.environmentId,
            environmentPublicKey: "shared-key",
          }),
        ).toEqual([
          { userId: f.users[1], notificationsEnabled: true, liveActivitiesEnabled: true },
        ]);
        expect(f.events).toEqual(["endpoint", "team"]);
        expect(
          yield* sql`SELECT 1 FROM relay_environment_link_cleanup WHERE environment_id=${f.environmentId}`,
        ).toEqual([]);
      }).pipe(Effect.ensuring(f.cleanup), Effect.provide(f.services));
    },
    30_000,
  );
  it.effect(
    "commits the sole new recipient while failed cleanup remains retryable",
    () => {
      const f = fixture();
      f.fail(true);
      return Effect.gen(function* () {
        const relinks = yield* EnvironmentRelinks;
        const links = yield* EnvironmentLinks;
        const { $client: sql } = yield* RelayDb;
        yield* f.insert(f.users[0]!, "2026-01-01T00:00:00.000Z");
        yield* relinks.withLinkLock(
          f.environmentId,
          Effect.gen(function* () {
            yield* relinks.displace({ userId: f.users[1]!, environmentId: f.environmentId });
            yield* f.insert(f.users[1]!, "2026-01-02T00:00:00.000Z");
          }),
        );
        expect(
          yield* links.listDeliveryUsersForEnvironment({
            environmentId: f.environmentId,
            environmentPublicKey: "shared-key",
          }),
        ).toHaveLength(1);
        expect(
          yield* sql`SELECT 1 FROM relay_environment_link_cleanup WHERE environment_id=${f.environmentId}`,
        ).toHaveLength(1);
        f.fail(false);
        yield* relinks.drain(f.environmentId);
        expect(f.events).toEqual(["credential", "endpoint", "team"]);
        expect(f.decisionRevocations).toContain(f.environmentId);
        expect(
          yield* sql`SELECT 1 FROM relay_environment_link_cleanup WHERE environment_id=${f.environmentId}`,
        ).toEqual([]);
      }).pipe(Effect.ensuring(f.cleanup), Effect.provide(f.services));
    },
    30_000,
  );
  it.effect(
    "concurrent relinks commit only one live owner",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const relinks = yield* EnvironmentRelinks;
        const links = yield* EnvironmentLinks;
        yield* Effect.forEach(
          f.users,
          (userId) =>
            relinks.withLinkLock(
              f.environmentId,
              Effect.gen(function* () {
                yield* relinks.displace({ userId, environmentId: f.environmentId });
                yield* f.insert(userId, "2026-01-02T00:00:00.000Z");
              }),
            ),
          { concurrency: 2 },
        );
        expect(
          yield* links.listDeliveryUsersForEnvironment({
            environmentId: f.environmentId,
            environmentPublicKey: "shared-key",
          }),
        ).toHaveLength(1);
      }).pipe(Effect.ensuring(f.cleanup), Effect.provide(f.services));
    },
    30_000,
  );
});
