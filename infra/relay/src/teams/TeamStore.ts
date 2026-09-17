import { Clock, Context, Effect, Schema } from "effect";
import type { RelayTeamPolicy } from "@lecturn/contracts";
import { operationId } from "../billing/BillingStore.ts";
import { RelayDb } from "../db.ts";

export class TeamError extends Schema.TaggedErrorClass<TeamError>()("TeamError", {
  code: Schema.Literals([
    "not_found",
    "forbidden",
    "subscription_required",
    "quota",
    "conflict",
    "unavailable",
  ]),
  message: Schema.String,
}) {}
export interface TeamAccount {
  organization_id: string;
  owner_user_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  purchased_seats: number;
  access_until: number | null;
  access_window_start: number | null;
  interval: "month" | "year" | null;
  current_period_end: number | null;
  pending_seats: number | null;
  policy: RelayTeamPolicy;
  generation: number;
  billing_lease_owner: string | null;
  billing_state: Record<string, unknown>;
  status: string;
  suspended: boolean;
  reconcile_after: number;
  billing_lease_expires_at: number;
  created_at: number;
  updated_at: number;
}
export interface TeamSeat {
  organization_id: string;
  user_id: string;
  assigned_at: number;
}
export interface TeamFunding {
  organization_id: string;
  user_id: string;
  environment_id: string;
  created_at: number;
}
export interface TeamAudit {
  id: string;
  organization_id: string;
  actor_user_id: string;
  action: string;
  subject_id: string | null;
  created_at: number;
}
export interface TeamActor {
  organizationId: string;
  actorUserId: string;
}
export interface SeatInput extends TeamActor {
  userId: string;
}
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
const unavailable = () =>
  new TeamError({ code: "unavailable", message: "Team service is temporarily unavailable" });
export const teamHasAccess = (account: TeamAccount, time: number) =>
  !account.suspended &&
  account.purchased_seats > 0 &&
  (account.access_until ?? 0) > time &&
  (account.access_window_start ?? 0) <= time;

/** Raw PgClient bigint values are decimal strings; Drizzle's number mode does not apply. */
export type TeamDatabaseRow<T> = {
  [K in keyof T]: T[K] extends number | null ? T[K] | string : T[K];
};
const teamNumericFields = new Set([
  "purchased_seats",
  "access_until",
  "access_window_start",
  "current_period_end",
  "pending_seats",
  "generation",
  "reconcile_after",
  "billing_lease_expires_at",
  "created_at",
  "updated_at",
  "assigned_at",
]);
export function decodeTeamDatabaseRow<T>(row: TeamDatabaseRow<T>): T {
  const result = { ...row };
  for (const key of Object.keys(result) as Array<keyof T & string>) {
    if (!teamNumericFields.has(key) || result[key] === null) continue;
    const value = result[key];
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !/^-?\d+$/.test(value)) ||
      !Number.isSafeInteger(Number(value))
    )
      throw unavailable();
    Object.assign(result, { [key]: Number(value) });
  }
  return result as T;
}

export const decodeTeamDatabaseRowEffect = <T>(row: TeamDatabaseRow<T>) =>
  Effect.try({ try: () => decodeTeamDatabaseRow<T>(row), catch: unavailable });

