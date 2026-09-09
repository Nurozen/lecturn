import { Clock, DateTime, Effect } from "effect";
import { RelayDb } from "../db.ts";
import { BillingError, type BillingAccount } from "./BillingStore.ts";
import { effectiveAccountAccess } from "./BillingGrants.ts";
import type { GatewaySnapshot } from "./ManagedGateway.ts";

export interface ManagedGatewayMapping {
  userId: string;
  environmentId: string;
  publicHostname: string;
  originHostname: string;
  originDnsRecordId?: string | null | undefined;
  ready: boolean;
  deleting: boolean;
  generation: number;
}
export type ManagedGatewayAllocationCheckpoint = {
  userId: string;
  environmentId: string;
  generation: number;
} & (
  | { step: "tunnel"; tunnelId: string }
  | { step: "dns"; dnsRecordId: string }
  | { step: "ready" }
);
export interface ManagedGatewayStoreConfig {
  enabled: boolean;
  guardVerified: boolean;
  enforcementUsers: readonly string[];
  stage: string;
  baseDomain: string;
}
const invalid = (message: string) => new BillingError({ code: "invalid", message });
const unavailable = () =>
  new BillingError({ code: "persistence", message: "Gateway state is unavailable" });
const now = Clock.currentTimeMillis;
const validId = (id: string) => id.length > 0 && id.length <= 255 && id.trim() === id;
const hostname = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const inCohort = (config: ManagedGatewayStoreConfig, userId: string) =>
  config.enforcementUsers.includes("*") || config.enforcementUsers.includes(userId);

