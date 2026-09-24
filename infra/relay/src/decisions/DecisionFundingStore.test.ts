import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { RelayDb } from "../db.ts";
import { makeDecisionsAccess, type DecisionsAccessConfig } from "./DecisionsAccess.ts";
import { makeDecisionFundingStore } from "./DecisionFundingStore.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const url = process.env.BILLING_TEST_DATABASE_URL;
const database = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return { $client: sql } as RelayDb["Service"];
  }),
).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(url ?? "postgresql://127.0.0.1/unused") })),
);
const baseConfig: DecisionsAccessConfig = {
  enabled: true,
  billingMaxAgeSeconds: 600,
  monthlyInputTokens: 10_000_000,
};
const fixture = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const id = NodeCrypto.randomUUID();
  const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const payerId = `decision-payer-${id}`;
  const host = {
    credentialId: `decision-cred-${id}`,
    environmentId: `decision-env-${id}`,
    environmentPublicKey: `decision-key-${id}`,
  };
  const facts = {
    source: "stripe_personal_subscription",
    subscriptionId: "sub_fixture",
    invoiceId: "in_fixture",
    interval: "year",
    paidPeriodStart: time - 100,
    paidPeriodEnd: time + 86400,
    subscriptionAnniversary: time - 100,
    reconciledAt: time,
  };
  yield* sql`INSERT INTO relay_billing_accounts(user_id,updated_at,paid_facts) VALUES (${payerId},${time},${encodeJson(facts)}::jsonb)`;
  yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES (${host.credentialId},${host.environmentId},${host.environmentPublicKey},${id},'2026-01-01','2026-01-01')`;
  yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${payerId},${host.environmentId},${host.environmentPublicKey},'https://test.invalid','wss://test.invalid','direct','2026-01-01','2026-01-01')`;
  const access = yield* makeDecisionsAccess(baseConfig);
  const store = yield* makeDecisionFundingStore(access, { approvalOrigin: "https://test.invalid" });
  return { sql, id, time, payerId, host, facts, access, store };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.merge(database, NodeCryptoLayer.layer)));

