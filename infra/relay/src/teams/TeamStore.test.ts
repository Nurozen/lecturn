import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { operationId } from "../billing/BillingStore.ts";
import { makeTeamStore } from "./TeamStore.ts";

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
const fixture = Effect.gen(function* () {
  const store = yield* makeTeamStore;
  const { $client: sql } = yield* RelayDb;
  const organizationId = `team-${yield* operationId}`;
  yield* store.bootstrap({ organizationId, ownerUserId: "owner" });
  yield* sql`UPDATE relay_team_accounts SET purchased_seats=1,access_until=1000 WHERE organization_id=${organizationId}`;
  return { store, sql, organizationId, actorUserId: "owner" };
});
describe.skipIf(!databaseUrl)("TeamStore PostgreSQL", () => {
  it.effect("serializes concurrent assignments against paid seat capacity", () =>
    run(
      Effect.gen(function* () {
        const { store, organizationId, actorUserId } = yield* fixture;
        const results = yield* Effect.all(
          ["one", "two"].map((userId) =>
            store.assignSeat({ organizationId, actorUserId, userId }).pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect(
          results
            .filter((result) => result._tag === "Failure")
            .map((result) => result.failure.code),
        ).toEqual(["quota"]);
        expect(yield* store.seats(organizationId)).toHaveLength(1);
      }),
    ),
  );
  it.effect("does not grant seats for unpaid, expired or suspended subscriptions", () =>
    run(
      Effect.gen(function* () {
        const { store, sql, organizationId, actorUserId } = yield* fixture;
        for (const update of [
          sql`UPDATE relay_team_accounts SET purchased_seats=0 WHERE organization_id=${organizationId}`,
          sql`UPDATE relay_team_accounts SET purchased_seats=1,access_until=0 WHERE organization_id=${organizationId}`,
          sql`UPDATE relay_team_accounts SET access_until=1000,suspended=true WHERE organization_id=${organizationId}`,
        ]) {
          yield* update;
          const result = yield* store
            .assignSeat({ organizationId, actorUserId, userId: "employee" })
            .pipe(Effect.result);
          expect(result._tag === "Failure" && result.failure.code).toBe("subscription_required");
        }
      }),
    ),
  );
  it.effect("retains company provenance when a seat is removed and denies access", () =>
    run(
      Effect.gen(function* () {
        const { store, sql, organizationId, actorUserId } = yield* fixture;
        yield* store.assignSeat({ organizationId, actorUserId, userId: "employee" });
        yield* sql`INSERT INTO relay_team_environment_funding(user_id,environment_id,organization_id,created_at) VALUES ('employee',${organizationId},${organizationId},0)`;
        expect((yield* store.access("employee", organizationId, 0))?.allowed).toBe(true);
        expect(
          yield* store.revokeSeat({ organizationId, actorUserId, userId: "employee" }),
        ).toEqual([organizationId]);
        expect((yield* store.access("employee", organizationId, 0))?.allowed).toBe(false);
        expect((yield* store.funding("employee", organizationId))?.organizationId).toBe(
          organizationId,
        );
        expect(yield* store.access("employee", "personal", 0)).toBeUndefined();
      }),
    ),
  );
  it.effect(
    "requires owner proof, preserves funding until unlink and enforces three environments",
    () =>
      run(
        Effect.gen(function* () {
          const { store, sql, organizationId, actorUserId } = yield* fixture;
          const userId = organizationId;
          yield* store.assignSeat({ organizationId, actorUserId, userId });
          const input = {
            organizationId,
            actorUserId: userId,
            userId,
            proofVerified: true as const,
          };
          const denied = yield* store
            .bindEnvironment({ ...input, actorUserId: "other", environmentId: "stolen" })
            .pipe(Effect.result);
          expect(denied._tag === "Failure" && denied.failure.code).toBe("forbidden");
          for (const environmentId of ["one", "two", "three"])
            yield* store.bindEnvironment({ ...input, environmentId });
          const fourth = yield* store
            .bindEnvironment({ ...input, environmentId: "four" })
            .pipe(Effect.result);
          expect(fourth._tag === "Failure" && fourth.failure.code).toBe("quota");
          // Funding cannot disappear while the corresponding user link is still live.
          yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_label,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${userId},'one','device','key','https://example.test','wss://example.test','direct','0','0')`;
          const linked = yield* store
            .unbindEnvironment({ ...input, environmentId: "one" })
            .pipe(Effect.result);
          expect(linked._tag === "Failure" && linked.failure.code).toBe("conflict");
          yield* sql`UPDATE relay_environment_links SET revoked_at='1' WHERE user_id=${userId} AND environment_id='one'`;
          yield* store.unbindEnvironment({ ...input, environmentId: "one" });
          expect(yield* store.funding(userId, "one")).toBeUndefined();
          yield* sql`UPDATE relay_environment_links SET revoked_at=NULL WHERE user_id=${userId} AND environment_id='one'`;
          const personal = yield* store
            .bindEnvironment({ ...input, environmentId: "one" })
            .pipe(Effect.result);
          expect(personal._tag === "Failure" && personal.failure.code).toBe("conflict");
        }),
      ),
  );
  it.effect("blocks assignment during billing but permits immediate revocation", () =>
    run(
      Effect.gen(function* () {
        const { store, sql, organizationId, actorUserId } = yield* fixture;
        yield* store.assignSeat({ organizationId, actorUserId, userId: "one" });
        yield* sql`UPDATE relay_team_accounts SET billing_lease_expires_at=1000 WHERE organization_id=${organizationId}`;
        const result = yield* store
          .assignSeat({ organizationId, actorUserId, userId: "two" })
          .pipe(Effect.result);
        expect(result._tag === "Failure" && result.failure.code).toBe("conflict");
        yield* store.revokeSeat({ organizationId, actorUserId, userId: "one" });
        expect(yield* store.seats(organizationId)).toHaveLength(0);
      }),
    ),
  );
  it.effect("reserves renewal reduction capacity and assignment is idempotent", () =>
    run(
      Effect.gen(function* () {
        const { store, sql, organizationId, actorUserId } = yield* fixture;
        yield* sql`UPDATE relay_team_accounts SET purchased_seats=5,pending_seats=1 WHERE organization_id=${organizationId}`;
        yield* store.assignSeat({ organizationId, actorUserId, userId: "one" });
        yield* store.assignSeat({ organizationId, actorUserId, userId: "one" });
        const result = yield* store
          .assignSeat({ organizationId, actorUserId, userId: "two" })
          .pipe(Effect.result);
        expect(result._tag === "Failure" && result.failure.code).toBe("quota");
        expect(
          (yield* store.history(organizationId)).filter(
            (event) => event.action === "seat.assigned",
          ),
        ).toHaveLength(1);
      }),
    ),
  );
});

describe.skipIf(!databaseUrl)("TeamStore user deletion", () => {
  it.effect(
    "tombstones the user, closes owned company access, preserves other companies and fences stale assignments",
    () =>
      run(
        Effect.gen(function* () {
          const { store, sql, organizationId, actorUserId } = yield* fixture;
          const deletedUser = `deleted-${yield* operationId}`;
          const coworker = `coworker-${yield* operationId}`;
          yield* sql`UPDATE relay_team_accounts SET owner_user_id=${deletedUser},purchased_seats=3 WHERE organization_id=${organizationId}`;
          yield* store.assignSeat({ organizationId, actorUserId, userId: deletedUser });
          yield* store.assignSeat({ organizationId, actorUserId, userId: coworker });
          yield* sql`INSERT INTO relay_team_environment_funding(user_id,environment_id,organization_id,created_at) VALUES (${coworker},${organizationId},${organizationId},0)`;
          const other = `other-${yield* operationId}`;
          yield* store.bootstrap({ organizationId: other, ownerUserId: "other-owner" });
          yield* sql`UPDATE relay_team_accounts SET purchased_seats=2,access_until=1000 WHERE organization_id=${other}`;
          yield* store.assignSeat({
            organizationId: other,
            actorUserId: "other-owner",
            userId: deletedUser,
          });
          yield* sql`INSERT INTO relay_team_environment_funding(user_id,environment_id,organization_id,created_at) VALUES (${deletedUser},${other},${other},0)`;
          const first = yield* store.markUserDeleted(deletedUser);
          expect(first.ownedOrganizationIds).toEqual([organizationId]);
          expect(new Set(first.affectedUserIds)).toEqual(new Set([deletedUser, coworker]));
          expect((yield* store.get(organizationId))?.status).toBe("deleted");
          expect((yield* store.access(coworker, organizationId, 0))?.allowed).toBe(false);
          expect((yield* store.access(deletedUser, other, 0))?.allowed).toBe(false);
          expect((yield* store.get(other))?.purchased_seats).toBe(2);
          expect(yield* store.seats(other)).toEqual([]);
          expect(
            (yield* Effect.flip(
              store.assignSeat({
                organizationId: other,
                actorUserId: "other-owner",
                userId: deletedUser,
              }),
            )).code,
          ).toBe("forbidden");
          // A stale in-flight assignment cannot restore authorization even if its insert races cleanup.
          yield* sql`INSERT INTO relay_team_seats(organization_id,user_id,assigned_at) VALUES (${other},${deletedUser},0)`;
          expect((yield* store.access(deletedUser, other, 0))?.allowed).toBe(false);
          const retry = yield* store.markUserDeleted(deletedUser);
          expect(retry.ownedOrganizationIds).toEqual([organizationId]);
          expect(new Set(retry.affectedUserIds)).toEqual(new Set([deletedUser, coworker]));
          expect(yield* store.seats(other)).toEqual([]);
          expect((yield* store.funding(deletedUser, other))?.organizationId).toBe(other);
        }),
      ),
  );
});
