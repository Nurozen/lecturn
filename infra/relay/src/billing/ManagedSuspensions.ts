import { Clock, Effect, Schema } from "effect";
import { RelayDb } from "../db.ts";
import { effectiveAccountAccess } from "./BillingGrants.ts";
import { BillingError, type BillingAccount } from "./BillingStore.ts";

/** Imported by the billing migration runner; retained rows are resource retirement receipts. */
export const managedSuspensionsMigration = `CREATE TABLE IF NOT EXISTS relay_managed_suspensions (
  tunnel_id text PRIMARY KEY, user_id text NOT NULL, environment_id text NOT NULL,
  account_generation integer NOT NULL, reservation_generation integer,
  stage text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  retry_at bigint NOT NULL DEFAULT 0, created_at bigint NOT NULL,
  completed_at bigint, last_error text
);
CREATE TABLE IF NOT EXISTS relay_billing_enforcement_control (
  id integer PRIMARY KEY CHECK (id=1), enabled boolean NOT NULL DEFAULT false, epoch integer NOT NULL DEFAULT 0
);
INSERT INTO relay_billing_enforcement_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_relay_managed_suspensions_pending ON relay_managed_suspensions(user_id,environment_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_relay_managed_suspensions_retry ON relay_managed_suspensions(retry_at) WHERE completed_at IS NULL`;
export interface SuspensionJob {
  tunnel_id: string;
  user_id: string;
  environment_id: string;
  account_generation: number;
  reservation_generation: number | null;
  stage: string;
  attempts: number;
}
export interface SuspensionProvider {
  readonly rotate: (tunnelId: string) => Effect.Effect<void, BillingError>;
  readonly disconnect: (tunnelId: string) => Effect.Effect<void, BillingError>;
  readonly remove: (tunnelId: string) => Effect.Effect<void, BillingError>;
}
/** No provider response bodies or credentials enter logs or persistence. */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const cloudflareSuspensionProvider = (config: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}): SuspensionProvider => {
  const request = (tunnelId: string, method: string, suffix = "", body?: object) =>
    Effect.tryPromise({
      try: async () => {
        const response = await (config.fetch ?? globalThis.fetch)(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}${suffix}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${config.apiToken}`,
              "Content-Type": "application/json",
            },
            ...(body ? { body: encodeJson(body) } : {}),
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (response.status === 404) return;
        if (!response.ok) throw new Error("Provider request failed");
        const data = (await response.json()) as { success?: boolean };
        if (data.success !== true) throw new Error("Provider rejected request");
      },
      catch: () =>
        new BillingError({
          code: "unavailable",
          message: "Tunnel retirement provider request failed",
        }),
    });
  return {
    rotate: (id) =>
      Effect.suspend(() => {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        return request(id, "PATCH", "", { tunnel_secret: btoa(String.fromCharCode(...bytes)) });
      }),
    disconnect: (id) => request(id, "DELETE", "/connections"),
    remove: (id) => request(id, "DELETE"),
  };
};

/** Each successful stage is durable; retries target the retired ID, never the current allocation. */
export const runSuspensionJob = (
  job: SuspensionJob,
  hooks: {
    readonly enabled: () => Effect.Effect<boolean, BillingError>;
    readonly checkpoint: (stage: string) => Effect.Effect<void, BillingError>;
    readonly finish: () => Effect.Effect<void, BillingError>;
    readonly provider: SuspensionProvider;
  },
) =>
  Effect.gen(function* () {
    const stages = ["rotating", "rotated", "disconnected", "deleted"];
    let position = stages.indexOf(job.stage);
    if (position < 0) return;
    const operations = [hooks.provider.rotate, hooks.provider.disconnect, hooks.provider.remove];
    while (position < operations.length) {
      if (!(yield* hooks.enabled())) return;
      yield* operations[position]!(job.tunnel_id);
      yield* hooks.checkpoint(stages[position + 1]!);
      position++;
    }
    if (yield* hooks.enabled()) yield* hooks.finish();
  });

const currentTime = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
const unavailable = () =>
  new BillingError({ code: "unavailable", message: "Tunnel retirement storage is unavailable" });

export const makeManagedSuspensions = (config: {
  /** Evaluate at every external boundary; observe/rollback must return false. */
  readonly enabled: () => Effect.Effect<boolean, BillingError>;
  readonly provider: SuspensionProvider;
  readonly enforcementUsers?: ReadonlyArray<string> | undefined;
}) =>
  Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
    const drain = Effect.fn("ManagedSuspensions.drain")(function* () {
      if (!(yield* config.enabled())) return;
      const control = (yield* query(
        sql<{
          enabled: boolean;
          epoch: number;
        }>`SELECT enabled,epoch FROM relay_billing_enforcement_control WHERE id=1`,
      ))[0];
      if (!control?.enabled) return;
      const stillEnabled = () =>
        Effect.gen(function* () {
          if (!(yield* config.enabled())) return false;
          const row = (yield* query(
            sql<{
              enabled: boolean;
              epoch: number;
            }>`SELECT enabled,epoch FROM relay_billing_enforcement_control WHERE id=1`,
          ))[0];
          return row?.enabled === true && row.epoch === control.epoch;
        });
      const now = yield* currentTime;
      // A stale projection is uncertainty, never permission to destroy a running environment.
      yield* query(sql`INSERT INTO relay_managed_suspensions(tunnel_id,user_id,environment_id,account_generation,reservation_generation,created_at)
      SELECT allocation.tunnel_id,allocation.user_id,allocation.environment_id,account.generation,reservation.generation,${now}
      FROM relay_managed_endpoint_allocations allocation JOIN relay_billing_accounts account ON account.user_id=allocation.user_id
      LEFT JOIN relay_managed_reservations reservation ON reservation.user_id=allocation.user_id AND reservation.environment_id=allocation.environment_id
      WHERE allocation.tunnel_id IS NOT NULL AND (account.deleted_at IS NOT NULL OR
      ((${config.enforcementUsers === undefined || config.enforcementUsers.includes("*")} OR ${encodeJson(config.enforcementUsers ?? [])}::jsonb ? account.user_id) AND
      (COALESCE((account.state->>'suspended')::boolean,false) OR
      (account.updated_at>${now - 900} AND account.updated_at<=${now} AND COALESCE((account.state->>'accessUntil')::numeric,0)<=${now}
      AND NOT (COALESCE((account.state->'grant'->>'start')::numeric,${now + 1})<=${now}
      AND COALESCE((account.state->'grant'->>'end')::numeric,0)>${now}
      AND COALESCE((account.state->'grant'->>'limit')::numeric,0)>=3)))))
      ON CONFLICT(tunnel_id) DO NOTHING`);
      const jobs = yield* query(
        sql<SuspensionJob>`SELECT * FROM relay_managed_suspensions WHERE completed_at IS NULL AND retry_at<=${now} ORDER BY created_at LIMIT 10`,
      );
      for (const candidate of jobs) {
        if (!(yield* stillEnabled())) return;
        const job = yield* query(
          sql.withTransaction(
            Effect.gen(function* () {
              const account =
                (yield* sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE user_id=${candidate.user_id} FOR UPDATE`)[0];
              const current =
                (yield* sql<SuspensionJob>`SELECT * FROM relay_managed_suspensions WHERE tunnel_id=${candidate.tunnel_id} AND completed_at IS NULL AND retry_at<=${now} FOR UPDATE`)[0];
              if (!current || !account) return null;
              if (
                account.deleted_at === null &&
                config.enforcementUsers &&
                !config.enforcementUsers.includes("*") &&
                !config.enforcementUsers.includes(current.user_id)
              )
                return null;
              if (current.stage === "pending") {
                const access = effectiveAccountAccess(account, now);
                if (access.allowed || !access.available) {
                  // A restored subscription or operator grant cancels only work that has not started.
                  if (access.allowed)
                    yield* sql`DELETE FROM relay_managed_suspensions WHERE tunnel_id=${current.tunnel_id}`;
                  return null;
                }
                yield* sql`UPDATE relay_billing_accounts SET generation=generation+1 WHERE user_id=${current.user_id}`;
                // Even observe-mode recovery cannot reuse this tunnel while retirement is paused.
                // Provision uses the stored name; old jobs retain only the old resource ID.
                yield* sql`UPDATE relay_managed_endpoint_allocations SET tunnel_name='lecturn-recovery-' || md5(tunnel_id),updated_at=clock_timestamp()::text WHERE user_id=${current.user_id} AND environment_id=${current.environment_id} AND tunnel_id=${current.tunnel_id}`;
              }
              yield* sql`UPDATE relay_managed_suspensions SET stage=CASE WHEN stage='pending' THEN 'rotating' ELSE stage END,retry_at=${now + 120},attempts=attempts+1 WHERE tunnel_id=${current.tunnel_id}`;
              return {
                ...current,
                stage: current.stage === "pending" ? "rotating" : current.stage,
              };
            }),
          ),
        );
        if (!job) continue;
        yield* runSuspensionJob(job, {
          enabled: stillEnabled,
          provider: config.provider,
          checkpoint: (stage) =>
            query(
              sql`UPDATE relay_managed_suspensions SET stage=${stage} WHERE tunnel_id=${job.tunnel_id}`,
            ).pipe(Effect.asVoid),
          finish: () =>
            query(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`SELECT user_id FROM relay_billing_accounts WHERE user_id=${job.user_id} FOR UPDATE`;
                  // Retain hostname/DNS so the next provision repoints the same endpoint to a new tunnel.
                  yield* sql`UPDATE relay_managed_endpoint_allocations SET tunnel_id=NULL,ready_at=NULL WHERE user_id=${job.user_id} AND environment_id=${job.environment_id} AND tunnel_id=${job.tunnel_id}`;
                  if (job.reservation_generation !== null)
                    yield* sql`UPDATE relay_managed_reservations SET enabled=false,state='disabled',generation=generation+1,updated_at=${now} WHERE user_id=${job.user_id} AND environment_id=${job.environment_id} AND generation=${job.reservation_generation}`;
                  yield* sql`UPDATE relay_managed_suspensions SET completed_at=${now},last_error=NULL WHERE tunnel_id=${job.tunnel_id}`;
                }),
              ),
            ),
        }).pipe(
          Effect.catch((error) =>
            query(
              sql`UPDATE relay_managed_suspensions SET last_error=${error.message},retry_at=${now + Math.min(3600, 60 * 2 ** Math.min(job.attempts, 6))} WHERE tunnel_id=${job.tunnel_id}`,
            ).pipe(Effect.asVoid),
          ),
        );
      }
    });
    return { drain };
  });