/** Private service methods only. Never enroll an existing direct-tunnel hostname. */
export const makeManagedGatewayStore = (config: ManagedGatewayStoreConfig) =>
  Effect.gen(function* () {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.stage) || !hostname.test(config.baseDomain))
      return yield* invalid("Gateway stage and base domain must be explicit lowercase DNS names");
    const { $client: sql } = yield* RelayDb;
    const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
    const columns = sql`user_id AS "userId",environment_id AS "environmentId",public_hostname AS "publicHostname",origin_hostname AS "originHostname",origin_dns_record_id AS "originDnsRecordId",ready,deleting,generation::double precision AS generation`;
    const lock = Effect.fn("ManagedGatewayStore.lock")(function* (userId: string) {
      if (!validId(userId)) return yield* invalid("Invalid gateway owner");
      yield* query(
        sql`INSERT INTO relay_managed_gateway_accounts(user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`,
      );
      return (yield* query(
        sql<{
          generation: number;
        }>`SELECT generation FROM relay_managed_gateway_accounts WHERE user_id=${userId} FOR UPDATE`,
      ))[0]!;
    });
    const validateMapping = (
      mapping: Omit<ManagedGatewayMapping, "ready" | "generation" | "deleting">,
    ) => {
      const publicSuffix = `-g-${config.stage}`;
      const originPrefix = `gw-origin-${config.stage}-`;
      const suffix = `.${config.baseDomain}`;
      const validHost = (value: string, prefix: string) =>
        hostname.test(value) &&
        value.length <= 253 &&
        value.split(".").every((label) => label.length <= 63) &&
        value.endsWith(suffix) &&
        value.slice(0, -suffix.length).startsWith(prefix) &&
        !value.slice(0, -suffix.length).includes(".") &&
        value.slice(0, -suffix.length).length > prefix.length;
      return (
        validId(mapping.userId) &&
        validId(mapping.environmentId) &&
        hostname.test(mapping.publicHostname) &&
        mapping.publicHostname.length <= 253 &&
        mapping.publicHostname.split(".").every((label) => label.length <= 63) &&
        mapping.publicHostname.endsWith(`${publicSuffix}${suffix}`) &&
        !mapping.publicHostname.slice(0, -suffix.length).includes(".") &&
        mapping.publicHostname.slice(0, -suffix.length).length > publicSuffix.length &&
        validHost(mapping.originHostname, originPrefix) &&
        (mapping.originDnsRecordId == null || validId(mapping.originDnsRecordId))
      );
    };
    return {
      registerPending: Effect.fn("ManagedGatewayStore.registerPending")(function* (
        mapping: Omit<ManagedGatewayMapping, "ready" | "generation" | "deleting">,
      ) {
        if (!config.enabled || !inCohort(config, mapping.userId) || !validateMapping(mapping))
          return yield* invalid(
            "Gateway enrollment requires enabled cohort and new gateway hostnames",
          );
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const owner = yield* lock(mapping.userId);
            const prior = (yield* query(
              sql<ManagedGatewayMapping>`SELECT ${columns} FROM relay_managed_gateway_environments WHERE user_id=${mapping.userId} AND environment_id=${mapping.environmentId}`,
            ))[0];
            if (prior?.deleting)
              return yield* invalid("Gateway removal must finish before reenrollment");
            if (
              prior &&
              (prior.publicHostname !== mapping.publicHostname ||
                prior.originHostname !== mapping.originHostname)
            )
              return yield* invalid(
                "Existing gateway hostnames cannot be reassigned; remove the prior enrollment first",
              );
            const generation = Number(owner.generation) + 1;
            if (!Number.isSafeInteger(generation))
              return yield* invalid("Gateway generation exhausted");
            const rows = yield* query(
              sql<ManagedGatewayMapping>`INSERT INTO relay_managed_gateway_environments(user_id,environment_id,public_hostname,origin_hostname,origin_dns_record_id,ready,generation) VALUES (${mapping.userId},${mapping.environmentId},${mapping.publicHostname},${mapping.originHostname},${mapping.originDnsRecordId ?? null},false,${generation}) ON CONFLICT (user_id,environment_id) DO UPDATE SET origin_dns_record_id=COALESCE(EXCLUDED.origin_dns_record_id,relay_managed_gateway_environments.origin_dns_record_id),ready=false,generation=EXCLUDED.generation RETURNING ${columns}`,
            );
            yield* query(
              sql`UPDATE relay_managed_gateway_accounts SET next_sync_at=0,generation=${generation} WHERE user_id=${mapping.userId}`,
            );
            return rows[0]!;
          }),
        );
      }),
      markReady: Effect.fn("ManagedGatewayStore.markReady")(function* (
        mapping: Omit<ManagedGatewayMapping, "ready" | "deleting">,
      ) {
        if (
          !config.enabled ||
          !config.guardVerified ||
          !inCohort(config, mapping.userId) ||
          !validateMapping(mapping) ||
          !Number.isSafeInteger(mapping.generation) ||
          mapping.generation < 1
        )
          return yield* invalid("Verified origin guard required before gateway activation");
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(mapping.userId);
            const rows = yield* query(
              sql`UPDATE relay_managed_gateway_environments SET ready=true,origin_dns_record_id=COALESCE(${mapping.originDnsRecordId ?? null},origin_dns_record_id) WHERE user_id=${mapping.userId} AND environment_id=${mapping.environmentId} AND public_hostname=${mapping.publicHostname} AND origin_hostname=${mapping.originHostname} AND generation=${mapping.generation} AND deleting=false RETURNING user_id`,
            );
            yield* query(
              sql`UPDATE relay_managed_gateway_accounts SET next_sync_at=0 WHERE user_id=${mapping.userId}`,
            );
            return rows.length === 1;
          }),
        );
      }),
      recordOriginDns: Effect.fn("ManagedGatewayStore.recordOriginDns")(function* (input: {
        userId: string;
        environmentId: string;
        generation: number;
        originDnsRecordId: string;
      }) {
        if (!validId(input.originDnsRecordId) || !Number.isSafeInteger(input.generation))
          return yield* invalid("Invalid gateway DNS operation");
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(input.userId);
            const rows = yield* query(
              sql`UPDATE relay_managed_gateway_environments SET origin_dns_record_id=${input.originDnsRecordId} WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND generation=${input.generation} AND deleting=false RETURNING user_id`,
            );
            return rows.length === 1;
          }),
        );
      }),
      pause: Effect.fn("ManagedGatewayStore.pause")(function* (input: {
        userId: string;
        environmentId: string;
        generation: number;
      }) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const owner = yield* lock(input.userId);
            const generation = Number(owner.generation) + 1;
            if (!Number.isSafeInteger(generation))
              return yield* invalid("Gateway generation exhausted");
            const rows = yield* query(
              sql<ManagedGatewayMapping>`UPDATE relay_managed_gateway_environments SET ready=false,generation=${generation} WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND generation=${input.generation} AND deleting=false RETURNING ${columns}`,
            );
            if (rows.length)
              yield* query(
                sql`UPDATE relay_managed_gateway_accounts SET generation=${generation},next_sync_at=0 WHERE user_id=${input.userId}`,
              );
            return rows[0];
          }),
        );
      }),
      checkpointAllocation: Effect.fn("ManagedGatewayStore.checkpointAllocation")(function* (
        input: ManagedGatewayAllocationCheckpoint,
      ) {
        if (
          !Number.isSafeInteger(input.generation) ||
          input.generation < 1 ||
          (input.step === "tunnel" && !validId(input.tunnelId)) ||
          (input.step === "dns" && !validId(input.dnsRecordId))
        )
          return yield* invalid("Invalid gateway allocation checkpoint");
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(input.userId);
            const mapping = (yield* query(
              sql<ManagedGatewayMapping>`SELECT ${columns} FROM relay_managed_gateway_environments WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND generation=${input.generation} AND deleting=false`,
            ))[0];
            if (!mapping) return false;
            const timestamp = DateTime.formatIso(yield* DateTime.now);
            const rows =
              input.step === "tunnel"
                ? yield* query(
                    sql`UPDATE relay_managed_endpoint_allocations SET tunnel_id=${input.tunnelId},updated_at=${timestamp} WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND hostname=${mapping.publicHostname} RETURNING user_id`,
                  )
                : input.step === "dns"
                  ? yield* query(
                      sql`UPDATE relay_managed_endpoint_allocations SET dns_record_id=${input.dnsRecordId},updated_at=${timestamp} WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND hostname=${mapping.publicHostname} RETURNING user_id`,
                    )
                  : yield* query(
                      sql`UPDATE relay_managed_endpoint_allocations SET ready_at=${timestamp},updated_at=${timestamp} WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND hostname=${mapping.publicHostname} RETURNING user_id`,
                    );
            return rows.length === 1;
          }),
        );
      }),
      get: (userId: string, environmentId: string) =>
        query(
          sql<ManagedGatewayMapping>`SELECT ${columns} FROM relay_managed_gateway_environments WHERE user_id=${userId} AND environment_id=${environmentId}`,
        ).pipe(Effect.map((rows) => rows[0])),
      lookupPublicHostname: (publicHostname: string) =>
        query(
          sql<ManagedGatewayMapping>`SELECT ${columns} FROM relay_managed_gateway_environments WHERE public_hostname=${publicHostname} AND ready=true AND deleting=false`,
        ).pipe(Effect.map((rows) => rows[0])),
      remove: Effect.fn("ManagedGatewayStore.remove")(function* (
        userId: string,
        environmentId: string,
        originHostname: string,
        expectedGeneration: number,
      ) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(userId);
            const removed = yield* query(
              sql<ManagedGatewayMapping>`UPDATE relay_managed_gateway_environments SET deleting=true,ready=false WHERE user_id=${userId} AND environment_id=${environmentId} AND origin_hostname=${originHostname} AND generation=${expectedGeneration} RETURNING ${columns}`,
            );
            yield* query(
              sql`UPDATE relay_managed_gateway_accounts SET next_sync_at=0 WHERE user_id=${userId}`,
            );
            return removed[0];
          }),
        );
      }),
      finalizeRemove: Effect.fn("ManagedGatewayStore.finalizeRemove")(function* (input: {
        userId: string;
        environmentId: string;
        generation: number;
      }) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(input.userId);
            const rows = yield* query(
              sql`DELETE FROM relay_managed_gateway_environments WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND generation=${input.generation} AND deleting=true RETURNING user_id`,
            );
            yield* query(
              sql`UPDATE relay_managed_gateway_accounts SET next_sync_at=0 WHERE user_id=${input.userId}`,
            );
            return rows.length === 1;
          }),
        );
      }),
      capture: Effect.fn("ManagedGatewayStore.capture")(function* (userId: string) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* lock(userId);
            const time = yield* now;
            const account = (yield* query(
              sql<BillingAccount>`SELECT * FROM relay_billing_accounts WHERE user_id=${userId} FOR SHARE`,
            ))[0];
            const access = effectiveAccountAccess(account, Math.floor(time / 1000));
            const mappings = yield* query(
              sql<ManagedGatewayMapping>`SELECT ${columns} FROM relay_managed_gateway_environments WHERE user_id=${userId} AND ready=true AND deleting=false ORDER BY environment_id`,
            );
            const generation = Number(row.generation) + 1;
            if (!Number.isSafeInteger(generation))
              return yield* invalid("Gateway generation exhausted");
            yield* query(
              sql`UPDATE relay_managed_gateway_accounts SET generation=${generation} WHERE user_id=${userId}`,
            );
            const enabled = config.enabled && inCohort(config, userId);
            const deadline = access.validUntil === null ? null : access.validUntil * 1000;
            return {
              userId,
              generation,
              enabled,
              guardVerified: config.guardVerified,
              accessUntilMs:
                enabled &&
                config.guardVerified &&
                access.allowed &&
                Number.isSafeInteger(deadline) &&
                deadline! > time
                  ? deadline
                  : null,
              environments: mappings
                .filter(validateMapping)
                .map(({ environmentId, publicHostname, originHostname }) => ({
                  environmentId,
                  publicHostname,
                  originHostname,
                })),
            } satisfies GatewaySnapshot;
          }),
        );
      }),
      claimDue: Effect.fn("ManagedGatewayStore.claimDue")(function* (limit = 20) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          return yield* invalid("Gateway batch must contain 1 through 100 users");
        const time = yield* now;
        return yield* query(
          sql<{
            user_id: string;
          }>`WITH due AS (SELECT user_id FROM relay_managed_gateway_accounts WHERE next_sync_at<=${time} ORDER BY next_sync_at,user_id LIMIT ${limit} FOR UPDATE SKIP LOCKED) UPDATE relay_managed_gateway_accounts a SET next_sync_at=${time + 60000} FROM due WHERE a.user_id=due.user_id RETURNING a.user_id`,
        ).pipe(Effect.map((rows) => rows.map((row) => row.user_id)));
      }),
    };
  });
