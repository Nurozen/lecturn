import { Clock, Crypto, DateTime, Effect, Schema } from "effect";
import {
  DecisionEvaluationError,
  EnvironmentId,
  type DecisionFundingApprovalResult,
  type DecisionFundingChallengeResult,
  type DecisionFundingStatusResult,
} from "@lecturn/contracts";
import { RelayDb } from "../db.ts";
import type { EnvironmentCredentialPrincipal } from "../environments/EnvironmentCredentials.ts";
import { decisionError, decisionStorage, type DecisionsAccess } from "./DecisionsAccess.ts";

export interface DecisionFundingRecord {
  readonly environment_id: string;
  readonly public_key: string;
  readonly generation: number;
  readonly payer_id: string | null;
  readonly state: "active" | "revoked" | "unfunded";
}
interface Challenge {
  readonly id: string;
  readonly environment_id: string;
  readonly public_key: string;
  readonly generation: number;
  readonly expires_at: number;
  readonly payer_id: string | null;
  readonly redeemed_generation: number | null;
  readonly revoked: boolean;
}
export interface DecisionFundingConfig {
  readonly approvalOrigin: string;
  readonly challengeTtlSeconds?: number;
}
const isDecisionError = Schema.is(DecisionEvaluationError);
const nowSeconds = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
const iso = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

