import { Clock, Context, Effect, Layer, Schema } from "effect";
import { RelayDb } from "../db.ts";
import { effectiveAccountAccess } from "./BillingGrants.ts";
import { BillingError, type BillingAccount } from "./BillingStore.ts";

export interface ManagedReservation {
  readonly userId: string;
  readonly environmentId: string;
  readonly generation: number;
  readonly accountGeneration: number;
  readonly state: "pending" | "active";
}
interface ReservationRow {
  user_id: string;
  environment_id: string;
  generation: number;
  account_generation: number;
  enabled: boolean;
  state: "pending" | "active" | "disabled";
}
export interface ReservationKey {
  readonly userId: string;
  readonly environmentId: string;
}
export class ManagedReservations extends Context.Service<
  ManagedReservations,
  {
    readonly get: (input: ReservationKey) => Effect.Effect<ManagedReservation | null, BillingError>;
    readonly reserve: (
      input: ReservationKey,
    ) => Effect.Effect<ManagedReservation | null, BillingError>;
    readonly complete: (
      reservation: ManagedReservation | null,
    ) => Effect.Effect<boolean, BillingError>;
    readonly release: (
      input: ReservationKey & { readonly generation?: number },
    ) => Effect.Effect<boolean, BillingError>;
  }
>()("lecturn-relay/billing/ManagedReservations") {}
const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
const allowed = (account: BillingAccount | undefined, time: number) =>
  effectiveAccountAccess(account, time).allowed;
const isBillingError = Schema.is(BillingError);
const unavailable = () =>
  new BillingError({
    code: "unavailable",
    message: "Managed environment capacity is temporarily unavailable",
  });
const publicReservation = (row: ReservationRow): ManagedReservation => ({
  userId: row.user_id,
  environmentId: row.environment_id,
  generation: row.generation,
  accountGeneration: row.account_generation,
  state: row.state === "active" ? "active" : "pending",
});

const disabled = ManagedReservations.of({
  get: () => Effect.succeed(null),
  reserve: () => Effect.succeed(null),
  complete: () => Effect.succeed(true),
  release: () => Effect.succeed(true),
});