/** Callers authorize live Clerk membership before every organization operation. */
export const makeTeamStore = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
  const transaction = <A>(effect: Effect.Effect<A, TeamError>) =>
    sql
      .withTransaction(effect)
      .pipe(Effect.mapError((error) => (Schema.is(TeamError)(error) ? error : unavailable())));
  const get = (organizationId: string) =>
    query(
      sql<
        TeamDatabaseRow<TeamAccount>
      >`SELECT * FROM relay_team_accounts WHERE organization_id=${organizationId}`,
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] ? decodeTeamDatabaseRowEffect<TeamAccount>(rows[0]) : Effect.succeed(null),
      ),
    );
  const lock = Effect.fn("TeamStore.lock")(function* (
    organizationId: string,
    ignoreBillingLease = false,
  ) {
    const row = (yield* query(
      sql<
        TeamDatabaseRow<TeamAccount>
      >`SELECT * FROM relay_team_accounts WHERE organization_id=${organizationId} FOR UPDATE`,
    ))[0];
    if (!row) return yield* new TeamError({ code: "not_found", message: "Organization not found" });
    const account = yield* decodeTeamDatabaseRowEffect<TeamAccount>(row);
    if (!ignoreBillingLease && account.billing_lease_expires_at > (yield* now))
      return yield* new TeamError({
        code: "conflict",
        message: "A billing update is in progress. Please retry shortly",
      });
    return account;
  });
  const audit = Effect.fn("TeamStore.audit")(function* (
    input: TeamActor & { action: string; subjectId?: string },
  ) {
    const time = yield* now;
    yield* query(
      sql`INSERT INTO relay_team_audit(id,organization_id,actor_user_id,action,subject_id,created_at) VALUES (${yield* operationId},${input.organizationId},${input.actorUserId},${input.action},${input.subjectId ?? null},${time})`,
    );
  });
  const seats = (organizationId: string) =>
    query(
      sql<
        TeamDatabaseRow<TeamSeat>
      >`SELECT * FROM relay_team_seats WHERE organization_id=${organizationId} ORDER BY assigned_at,user_id`,
    ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeTeamDatabaseRowEffect<TeamSeat>)));
  const userDeleted = (userId: string) =>
    query(sql`SELECT user_id FROM relay_team_deleted_users WHERE user_id=${userId}`).pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const requireExistingUser = Effect.fn("TeamStore.requireExistingUser")(function* (
    userId: string,
  ) {
    if (yield* userDeleted(userId))
      return yield* new TeamError({ code: "forbidden", message: "This account was deleted." });
  });
  const funding = (userId: string, environmentId: string) =>
    query(
      sql<
        TeamDatabaseRow<TeamFunding>
      >`SELECT * FROM relay_team_environment_funding WHERE user_id=${userId} AND environment_id=${environmentId}`,
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] ? decodeTeamDatabaseRowEffect<TeamFunding>(rows[0]) : Effect.succeed(null),
      ),
    );
  return {
    get,
    seats,
    markUserDeleted: (userId: string) =>
      transaction(
        Effect.gen(function* () {
          const time = yield* now;
          yield* query(
            sql`INSERT INTO relay_team_deleted_users(user_id,deleted_at) VALUES (${userId},${time}) ON CONFLICT DO NOTHING`,
          );
          // Fence in-flight billing saves before attempting any remote cancellation.
          const owned = yield* query(
            sql<{
              organization_id: string;
            }>`UPDATE relay_team_accounts SET status='deleted',suspended=true,purchased_seats=0,access_until=NULL,pending_seats=NULL,generation=generation+1,updated_at=${time} WHERE owner_user_id=${userId} RETURNING organization_id`,
          );
          const removed = yield* query(
            sql<{
              organization_id: string;
            }>`DELETE FROM relay_team_seats WHERE user_id=${userId} RETURNING organization_id`,
          );
          for (const seat of removed)
            yield* audit({
              organizationId: seat.organization_id,
              actorUserId: "clerk-webhook",
              action: "seat.revoked",
              subjectId: userId,
            });
          const affected = yield* query(
            sql<{
              user_id: string;
            }>`SELECT DISTINCT funding.user_id FROM relay_team_environment_funding funding JOIN relay_team_accounts account ON account.organization_id=funding.organization_id WHERE account.owner_user_id=${userId}`,
          );
          return {
            ownedOrganizationIds: owned.map((row) => row.organization_id),
            affectedUserIds: [...new Set([userId, ...affected.map((row) => row.user_id)])],
          };
        }),
      ),
    audit,
    funding: (userId: string, environmentId: string) =>
      funding(userId, environmentId).pipe(
        Effect.map((row) =>
          row
            ? {
                organizationId: row.organization_id,
                userId: row.user_id,
                environmentId: row.environment_id,
              }
            : undefined,
        ),
      ),
    access: Effect.fn("TeamStore.access")(function* (
      userId: string,
      environmentId: string,
      time: number,
    ) {
      const row = yield* funding(userId, environmentId);
      if (!row) return undefined;
      const account = yield* get(row.organization_id);
      const assigned = account
        ? (yield* seats(row.organization_id)).find((seat) => seat.user_id === userId)
        : undefined;
      return {
        organizationId: row.organization_id,
        allowed:
          !!account && !!assigned && !(yield* userDeleted(userId)) && teamHasAccess(account, time),
        validUntil: account?.access_until ?? 0,
        windowStart: Math.max(account?.access_window_start ?? 0, assigned?.assigned_at ?? 0),
        policy: account?.policy ?? { allowedProviders: [], publishAgentActivity: false },
        generation: account?.generation ?? 0,
      };
    }),
    bootstrap: Effect.fn("TeamStore.bootstrap")(function* (input: {
      organizationId: string;
      ownerUserId: string;
    }) {
      yield* requireExistingUser(input.ownerUserId);
      const time = yield* now;
      yield* query(
        sql`INSERT INTO relay_team_accounts(organization_id,owner_user_id,created_at,updated_at) VALUES (${input.organizationId},${input.ownerUserId},${time},${time}) ON CONFLICT DO NOTHING`,
      );
      return yield* get(input.organizationId);
    }),
    assignSeat: (input: SeatInput) =>
      transaction(
        Effect.gen(function* () {
          const account = yield* lock(input.organizationId);
          yield* requireExistingUser(input.userId);
          if (!teamHasAccess(account, yield* now))
            return yield* new TeamError({
              code: "subscription_required",
              message: "An active Teams subscription is required",
            });
          const assigned = yield* seats(input.organizationId);
          if (assigned.some((seat) => seat.user_id === input.userId)) return;
          const capacity = Math.min(
            account.purchased_seats,
            account.pending_seats ?? account.purchased_seats,
          );
          if (assigned.length >= capacity)
            return yield* new TeamError({
              code: "quota",
              message: "All purchased seats are assigned",
            });
          yield* query(
            sql`INSERT INTO relay_team_seats(organization_id,user_id,assigned_at) VALUES (${input.organizationId},${input.userId},${yield* now})`,
          );
          yield* audit({ ...input, action: "seat.assigned", subjectId: input.userId });
        }),
      ),
    revokeSeat: (input: SeatInput) =>
      transaction(
        Effect.gen(function* () {
          yield* lock(input.organizationId, true);
          yield* query(
            sql`DELETE FROM relay_team_seats WHERE organization_id=${input.organizationId} AND user_id=${input.userId}`,
          );
          const affected = yield* query(
            sql<{
              environment_id: string;
            }>`SELECT environment_id FROM relay_team_environment_funding WHERE organization_id=${input.organizationId} AND user_id=${input.userId}`,
          );
          // Retain funding provenance so removing a seat cannot fall back to personal access.
          yield* audit({ ...input, action: "seat.revoked", subjectId: input.userId });
          return affected.map((row) => row.environment_id);
        }),
      ),
    bindEnvironment: (input: SeatInput & { environmentId: string; proofVerified: true }) =>
      transaction(
        Effect.gen(function* () {
          const account = yield* lock(input.organizationId);
          yield* requireExistingUser(input.userId);
          if (input.actorUserId !== input.userId)
            return yield* new TeamError({
              code: "forbidden",
              message: "Only the environment owner can select its funding",
            });
          if (
            !teamHasAccess(account, yield* now) ||
            !(yield* seats(input.organizationId)).some((seat) => seat.user_id === input.userId)
          )
            return yield* new TeamError({
              code: "subscription_required",
              message: "An active assigned Teams seat is required",
            });
          const existing = yield* funding(input.userId, input.environmentId);
          if (existing?.organization_id === input.organizationId) return;
          if (existing)
            return yield* new TeamError({
              code: "conflict",
              message: "Remove existing company funding before changing organizations",
            });
          const links = yield* query(
            sql`SELECT user_id FROM relay_environment_links WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND revoked_at IS NULL`,
          );
          if (links.length)
            return yield* new TeamError({
              code: "conflict",
              message: "Unlink your personal environment before publishing it with company funding",
            });
          const funded = yield* query(
            sql`SELECT environment_id FROM relay_team_environment_funding WHERE organization_id=${input.organizationId} AND user_id=${input.userId}`,
          );
          if (funded.length >= 3)
            return yield* new TeamError({
              code: "quota",
              message: "Your Teams seat includes three managed environments",
            });
          yield* query(
            sql`INSERT INTO relay_team_environment_funding(user_id,environment_id,organization_id,created_at) VALUES (${input.userId},${input.environmentId},${input.organizationId},${yield* now})`,
          );
          yield* audit({ ...input, action: "environment.funded", subjectId: input.environmentId });
        }),
      ),
    unbindEnvironment: (input: SeatInput & { environmentId: string }) =>
      transaction(
        Effect.gen(function* () {
          yield* lock(input.organizationId);
          if (input.actorUserId !== input.userId)
            return yield* new TeamError({
              code: "forbidden",
              message: "Only the environment owner can remove its funding",
            });
          const links = yield* query(
            sql`SELECT user_id FROM relay_environment_links WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND revoked_at IS NULL`,
          );
          if (links.length)
            return yield* new TeamError({
              code: "conflict",
              message: "Unlink the environment before removing company funding",
            });
          yield* query(
            sql`DELETE FROM relay_team_environment_funding WHERE organization_id=${input.organizationId} AND user_id=${input.userId} AND environment_id=${input.environmentId}`,
          );
          yield* audit({
            ...input,
            action: "environment.unfunded",
            subjectId: input.environmentId,
          });
        }),
      ),
    updatePolicy: (input: TeamActor & { policy: RelayTeamPolicy }) =>
      transaction(
        Effect.gen(function* () {
          yield* lock(input.organizationId);
          yield* query(
            sql`UPDATE relay_team_accounts SET policy=${encodeJson(input.policy)}::jsonb,generation=generation+1,updated_at=${yield* now} WHERE organization_id=${input.organizationId}`,
          );
          yield* audit({ ...input, action: "policy.updated" });
        }),
      ),
    inventory: (organizationId: string) =>
      query(
        sql<{
          user_id: string;
          environment_id: string;
          name: string;
          status: "linked" | "unlinked";
        }>`SELECT f.user_id,f.environment_id,COALESCE(l.environment_label,'Unlinked environment') AS name,CASE WHEN l.user_id IS NOT NULL AND l.revoked_at IS NULL THEN 'linked' ELSE 'unlinked' END AS status FROM relay_team_environment_funding f LEFT JOIN relay_environment_links l ON l.user_id=f.user_id AND l.environment_id=f.environment_id WHERE f.organization_id=${organizationId}`,
      ),
    history: (organizationId: string) =>
      query(
        sql<
          TeamDatabaseRow<TeamAudit>
        >`SELECT * FROM relay_team_audit WHERE organization_id=${organizationId} ORDER BY created_at DESC,id DESC LIMIT 100`,
      ).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, decodeTeamDatabaseRowEffect<TeamAudit>)),
      ),
  };
});
export class TeamStore extends Context.Service<TeamStore, Effect.Success<typeof makeTeamStore>>()(
  "lecturn-relay/teams/TeamStore",
) {}