describe.skipIf(!url)("Decisions funding PostgreSQL", () => {
  it.live(
    "lists only this payer's active hosts in bounded pages and permits expired sponsors to revoke",
    () =>
      run(
        Effect.gen(function* () {
          const first = yield* fixture;
          const second = yield* fixture;
          const foreign = yield* fixture;
          for (const f of [first, second, foreign]) {
            const c = yield* f.store.challenge(f.host, 0);
            yield* f.store.approve(f.payerId, c.challengeId);
            yield* f.store.redeem(f.host, c.challengeId, 0);
          }
          yield* first.sql`UPDATE relay_decision_funding SET payer_id=${first.payerId} WHERE environment_id=${second.host.environmentId}`;
          yield* first.sql`UPDATE relay_environment_links SET environment_label='Sponsor workstation' WHERE environment_id=${first.host.environmentId}`;
          const page1 = yield* first.store.listByPayer(first.payerId, { limit: 1 });
          expect(page1.environments).toHaveLength(1);
          expect(page1.nextCursor).not.toBeNull();
          const page2 = yield* first.store.listByPayer(first.payerId, {
            limit: 1,
            cursor: page1.nextCursor!,
          });
          expect(page2.nextCursor).toBeNull();
          const rows = [...page1.environments, ...page2.environments];
          expect(rows.map((r) => r.environmentId).sort()).toEqual(
            [first.host.environmentId, second.host.environmentId].sort(),
          );
          expect(
            rows.find((r) => r.environmentId === first.host.environmentId)?.environmentLabel,
          ).toBe("Sponsor workstation");
          expect(
            (yield* Effect.flip(
              first.store.revokeByPayer(first.payerId, first.host.environmentId, 0),
            )).code,
          ).toBe("conflict");
          yield* first.sql`UPDATE relay_billing_accounts SET paid_facts=NULL WHERE user_id=${first.payerId}`;
          yield* first.store.revokeByPayer(first.payerId, first.host.environmentId, 1);
          expect(
            (yield* first.store.listByPayer(first.payerId)).environments.map(
              (r) => r.environmentId,
            ),
          ).toEqual([second.host.environmentId]);
          expect(
            (yield* Effect.flip(first.store.listByPayer(first.payerId, { limit: 51 }))).code,
          ).toBe("invalid");
        }),
      ),
  );

  it.live(
    "uses strict current personal billing and distinct expiring/revocable Decisions grants",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, payerId, time, facts, access } = yield* fixture;
          expect((yield* access.status(payerId)).eligible).toBe(true);
          const disabled = yield* makeDecisionsAccess({ ...baseConfig, enabled: false });
          const cohort = yield* makeDecisionsAccess({ ...baseConfig, cohort: [] });
          expect((yield* disabled.status(payerId)).reason).toBe("disabled");
          expect((yield* cohort.status(payerId)).reason).toBe("cohort");
          yield* sql`UPDATE relay_billing_accounts SET paid_facts=${encodeJson({ ...facts, reconciledAt: time - 601 })}::jsonb WHERE user_id=${payerId}`;
          expect((yield* access.status(payerId)).reason).toBe("stale-billing");
          yield* sql`UPDATE relay_billing_accounts SET paid_facts=NULL,state=${encodeJson({ status: "trialing", accessUntil: time + 1000, grant: { id: "connect", start: time - 10, end: time + 1000, limit: 3 } })}::jsonb WHERE user_id=${payerId}`;
          expect((yield* access.status(payerId)).reason).toBe("trial");
          yield* sql`INSERT INTO relay_decision_grants(id,user_id,starts_at,ends_at,monthly_input_tokens,operator,reason) VALUES (${payerId},${payerId},${time - 10},${time + 100},1234,'test','explicit Decisions fixture')`;
          expect(yield* access.status(payerId)).toMatchObject({
            eligible: true,
            limitInputTokens: 1234,
            window: { end: time + 100 },
          });
          yield* sql`UPDATE relay_decision_grants SET revoked_at=${time} WHERE id=${payerId}`;
          expect((yield* access.status(payerId)).eligible).toBe(false);
          yield* sql`UPDATE relay_decision_grants SET revoked_at=NULL,ends_at=${time} WHERE id=${payerId}`;
          expect((yield* access.status(payerId)).eligible).toBe(false);
          yield* sql`UPDATE relay_decision_grants SET ends_at=${time + 1000} WHERE id=${payerId}`;
          yield* sql`UPDATE relay_billing_accounts SET deleted_at=${time} WHERE user_id=${payerId}`;
          expect((yield* access.status(payerId)).eligible).toBe(false);
        }),
      ),
  );
  it.live("redeems once under concurrency and never trusts a forged payer or host", () =>
    run(
      Effect.gen(function* () {
        const { store, payerId, host } = yield* fixture;
        const challenge = yield* store.challenge(host, 0);
        expect(challenge.generation).toBe(0);
        expect(new URL(challenge.approvalUrl).pathname).toBe("/decisions/funding/approve");
        expect(new URL(challenge.approvalUrl).searchParams.get("challengeId")).toBe(
          challenge.challengeId,
        );
        expect(yield* store.approvalInfo(payerId, challenge.challengeId)).toMatchObject({
          environmentId: host.environmentId,
          approved: false,
          eligible: true,
        });
        expect(
          (yield* Effect.flip(store.approve("forged-payer", challenge.challengeId))).code,
        ).toBe("forbidden");
        yield* store.approve(payerId, challenge.challengeId, "verified-sponsor@example.test");
        expect(
          (yield* Effect.flip(store.approve("forged-payer", challenge.challengeId))).code,
        ).toBe("conflict");
        expect(
          (yield* Effect.flip(
            store.redeem({ ...host, credentialId: "forged" }, challenge.challengeId, 0),
          )).code,
        ).toBe("forbidden");
        const responses = yield* Effect.all(
          [
            store.redeem(host, challenge.challengeId, 0),
            store.redeem(host, challenge.challengeId, 0),
          ],
          { concurrency: 2 },
        );
        expect(responses.map((row) => row.generation)).toEqual([1, 1]);
        expect(responses.map((row) => row.accountLabel)).toEqual([
          "verified-sponsor@example.test",
          "verified-sponsor@example.test",
        ]);
        expect(responses.every((row) => row.state === "active" && row.eligible)).toBe(true);
        expect((yield* store.requireFunding(host, 1)).payerId).toBe(payerId);
        expect((yield* Effect.flip(store.requireFunding(host, 0))).code).toBe("conflict");
        expect(
          (yield* Effect.flip(store.revokeByPayer("forged-payer", host.environmentId, 1))).code,
        ).toBe("forbidden");
        const revoked = yield* store.revokeByPayer(payerId, host.environmentId, 1);
        expect(revoked.generation).toBe(2);
        expect(revoked.accountLabel).toBeNull();
        expect((yield* Effect.flip(store.redeem(host, challenge.challengeId, 0))).code).toBe(
          "forbidden",
        );
        expect((yield* Effect.flip(store.requireFunding(host, 2))).code).toBe("forbidden");
      }),
    ),
  );
  it.live("expires challenges and invalidates superseded pending approvals", () =>
    run(
      Effect.gen(function* () {
        const { sql, store, payerId, host, time } = yield* fixture;
        const old = yield* store.challenge(host, 0);
        const fresh = yield* store.challenge(host, 0);
        expect((yield* Effect.flip(store.approve(payerId, old.challengeId))).code).toBe(
          "forbidden",
        );
        yield* store.approve(payerId, fresh.challengeId);
        yield* sql`UPDATE relay_decision_funding_challenges SET expires_at=${time} WHERE id=${fresh.challengeId}`;
        expect((yield* Effect.flip(store.redeem(host, fresh.challengeId, 0))).code).toBe("expired");
        expect((yield* store.status(host)).state).toBe("unfunded");
      }),
    ),
  );
  it.live(
    "rotates environment keys without inheriting payer and supports host and cleanup revocation",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, id, store, payerId, host } = yield* fixture;
          const first = yield* store.challenge(host, 0);
          yield* store.approve(payerId, first.challengeId);
          yield* store.redeem(host, first.challengeId, 0);
          const rotated = {
            ...host,
            credentialId: `rotated-${id}`,
            environmentPublicKey: `rotated-key-${id}`,
          };
          yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES (${rotated.credentialId},${host.environmentId},${rotated.environmentPublicKey},${rotated.credentialId},'2026-01-01','2026-01-01')`;
          yield* sql`UPDATE relay_environment_links SET environment_public_key=${rotated.environmentPublicKey} WHERE environment_id=${host.environmentId}`;
          expect((yield* Effect.flip(store.requireFunding(host, 1))).code).toBe("forbidden");
          const challenge = yield* store.challenge(rotated, 1);
          expect(challenge.generation).toBe(2);
          expect((yield* store.status(rotated)).accountLabel).toBeNull();
          yield* store.approve(payerId, challenge.challengeId);
          expect((yield* store.redeem(rotated, challenge.challengeId, 2)).generation).toBe(3);
          yield* store.revokeEnvironment(host.environmentId, host.environmentPublicKey);
          expect((yield* store.status(rotated)).state).toBe("active");
          expect((yield* store.revokeByHost(rotated, 3)).generation).toBe(4);
          const next = yield* store.challenge(rotated, 4);
          yield* store.approve(payerId, next.challengeId);
          yield* store.redeem(rotated, next.challengeId, 4);
          yield* store.revokeAccount(payerId);
          expect((yield* store.status(rotated)).state).toBe("revoked");
          expect((yield* Effect.flip(store.redeem(rotated, next.challengeId, 4))).code).toBe(
            "forbidden",
          );
        }),
      ),
  );
  it.live(
    "rechecks payment and credentials at redemption and rejects stale replacement generations",
    () =>
      run(
        Effect.gen(function* () {
          const { sql, store, host, payerId, time, facts } = yield* fixture;
          const first = yield* store.challenge(host, 0);
          yield* store.approve(payerId, first.challengeId);
          yield* sql`UPDATE relay_billing_accounts SET paid_facts=NULL WHERE user_id=${payerId}`;
          expect((yield* Effect.flip(store.redeem(host, first.challengeId, 0))).code).toBe(
            "forbidden",
          );
          yield* sql`UPDATE relay_billing_accounts SET paid_facts=${encodeJson(facts)}::jsonb WHERE user_id=${payerId}`;
          yield* store.redeem(host, first.challengeId, 0);
          const otherPayer = `${payerId}-replacement`;
          yield* sql`INSERT INTO relay_billing_accounts(user_id,updated_at,paid_facts) VALUES (${otherPayer},${time},${encodeJson(facts)}::jsonb)`;
          const next = yield* store.challenge(host, 1);
          yield* store.approve(otherPayer, next.challengeId);
          expect((yield* store.redeem(host, next.challengeId, 1)).generation).toBe(2);
          expect((yield* Effect.flip(store.redeem(host, first.challengeId, 0))).code).toBe(
            "conflict",
          );
          expect(
            (yield* Effect.flip(store.revokeByPayer(payerId, host.environmentId, 2))).code,
          ).toBe("forbidden");
          expect((yield* store.requireFunding(host, 2)).payerId).toBe(otherPayer);
          yield* sql`UPDATE relay_environment_credentials SET revoked_at='2026-01-01' WHERE credential_id=${host.credentialId}`;
          expect((yield* Effect.flip(store.requireFunding(host, 2))).code).toBe("forbidden");
        }),
      ),
  );
});