export const make = (config: {
  readonly enabled: boolean;
  readonly enforcementUsers?: ReadonlyArray<string> | undefined;
}) =>
  Effect.gen(function* () {
    if (!config.enabled) return disabled;
    const { $client: sql } = yield* RelayDb;
    const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
    const transaction = <A>(effect: Effect.Effect<A, BillingError>) =>
      sql
        .withTransaction(effect)
        .pipe(Effect.mapError((cause) => (isBillingError(cause) ? cause : unavailable())));
    const lock = (userId: string) =>
      query(
        sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE user_id=${userId} FOR UPDATE`,
      ).pipe(Effect.map((rows) => rows[0]));
    return ManagedReservations.of({
      get: Effect.fn("ManagedReservations.get")(function* (input) {
        if (
          config.enforcementUsers &&
          !config.enforcementUsers.includes("*") &&
          !config.enforcementUsers.includes(input.userId)
        )
          return null;
        const row = (yield* query(
          sql<ReservationRow>`SELECT * FROM relay_managed_reservations WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND enabled=true`,
        ))[0];
        return row ? publicReservation(row) : null;
      }),
      reserve: Effect.fn("ManagedReservations.reserve")(function* (input) {
        if (
          config.enforcementUsers &&
          !config.enforcementUsers.includes("*") &&
          !config.enforcementUsers.includes(input.userId)
        )
          return null;
        return yield* transaction(
          Effect.gen(function* () {
            const account = yield* lock(input.userId);
            const time = yield* now;
            const access = effectiveAccountAccess(account, time);
            if (!access.available) return yield* unavailable();
            if (!access.allowed)
              return yield* new BillingError({
                code: "subscription_required",
                message: "An active Connect subscription is required",
              });
            // A retired tunnel is never reused while an external teardown is in progress,
            // including after resubscription. The worker preserves the hostname for recovery.
            const retiring = yield* query(
              sql`SELECT tunnel_id FROM relay_managed_suspensions WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND completed_at IS NULL LIMIT 1`,
            );
            if (retiring.length > 0) return yield* unavailable();
            const existing = (yield* query(
              sql<ReservationRow>`SELECT * FROM relay_managed_reservations WHERE user_id=${input.userId} AND environment_id=${input.environmentId}`,
            ))[0];
            if (!existing?.enabled) {
              // Legacy allocations without a reservation count, including incomplete/offline hosts.
              // An explicit disabled reservation supersedes its retained legacy allocation.
              const used =
                (yield* query(sql<{ count: number }>`SELECT count(*)::integer AS count FROM (
            SELECT environment_id FROM relay_managed_reservations WHERE user_id=${input.userId} AND enabled=true AND environment_id<>${input.environmentId}
            UNION
            SELECT environment_id FROM relay_managed_endpoint_allocations AS allocation WHERE user_id=${input.userId} AND environment_id<>${input.environmentId} AND NOT EXISTS (SELECT 1 FROM relay_managed_reservations AS reservation WHERE reservation.user_id=allocation.user_id AND reservation.environment_id=allocation.environment_id)
          ) AS capacity`))[0]?.count ?? 0;
              if (used >= access.limit)
                return yield* new BillingError({
                  code: "quota",
                  message: `Your ${access.limit} managed environment slots are in use. Disable one to connect another.`,
                });
            }
            const rows =
              yield* query(sql<ReservationRow>`INSERT INTO relay_managed_reservations(user_id,environment_id,generation,account_generation,enabled,state,updated_at)
          VALUES (${input.userId},${input.environmentId},1,${account!.generation},true,'pending',${time})
          ON CONFLICT(user_id,environment_id) DO UPDATE SET generation=relay_managed_reservations.generation+1,account_generation=${account!.generation},enabled=true,state='pending',updated_at=${time} RETURNING *`);
            return publicReservation(rows[0]!);
          }),
        );
      }),
      complete: Effect.fn("ManagedReservations.complete")(function* (reservation) {
        if (!reservation) return true;
        return yield* transaction(
          Effect.gen(function* () {
            const account = yield* lock(reservation.userId);
            const time = yield* now;
            if (!allowed(account, time) || account!.generation !== reservation.accountGeneration)
              return false;
            // Reuse the capacity slot, but fence each new provisioning attempt.
            const rows = yield* query(
              sql`UPDATE relay_managed_reservations SET state='active',updated_at=${time} WHERE user_id=${reservation.userId} AND environment_id=${reservation.environmentId} AND generation=${reservation.generation} AND account_generation=${reservation.accountGeneration} AND enabled=true RETURNING environment_id`,
            );
            return rows.length === 1;
          }),
        );
      }),
      release: Effect.fn("ManagedReservations.release")(function* (input) {
        return yield* transaction(
          Effect.gen(function* () {
            const account = yield* lock(input.userId);
            if (!account) return false;
            const time = yield* now;
            const current = (yield* query(
              sql<ReservationRow>`SELECT * FROM relay_managed_reservations WHERE user_id=${input.userId} AND environment_id=${input.environmentId}`,
            ))[0];
            if (input.generation !== undefined && current?.generation !== input.generation)
              return false;
            if (current && !current.enabled) return true;
            yield* query(sql`INSERT INTO relay_managed_reservations(user_id,environment_id,generation,account_generation,enabled,state,updated_at)
          VALUES (${input.userId},${input.environmentId},1,${account.generation},false,'disabled',${time})
          ON CONFLICT(user_id,environment_id) DO UPDATE SET generation=relay_managed_reservations.generation+1,enabled=false,state='disabled',updated_at=${time}`);
            return true;
          }),
        );
      }),
    });
  });
export function layer(config: { readonly enabled: false }): Layer.Layer<ManagedReservations>;
export function layer(config: {
  readonly enabled: boolean;
  readonly enforcementUsers?: ReadonlyArray<string> | undefined;
}): Layer.Layer<ManagedReservations, never, RelayDb>;
export function layer(config: {
  readonly enabled: boolean;
  readonly enforcementUsers?: ReadonlyArray<string> | undefined;
}) {
  return config.enabled
    ? Layer.effect(ManagedReservations, make(config))
    : Layer.succeed(ManagedReservations, disabled);
}
