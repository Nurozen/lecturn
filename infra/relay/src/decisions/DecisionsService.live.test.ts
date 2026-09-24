import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { RelayDb } from "../db.ts";
import { makeDecisionsService } from "./DecisionsService.ts";
import { parseDecisionsConfig } from "./DecisionsConfig.ts";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const enabled =
  process.env.DECISIONS_LIVE_SMOKE === "true" && !!process.env.TYPESAFE_API_KEY && !!databaseUrl;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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

describe.skipIf(!enabled)("live synthetic Decisions service", () => {
  it.live(
    "meters Jev once, replays without another upstream request, and rejects revoked funding",
    () =>
      Effect.gen(function* () {
        const { $client: sql } = yield* RelayDb;
        const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const id = NodeCrypto.randomUUID(),
          payerId = `live-decisions-${id}`;
        const principal = {
          credentialId: `live-credential-${id}`,
          environmentId: `live-environment-${id}`,
          environmentPublicKey: `live-public-key-${id}`,
        };
        const facts = {
          source: "stripe_personal_subscription",
          subscriptionId: "synthetic",
          invoiceId: "synthetic",
          interval: "month",
          paidPeriodStart: time - 10,
          paidPeriodEnd: time + 3600,
          subscriptionAnniversary: time - 10,
          reconciledAt: time,
        };
        yield* sql`INSERT INTO relay_billing_accounts(user_id,updated_at,paid_facts) VALUES (${payerId},${time},${encodeJson(facts)}::jsonb)`;
        yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES (${principal.credentialId},${principal.environmentId},${principal.environmentPublicKey},${id},'2026-09-23','2026-09-23')`;
        yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_label,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${payerId},${principal.environmentId},'Synthetic Decisions smoke test',${principal.environmentPublicKey},'https://test.invalid','wss://test.invalid','direct','2026-09-23','2026-09-23')`;
        let upstreamCalls = 0;
        const http = yield* HttpClient.HttpClient;
        const config = parseDecisionsConfig({
          DECISIONS_ENABLED: "true",
          DECISIONS_COHORT: "*",
          TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
        });
        const service = yield* makeDecisionsService(config, "https://test.invalid").pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.mapRequest(http, (request) => {
              upstreamCalls++;
              return request;
            }),
          ),
        );
        const challenge = yield* service.funding.challenge(principal, 0);
        yield* service.funding.approve(payerId, challenge.challengeId);
        const funding = yield* service.funding.redeem(
          principal,
          challenge.challengeId,
          challenge.generation,
        );
        const request = {
          requestId: `live-request-${id}`,
          runId: `live-run-${id}`,
          fundingGeneration: funding.generation,
          targets: [
            {
              id: "storage-choice",
              text: "User: Let's use SQLite for local notes. Assistant: Agreed; SQLite is the selected local database.",
            },
          ],
          context: "A synthetic software planning conversation.",
          description: "Selected storage technology",
          templateVersion: "decisions-v1",
        };
        const result = yield* service.evaluate(principal, request);
        expect(result.inputTokens).toBeGreaterThan(0);
        expect(result.replayed).toBe(false);
        expect(result.judgments[0]).toMatchObject({
          targetId: "storage-choice",
          exists: "yes",
          relevant: "yes",
        });
        const replay = yield* service.evaluate(principal, request);
        expect(replay.replayed).toBe(true);
        expect(replay.inputTokens).toBe(result.inputTokens);
        expect(upstreamCalls).toBe(1);
        yield* service.funding.revokeByPayer(payerId, principal.environmentId, funding.generation);
        expect(
          (yield* Effect.flip(
            service.evaluate(principal, { ...request, requestId: `${request.requestId}-revoked` }),
          )).code,
        ).toBe("forbidden");
        expect(upstreamCalls).toBe(1);
        yield* Effect.logInfo("Synthetic Decisions metering verified", {
          inputTokens: result.inputTokens,
          costNanoUsd: result.inputTokens * config.priceNanoUsdPerInputToken,
          upstreamCalls,
          replayVerified: true,
          revocationVerified: true,
        });
      }).pipe(
        Effect.provide(Layer.mergeAll(database, NodeCryptoLayer.layer, FetchHttpClient.layer)),
      ),
    45000,
  );
});
