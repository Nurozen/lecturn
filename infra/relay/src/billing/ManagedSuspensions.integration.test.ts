import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { BillingError, operationId } from "./BillingStore.ts";
import { makeManagedSuspensions } from "./ManagedSuspensions.ts";
import { make as makeReservations } from "./ManagedReservations.ts";
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
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const id = `suspension-${yield* operationId}`;
  yield* sql`INSERT INTO relay_billing_accounts(user_id,generation,state,updated_at) VALUES (${id},1,'{"accessUntil":0}'::jsonb,0)`;
  yield* sql`INSERT INTO relay_managed_endpoint_allocations(user_id,environment_id,hostname,tunnel_id,tunnel_name,created_at,updated_at) VALUES(${id},'env',${id},${id},${id},'0','0')`;
  yield* sql`INSERT INTO relay_managed_reservations(user_id,environment_id,generation,account_generation,enabled,state,updated_at) VALUES(${id},'env',1,1,true,'active',0)`;
  yield* sql`UPDATE relay_billing_enforcement_control SET enabled=true,epoch=epoch+1 WHERE id=1`;
  return { sql, id };
});
const run = <A, E>(effect: Effect.Effect<A, E, RelayDb>) => effect.pipe(Effect.provide(database));
describe.skipIf(!databaseUrl)("ManagedSuspensions PostgreSQL", () => {
  it.effect(
    "finishing old teardown cannot clear a replacement tunnel or its newer quota generation",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, id } = yield* fixture;
          const worker = yield* makeManagedSuspensions({
            enabled: () => Effect.succeed(true),
            enforcementUsers: [id],
            provider: {
              rotate: () => Effect.void,
              disconnect: () => Effect.void,
              remove: () =>
                Effect.gen(function* () {
                  yield* sql`UPDATE relay_managed_endpoint_allocations SET tunnel_id='replacement' WHERE user_id=${id}`;
                  yield* sql`UPDATE relay_managed_reservations SET generation=2 WHERE user_id=${id}`;
                }).pipe(
                  Effect.mapError(() => new BillingError({ code: "unavailable", message: "db" })),
                ),
            },
          });
          yield* worker.drain();
          expect(
            (yield* sql<{
              tunnel_id: string;
            }>`SELECT tunnel_id FROM relay_managed_endpoint_allocations WHERE user_id=${id}`)[0]!
              .tunnel_id,
          ).toBe("replacement");
          expect(
            (yield* sql<{
              generation: number;
              enabled: boolean;
            }>`SELECT generation,enabled FROM relay_managed_reservations WHERE user_id=${id}`)[0],
          ).toEqual({ generation: 2, enabled: true });
        }),
      ),
  );

  it.effect(
    "active grants prevent paid-term expiry cleanup while a financial hold overrides the grant",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, id } = yield* fixture;
          const state = {
            accessUntil: 0,
            grant: {
              id: "transition",
              start: 0,
              end: 1000,
              limit: 4,
              reason: "Transition existing environments",
              operator: "test",
            },
          };
          yield* sql`UPDATE relay_billing_accounts SET state=${encodeJson(state)}::jsonb WHERE user_id=${id}`;
          const calls: string[] = [];
          const worker = yield* makeManagedSuspensions({
            enabled: () => Effect.succeed(true),
            enforcementUsers: [id],
            provider: {
              rotate: () =>
                Effect.sync(() => {
                  calls.push("rotate");
                }),
              disconnect: () => Effect.void,
              remove: () => Effect.void,
            },
          });
          yield* worker.drain();
          expect(calls).toEqual([]);
          expect(
            yield* sql`SELECT tunnel_id FROM relay_managed_suspensions WHERE tunnel_id=${id}`,
          ).toHaveLength(0);
          yield* sql`UPDATE relay_billing_accounts SET state=${encodeJson({ ...state, suspended: true })}::jsonb WHERE user_id=${id}`;
          yield* worker.drain();
          expect(calls).toEqual(["rotate"]);
        }),
      ),
  );

  it.effect(
    "persists failed disconnect and blocks renewed allocation until exact retired resource is gone",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, id } = yield* fixture;
          let failing = true;
          const calls: string[] = [];
          const worker = yield* makeManagedSuspensions({
            enabled: () => Effect.succeed(true),
            enforcementUsers: [id],
            provider: {
              rotate: (target) =>
                Effect.sync(() => {
                  calls.push(`rotate:${target}`);
                }),
              disconnect: (target) =>
                failing
                  ? Effect.fail(new BillingError({ code: "unavailable", message: "offline" }))
                  : Effect.sync(() => {
                      calls.push(`disconnect:${target}`);
                    }),
              remove: (target) =>
                Effect.sync(() => {
                  calls.push(`delete:${target}`);
                }),
            },
          });
          yield* worker.drain();
          const interrupted = (yield* sql<{
            stage: string;
            completed_at: number | null;
          }>`SELECT stage,completed_at FROM relay_managed_suspensions WHERE tunnel_id=${id}`)[0]!;
          expect(interrupted.stage).toBe("rotated");
          expect(interrupted.completed_at).toBeNull();
          const futureName = (yield* sql<{
            tunnel_name: string;
          }>`SELECT tunnel_name FROM relay_managed_endpoint_allocations WHERE user_id=${id}`)[0]!
            .tunnel_name;
          expect(futureName).toMatch(/^lecturn-recovery-[a-f0-9]{32}$/);
          expect(futureName).not.toBe(id);
          yield* sql`UPDATE relay_billing_accounts SET state=${encodeJson({ accessUntil: 1000 })}::jsonb WHERE user_id=${id}`;
          const reservations = yield* makeReservations({ enabled: true });
          expect(
            (yield* reservations.reserve({ userId: id, environmentId: "env" }).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          failing = false;
          yield* sql`UPDATE relay_managed_suspensions SET retry_at=0 WHERE tunnel_id=${id}`;
          yield* worker.drain();
          expect(calls).toEqual([`rotate:${id}`, `disconnect:${id}`, `delete:${id}`]);
          expect(
            (yield* sql<{
              tunnel_id: string | null;
            }>`SELECT tunnel_id FROM relay_managed_endpoint_allocations WHERE user_id=${id}`)[0]!
              .tunnel_id,
          ).toBeNull();
          expect(
            (yield* reservations.reserve({ userId: id, environmentId: "env" }))!.generation,
          ).toBeGreaterThan(1);
        }),
      ),
  );
  it.effect(
    "durable rollback stops an old drain after token rotation, even when configuration closure remains true",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, id } = yield* fixture;
          const calls: string[] = [];
          const worker = yield* makeManagedSuspensions({
            enabled: () => Effect.succeed(true),
            enforcementUsers: [id],
            provider: {
              rotate: () =>
                sql`UPDATE relay_billing_enforcement_control SET enabled=false,epoch=epoch+1 WHERE id=1`.pipe(
                  Effect.asVoid,
                  Effect.mapError(() => new BillingError({ code: "unavailable", message: "db" })),
                ),
              disconnect: () =>
                Effect.sync(() => {
                  calls.push("disconnect");
                }),
              remove: () =>
                Effect.sync(() => {
                  calls.push("delete");
                }),
            },
          });
          yield* worker.drain();
          expect(calls).toEqual([]);
          expect(
            (yield* sql<{
              stage: string;
              completed_at: number | null;
            }>`SELECT stage,completed_at FROM relay_managed_suspensions WHERE tunnel_id=${id}`)[0],
          ).toEqual({ stage: "rotated", completed_at: null });
        }),
      ),
  );
  it.effect(
    "expired accounts outside the rollout cohort and stale projections keep their resources",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, id } = yield* fixture;
          const calls: string[] = [];
          const provider = {
            rotate: () =>
              Effect.sync(() => {
                calls.push("rotate");
              }),
            disconnect: () => Effect.void,
            remove: () => Effect.void,
          };
          const excluded = yield* makeManagedSuspensions({
            enabled: () => Effect.succeed(true),
            enforcementUsers: [],
            provider,
          });
          yield* excluded.drain();
          yield* sql`UPDATE relay_billing_accounts SET updated_at=-901 WHERE user_id=${id}`;
          const stale = yield* makeManagedSuspensions({
            enabled: () => Effect.succeed(true),
            enforcementUsers: [id],
            provider,
          });
          yield* stale.drain();
          expect(calls).toEqual([]);
          expect(
            yield* sql`SELECT tunnel_id FROM relay_managed_suspensions WHERE tunnel_id=${id}`,
          ).toHaveLength(0);
        }),
      ),
  );
});
