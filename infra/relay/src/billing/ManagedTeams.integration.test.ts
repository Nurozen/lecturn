import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { operationId } from "./BillingStore.ts";
import { make } from "./ManagedReservations.ts";
import { makeManagedSuspensions } from "./ManagedSuspensions.ts";
const url = process.env.BILLING_TEST_DATABASE_URL;
const database = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    return { $client: yield* PgClient.PgClient } as RelayDb["Service"];
  }),
).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(url ?? "postgresql://127.0.0.1/unused") })),
);
const run = <A, E>(effect: Effect.Effect<A, E, RelayDb>) => effect.pipe(Effect.provide(database));
const fixture = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const user = `team-reservation-${yield* operationId}`;
  const org = `org-${user}`;
  yield* sql`INSERT INTO relay_billing_accounts(user_id,generation,state,updated_at) VALUES (${user},1,'{"accessUntil":9999}'::jsonb,0)`;
  yield* sql`INSERT INTO relay_team_accounts(organization_id,owner_user_id,purchased_seats,access_until,access_window_start,generation,created_at,updated_at) VALUES (${org},${user},5,9999,0,1,0,0)`;
  yield* sql`INSERT INTO relay_team_seats(organization_id,user_id,assigned_at) VALUES (${org},${user},0)`;
  yield* sql`INSERT INTO relay_team_environment_funding(organization_id,user_id,environment_id,created_at) VALUES (${org},${user},'company',0)`;
  const reservations = yield* make({ enabled: true, teamsEnabled: true });
  return { sql, user, org, reservations };
});
describe.skipIf(!url)("Teams managed resources", () => {
  it.effect(
    "team funding works without a personal subscription and is fenced on seat removal",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, user, org, reservations } = yield* fixture;
          yield* sql`UPDATE relay_billing_accounts SET state='{}'::jsonb WHERE user_id=${user}`;
          const pending = yield* reservations.reserve({ userId: user, environmentId: "company" });
          expect(pending?.fundingOrganizationId).toBe(org);
          expect(yield* reservations.complete(pending)).toBe(true);
          yield* sql`DELETE FROM relay_team_seats WHERE organization_id=${org}`;
          expect(yield* reservations.complete(pending)).toBe(false);
          expect(
            (yield* Effect.result(reservations.reserve({ userId: user, environmentId: "company" })))
              ._tag,
          ).toBe("Failure");
        }),
      ),
  );
  it.effect("revoked team access never falls back to a paid personal subscription", () =>
    run(
      Effect.gen(function* () {
        const { sql, user, org, reservations } = yield* fixture;
        yield* sql`DELETE FROM relay_team_seats WHERE organization_id=${org}`;
        expect(
          (yield* Effect.result(reservations.reserve({ userId: user, environmentId: "company" })))
            ._tag,
        ).toBe("Failure");
      }),
    ),
  );
  it.effect("company resources do not consume the personal three-environment quota", () =>
    run(
      Effect.gen(function* () {
        const { user, reservations } = yield* fixture;
        yield* reservations.reserve({ userId: user, environmentId: "company" });
        for (const environmentId of ["personal-1", "personal-2", "personal-3"])
          expect(yield* reservations.reserve({ userId: user, environmentId })).not.toBeNull();
        expect(
          (yield* Effect.result(
            reservations.reserve({ userId: user, environmentId: "personal-4" }),
          ))._tag,
        ).toBe("Failure");
      }),
    ),
  );
  it.effect("physical teardown follows company seat access instead of personal payment", () =>
    run(
      Effect.gen(function* () {
        const { sql, user, org } = yield* fixture;
        yield* sql`INSERT INTO relay_managed_endpoint_allocations(user_id,environment_id,hostname,tunnel_id,tunnel_name,created_at,updated_at) VALUES(${user},'company',${user},${user},${user},'0','0')`;
        yield* sql`UPDATE relay_billing_accounts SET state='{}'::jsonb WHERE user_id=${user}`;
        yield* sql`UPDATE relay_billing_enforcement_control SET enabled=true,epoch=epoch+1 WHERE id=1`;
        const removed: string[] = [];
        const worker = yield* makeManagedSuspensions({
          teamsEnabled: true,
          enabled: () => Effect.succeed(true),
          enforcementUsers: [user],
          provider: {
            rotate: () => Effect.void,
            disconnect: () => Effect.void,
            remove: (id) =>
              Effect.sync(() => {
                removed.push(id);
              }),
          },
        });
        yield* worker.drain();
        expect(removed).not.toContain(user);
        yield* sql`UPDATE relay_billing_accounts SET state='{"accessUntil":9999}'::jsonb WHERE user_id=${user}`;
        yield* sql`DELETE FROM relay_team_seats WHERE organization_id=${org}`;
        yield* worker.drain();
        expect(removed).toContain(user);
      }),
    ),
  );
});