export const makeDecisionFundingStore = (access: DecisionsAccess, config: DecisionFundingConfig) =>
  Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    const crypto = yield* Crypto.Crypto;
    const ttl = config.challengeTtlSeconds ?? 600;
    const transaction = <A>(effect: Effect.Effect<A, DecisionEvaluationError>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.mapError((error) =>
            isDecisionError(error)
              ? error
              : decisionError("unavailable", "Decisions storage is temporarily unavailable"),
          ),
        );
    const assertHost = Effect.fn("DecisionFunding.assertHost")(function* (
      host: EnvironmentCredentialPrincipal,
    ) {
      const rows =
        yield* decisionStorage(sql`SELECT 1 FROM relay_environment_credentials c WHERE c.credential_id=${host.credentialId}
      AND c.environment_id=${host.environmentId} AND c.environment_public_key=${host.environmentPublicKey} AND c.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM relay_environment_links l WHERE l.environment_id=c.environment_id AND l.environment_public_key=c.environment_public_key AND l.revoked_at IS NULL)`);
      if (!rows.length)
        return yield* decisionError("forbidden", "Environment authorization is no longer valid");
    });
    const get = (environmentId: string) =>
      decisionStorage(
        sql<DecisionFundingRecord>`SELECT * FROM relay_decision_funding WHERE environment_id=${environmentId}`,
      ).pipe(Effect.map((rows) => rows[0]));
    const lock = Effect.fn("DecisionFunding.lock")(function* (
      host: EnvironmentCredentialPrincipal,
    ) {
      yield* decisionStorage(
        sql`INSERT INTO relay_decision_funding(environment_id,public_key,generation,state) VALUES (${host.environmentId},${host.environmentPublicKey},0,'unfunded') ON CONFLICT DO NOTHING`,
      );
      const rows = yield* decisionStorage(
        sql<DecisionFundingRecord>`SELECT * FROM relay_decision_funding WHERE environment_id=${host.environmentId} FOR UPDATE`,
      );
      return rows[0]!;
    });
    const loadChallenge = (id: string) =>
      decisionStorage(
        sql<Challenge>`SELECT id,environment_id,public_key,generation,expires_at::float8,payer_id,redeemed_generation,revoked FROM relay_decision_funding_challenges WHERE id=${id} FOR UPDATE`,
      ).pipe(Effect.map((rows) => rows[0]));
    const ensureGeneration = (row: DecisionFundingRecord, generation: number) =>
      row.generation === generation
        ? Effect.void
        : Effect.fail(decisionError("conflict", "Funding changed; refresh its status"));
    const wireStatus = Effect.fn("DecisionFunding.wireStatus")(function* (
      environmentId: string,
      row: DecisionFundingRecord | undefined,
      key?: string,
    ): Effect.fn.Return<DecisionFundingStatusResult, DecisionEvaluationError> {
      const belongs = row && (key === undefined || row.public_key === key);
      const eligibility =
        belongs && row.state === "active" && row.payer_id
          ? yield* access.status(row.payer_id)
          : null;
      const pending =
        belongs && row.state !== "active"
          ? yield* decisionStorage(
              sql`SELECT 1 FROM relay_decision_funding_challenges WHERE environment_id=${environmentId} AND generation=${row.generation} AND public_key=${row.public_key} AND revoked=false AND redeemed_generation IS NULL AND expires_at > ${yield* nowSeconds} LIMIT 1`,
            )
          : [];
      const account =
        belongs && row.payer_id
          ? yield* decisionStorage(
              sql<{
                decisions_account_label: string | null;
              }>`SELECT decisions_account_label FROM relay_billing_accounts WHERE user_id=${row.payer_id} AND deleted_at IS NULL`,
            )
          : [];
      return {
        environmentId: EnvironmentId.make(environmentId),
        state: !row ? "unfunded" : !belongs ? "revoked" : pending.length ? "pending" : row.state,
        generation: row?.generation ?? 0,
        accountLabel:
          belongs && row.payer_id
            ? (account[0]?.decisions_account_label ?? `Account ${row.payer_id}`).slice(0, 200)
            : null,
        eligible: eligibility?.eligible ?? false,
        allowance: null,
        remoteRevocationPending: false,
      };
    });
    const status = Effect.fn("DecisionFunding.status")(function* (
      host: EnvironmentCredentialPrincipal,
    ) {
      yield* assertHost(host);
      return yield* wireStatus(
        host.environmentId,
        yield* get(host.environmentId),
        host.environmentPublicKey,
      );
    });
    const requireFunding = Effect.fn("DecisionFunding.requireFunding")(function* (
      host: EnvironmentCredentialPrincipal,
      expectedGeneration: number,
    ) {
      yield* assertHost(host);
      const row = yield* get(host.environmentId);
      if (
        !row ||
        row.public_key !== host.environmentPublicKey ||
        row.state !== "active" ||
        !row.payer_id
      )
        return yield* decisionError(
          "forbidden",
          "This environment has no active Decisions funding",
        );
      yield* ensureGeneration(row, expectedGeneration);
      const eligibility = yield* access.status(row.payer_id);
      if (!eligibility.eligible)
        return yield* decisionError("forbidden", "Decisions requires an eligible paid account");
      return { funding: row, access: eligibility, payerId: row.payer_id };
    });
    const challenge = Effect.fn("DecisionFunding.challenge")(function* (
      host: EnvironmentCredentialPrincipal,
      expectedGeneration: number,
    ): Effect.fn.Return<DecisionFundingChallengeResult, DecisionEvaluationError> {
      if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 3600)
        return yield* decisionError("unavailable", "Decisions funding is unavailable");
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => decisionError("unavailable", "Decisions funding is unavailable")),
      );
      const expires = (yield* nowSeconds) + ttl;
      const generation = yield* transaction(
        Effect.gen(function* () {
          yield* assertHost(host);
          const row = yield* lock(host);
          yield* ensureGeneration(row, expectedGeneration);
          const generation =
            row.generation + (row.public_key === host.environmentPublicKey ? 0 : 1);
          if (row.public_key !== host.environmentPublicKey)
            yield* decisionStorage(
              sql`UPDATE relay_decision_funding SET public_key=${host.environmentPublicKey},generation=${generation},payer_id=NULL,state='revoked' WHERE environment_id=${host.environmentId}`,
            );
          yield* decisionStorage(
            sql`UPDATE relay_decision_funding_challenges SET revoked=true WHERE environment_id=${host.environmentId} AND redeemed_generation IS NULL`,
          );
          yield* decisionStorage(
            sql`INSERT INTO relay_decision_funding_challenges(id,environment_id,public_key,generation,expires_at) VALUES (${id},${host.environmentId},${host.environmentPublicKey},${generation},${expires})`,
          );
          return generation;
        }),
      );
      const url = new URL("/decisions/funding/approve", config.approvalOrigin);
      url.searchParams.set("challengeId", id);
      return { challengeId: id, generation, approvalUrl: url.toString(), expiresAt: iso(expires) };
    });
    const approvalInfo = Effect.fn("DecisionFunding.approvalInfo")(function* (
      payerId: string,
      challengeId: string,
    ) {
      const items = yield* decisionStorage(
        sql<Challenge>`SELECT id,environment_id,public_key,generation,expires_at::float8,payer_id,redeemed_generation,revoked FROM relay_decision_funding_challenges WHERE id=${challengeId}`,
      );
      const item = items[0];
      if (!item || item.revoked)
        return yield* decisionError("forbidden", "Funding approval is unavailable");
      if (item.expires_at <= (yield* nowSeconds))
        return yield* decisionError("expired", "Funding approval expired");
      if (item.payer_id && item.payer_id !== payerId)
        return yield* decisionError("conflict", "Funding approval belongs to another account");
      const binding = yield* get(item.environment_id);
      if (
        !binding ||
        binding.public_key !== item.public_key ||
        binding.generation !== (item.redeemed_generation ?? item.generation)
      )
        return yield* decisionError("conflict", "Funding changed; start a new approval");
      const labels = yield* decisionStorage(
        sql<{
          environment_label: string;
        }>`SELECT environment_label FROM relay_environment_links WHERE environment_id=${item.environment_id} AND environment_public_key=${item.public_key} AND revoked_at IS NULL LIMIT 1`,
      );
      if (!labels.length)
        return yield* decisionError("forbidden", "Environment authorization is no longer valid");
      return {
        challengeId,
        environmentId: EnvironmentId.make(item.environment_id),
        environmentLabel: labels[0]!.environment_label.slice(0, 200),
        expiresAt: iso(item.expires_at),
        approved: item.payer_id === payerId,
        eligible: (yield* access.status(payerId)).eligible,
      };
    });
    const approve = Effect.fn("DecisionFunding.approve")(function* (
      authenticatedPayerId: string,
      challengeId: string,
      verifiedAccountLabel?: string,
    ): Effect.fn.Return<DecisionFundingApprovalResult, DecisionEvaluationError> {
      return yield* transaction(
        Effect.gen(function* () {
          const item = yield* loadChallenge(challengeId);
          if (!item || item.revoked)
            return yield* decisionError("forbidden", "Funding approval is unavailable");
          if (item.expires_at <= (yield* nowSeconds))
            return yield* decisionError("expired", "Funding approval expired");
          if (item.redeemed_generation !== null)
            return yield* decisionError("conflict", "Funding approval was already used");
          const binding = yield* get(item.environment_id);
          if (
            !binding ||
            binding.generation !== item.generation ||
            binding.public_key !== item.public_key
          )
            return yield* decisionError("conflict", "Funding changed; start a new approval");
          if (item.payer_id && item.payer_id !== authenticatedPayerId)
            return yield* decisionError("conflict", "Funding approval belongs to another account");
          if (!(yield* access.status(authenticatedPayerId)).eligible)
            return yield* decisionError("forbidden", "Decisions requires an eligible paid account");
          if (verifiedAccountLabel?.trim())
            yield* decisionStorage(
              sql`UPDATE relay_billing_accounts SET decisions_account_label=${verifiedAccountLabel.trim().slice(0, 200)} WHERE user_id=${authenticatedPayerId} AND deleted_at IS NULL`,
            );
          yield* decisionStorage(
            sql`UPDATE relay_decision_funding_challenges SET payer_id=${authenticatedPayerId} WHERE id=${challengeId}`,
          );
          return { challengeId, approved: true, expiresAt: iso(item.expires_at) };
        }),
      );
    });
    const redeem = Effect.fn("DecisionFunding.redeem")(function* (
      host: EnvironmentCredentialPrincipal,
      challengeId: string,
      expectedGeneration: number,
    ) {
      yield* transaction(
        Effect.gen(function* () {
          yield* assertHost(host);
          const row = yield* lock(host);
          const item = yield* loadChallenge(challengeId);
          if (
            !item ||
            item.revoked ||
            item.environment_id !== host.environmentId ||
            item.public_key !== host.environmentPublicKey ||
            row.public_key !== host.environmentPublicKey
          )
            return yield* decisionError(
              "forbidden",
              "Funding approval does not belong to this environment",
            );
          if (item.redeemed_generation !== null) {
            if (
              item.generation === expectedGeneration &&
              row.generation === item.redeemed_generation &&
              row.state === "active" &&
              row.payer_id === item.payer_id
            )
              return;
            return yield* decisionError("conflict", "Funding approval was already used");
          }
          yield* ensureGeneration(row, expectedGeneration);
          if (item.generation !== row.generation)
            return yield* decisionError("conflict", "Funding changed; start a new approval");
          if (item.expires_at <= (yield* nowSeconds))
            return yield* decisionError("expired", "Funding approval expired");
          if (!item.payer_id || !(yield* access.status(item.payer_id)).eligible)
            return yield* decisionError(
              "forbidden",
              "Funding approval requires an eligible paid account",
            );
          const generation = row.generation + 1;
          yield* decisionStorage(
            sql`UPDATE relay_decision_funding SET payer_id=${item.payer_id},generation=${generation},state='active' WHERE environment_id=${host.environmentId}`,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_funding_challenges SET redeemed_generation=${generation} WHERE id=${challengeId}`,
          );
        }),
      );
      return yield* status(host);
    });
    const revoke = Effect.fn("DecisionFunding.revoke")(function* (environmentId: string) {
      yield* decisionStorage(
        sql`UPDATE relay_decision_funding SET generation=generation+1,payer_id=NULL,state='revoked' WHERE environment_id=${environmentId} AND (state <> 'revoked' OR payer_id IS NOT NULL OR EXISTS(SELECT 1 FROM relay_decision_funding_challenges WHERE environment_id=${environmentId} AND revoked=false))`,
      );
      yield* decisionStorage(
        sql`UPDATE relay_decision_funding_challenges SET revoked=true WHERE environment_id=${environmentId}`,
      );
    });
    const revokeByHost = Effect.fn("DecisionFunding.revokeByHost")(function* (
      host: EnvironmentCredentialPrincipal,
      expectedGeneration: number,
    ) {
      yield* transaction(
        Effect.gen(function* () {
          yield* assertHost(host);
          const row = yield* lock(host);
          yield* ensureGeneration(row, expectedGeneration);
          if (row.public_key !== host.environmentPublicKey)
            return yield* decisionError("forbidden", "Funding belongs to another environment key");
          yield* revoke(host.environmentId);
        }),
      );
      return yield* status(host);
    });
    const revokeByPayer = Effect.fn("DecisionFunding.revokeByPayer")(function* (
      payerId: string,
      environmentId: string,
      expectedGeneration: number,
    ) {
      yield* transaction(
        Effect.gen(function* () {
          const rows = yield* decisionStorage(
            sql<DecisionFundingRecord>`SELECT * FROM relay_decision_funding WHERE environment_id=${environmentId} FOR UPDATE`,
          );
          const row = rows[0];
          if (!row || row.payer_id !== payerId)
            return yield* decisionError("forbidden", "Funding does not belong to this account");
          yield* ensureGeneration(row, expectedGeneration);
          yield* revoke(environmentId);
        }),
      );
      return yield* wireStatus(environmentId, yield* get(environmentId));
    });
    const statusByPayer = Effect.fn("DecisionFunding.statusByPayer")(function* (
      payerId: string,
      environmentId: string,
    ) {
      const row = yield* get(environmentId);
      if (!row || row.payer_id !== payerId)
        return yield* decisionError("forbidden", "Funding does not belong to this account");
      return yield* wireStatus(environmentId, row);
    });
    const listByPayer = Effect.fn("DecisionFunding.listByPayer")(function* (
      payerId: string,
      input: { readonly cursor?: string; readonly limit?: number } = {},
    ) {
      const limit = input.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        return yield* decisionError("invalid", "Invalid funded hosts page size");
      const rows = yield* decisionStorage(
        sql<{
          environment_id: string;
          environment_label: string;
          generation: number;
        }>`SELECT f.environment_id,f.generation,COALESCE((SELECT l.environment_label FROM relay_environment_links l WHERE l.environment_id=f.environment_id AND l.environment_public_key=f.public_key ORDER BY l.updated_at DESC LIMIT 1),f.environment_id) AS environment_label FROM relay_decision_funding f WHERE f.payer_id=${payerId} AND f.state='active' AND (${input.cursor ?? null}::text IS NULL OR f.environment_id > ${input.cursor ?? null}) ORDER BY f.environment_id LIMIT ${limit + 1}`,
      );
      const environments = rows.slice(0, limit).map((row) => ({
        environmentId: EnvironmentId.make(row.environment_id),
        environmentLabel: row.environment_label.slice(0, 200),
        generation: row.generation,
      }));
      return {
        environments,
        nextCursor: rows.length > limit ? environments.at(-1)!.environmentId : null,
      };
    });
    const revokeEnvironment = Effect.fn("DecisionFunding.revokeEnvironment")(function* (
      environmentId: string,
      publicKey?: string,
    ) {
      yield* transaction(
        Effect.gen(function* () {
          const rows = yield* decisionStorage(
            sql<DecisionFundingRecord>`SELECT * FROM relay_decision_funding WHERE environment_id=${environmentId} FOR UPDATE`,
          );
          if (!rows[0] || (publicKey !== undefined && rows[0].public_key !== publicKey)) return;
          yield* revoke(environmentId);
        }),
      );
    });
    const revokeAccount = Effect.fn("DecisionFunding.revokeAccount")(function* (payerId: string) {
      yield* transaction(
        Effect.gen(function* () {
          const rows = yield* decisionStorage(
            sql<DecisionFundingRecord>`SELECT * FROM relay_decision_funding WHERE payer_id=${payerId} ORDER BY environment_id FOR UPDATE`,
          );
          for (const row of rows) yield* revoke(row.environment_id);
          yield* decisionStorage(
            sql`UPDATE relay_decision_funding_challenges SET revoked=true WHERE payer_id=${payerId}`,
          );
          yield* decisionStorage(
            sql`UPDATE relay_decision_grants SET revoked_at=${yield* nowSeconds} WHERE user_id=${payerId} AND revoked_at IS NULL`,
          );
        }),
      );
    });
    return {
      challenge,
      approvalInfo,
      approve,
      redeem,
      status,
      statusByPayer,
      listByPayer,
      requireFunding,
      revokeByHost,
      revokeByPayer,
      revokeEnvironment,
      revokeAccount,
    };
  });
export type DecisionFundingStore = Effect.Success<ReturnType<typeof makeDecisionFundingStore>>;
