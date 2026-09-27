import * as FileSystem from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { HttpClient } from "effect/unstable/http";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { makeDecisionsService } from "../decisions/DecisionsService.ts";
import { parseDecisionsConfig } from "../decisions/DecisionsConfig.ts";
import { makeExtensionsService, ExtensionsService } from "./ExtensionsService.ts";
import { parseExtensionsConfig } from "./ExtensionsConfig.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { RelayDb } from "../db.ts";
import { makeDecisionFundingStore } from "../decisions/DecisionFundingStore.ts";
import { makeDecisionsAccess } from "../decisions/DecisionsAccess.ts";
import {
  makeExtensionsUsageStore,
  decisionUsageDefaults,
} from "../decisions/DecisionUsageStore.ts";
import { ExtensionAllowance, type ContextualJudgment } from "@lecturn/contracts";
const url = process.env.BILLING_TEST_DATABASE_URL;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const validAllowance = Schema.is(ExtensionAllowance);
const database = Layer.unwrap(
  Effect.sync(() => {
    const schema = "extensions_suite_" + NodeCrypto.randomUUID().replaceAll("-", "");
    const scopedUrl = new URL(url ?? "postgresql://127.0.0.1/unused");
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    return Layer.effect(
      RelayDb,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const fs = yield* FileSystem.FileSystem;
        yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
        yield* Effect.addFinalizer(() =>
          sql.unsafe(`DROP SCHEMA ${schema} CASCADE`).pipe(Effect.ignore),
        );
        const migrations = new URL("../../migrations/postgres/", import.meta.url).pathname;
        const entries = yield* fs.readDirectory(migrations);
        for (const entry of entries.toSorted()) {
          if (!/^\d+_/.test(entry)) continue;
          yield* sql.unsafe(yield* fs.readFileString(`${migrations}${entry}/migration.sql`));
        }
        return { $client: sql } as RelayDb["Service"];
      }),
    ).pipe(
      Layer.provide(PgClient.layer({ url: Redacted.make(scopedUrl.toString()) })),
      Layer.provide(NodeFileSystem.layer),
    );
  }),
);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(database, NodeCryptoLayer.layer, NodeFileSystem.layer)),
  );
const unpromotedFixture = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const id = NodeCrypto.randomUUID(),
    payerId = `user_${id}`;
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const host = {
    credentialId: `cred-${id}`,
    environmentId: `env-${id}`,
    environmentPublicKey: `key-${id}`,
  };
  yield* sql`INSERT INTO relay_billing_accounts(user_id,updated_at,paid_facts) VALUES (${payerId},${now},${encodeJson({ source: "stripe_personal_subscription", subscriptionId: "sub_fixture", invoiceId: "invoice_fixture", interval: "year", paidPeriodStart: now - 100, paidPeriodEnd: now + 86400, subscriptionAnniversary: now - 100, reconciledAt: now })}::jsonb)`;
  yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES (${host.credentialId},${host.environmentId},${host.environmentPublicKey},${id},'2026-01-01','2026-01-01')`;
  yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${payerId},${host.environmentId},${host.environmentPublicKey},'https://fixture.invalid','wss://fixture.invalid','direct','2026-01-01','2026-01-01')`;
  const config = {
    ...decisionUsageDefaults,
    enabled: true,
    billingMaxAgeSeconds: 600,
    monthlyInputTokens: 1_000_000,
  };
  const access = yield* makeDecisionsAccess(config);
  const decisions = yield* makeDecisionFundingStore(access, {
    approvalOrigin: "https://fixture.invalid",
    featureId: "decisions",
  });
  const contextual = yield* makeDecisionFundingStore(access, {
    approvalOrigin: "https://fixture.invalid",
    featureId: "contextual",
  });
  return { sql, payerId, host, config, decisions, contextual, now };
});
const fixture = Effect.gen(function* () {
  const f = yield* unpromotedFixture;
  yield* f.sql`UPDATE relay_extensions_schema SET compatibility_deployments=2 WHERE id=1`;
  yield* f.sql`SELECT relay_extensions_promote(true,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`;
  return f;
});
const fund = Effect.fn("extensionTest.fund")(function* (
  f: Effect.Success<typeof fixture>,
  feature: "decisions" | "contextual",
) {
  const store = f[feature];
  const challenge = yield* store.challenge(f.host, 0);
  yield* store.approve(f.payerId, challenge.challengeId, "fixture@example.invalid");
  yield* store.redeem(f.host, challenge.challengeId, 0);
  return challenge;
});
const contextualRequest = (environmentId: string) => ({
  featureId: "contextual",
  requestId: "readiness",
  runId: "readiness",
  fundingGeneration: 0,
  templateVersion: "contextual-v1",
  task: {
    environmentId,
    projectId: "project",
    threadId: "thread",
    submissionId: "submission",
    messageId: "message",
    turnId: null,
    providerInstanceId: "provider",
    providerContextEpoch: "epoch",
    taskFingerprint: "task",
    knownContextFingerprint: "known",
    threadSettingsRevision: 1,
    projectSettingsRevision: 1,
    sourceScopeRevision: 1,
    threadExclusionRevision: 1,
    fundingGeneration: 0,
    purgeGeneration: 1,
    newestMessage: "Build the rocket",
    projectDescription: "Synthetic",
    explicitReferences: [],
    recentContext: "",
    trigger: "submission",
  },
  targets: [
    {
      id: "candidate",
      sourceId: "source",
      occurrenceId: "occurrence",
      recordRevision: 1,
      guidanceId: "guidance",
      contentFingerprint: "content",
      lineageIds: [],
      coverage: { complete: true, missingAntecedents: false, truncated: false, unexaminedCount: 0 },
      state: "not-yet-evaluated",
      sourceKind: "slack",
      workspaceId: "workspace",
      channelId: "channel",
      messageTs: "1720000000.123456",
      threadTs: null,
      evidence: [
        {
          id: "evidence",
          sourceId: "source",
          sourceKind: "slack",
          occurrenceId: "occurrence",
          sourceRevision: 1,
          sourceHash: "hash",
          canonicalVersion: "v1",
          coordinateSystem: "utf16",
          quote: "Use steel",
          start: 0,
          end: 9,
          prefix: "",
          suffix: "",
          author: "Synthetic",
          occurredAt: "2026-09-25T00:00:00.000Z",
          observedAt: "2026-09-25T00:00:00.000Z",
          sourceUrl: null,
          availability: "available",
          lineageIds: [],
          locator: {
            sourceKind: "slack",
            workspaceId: "workspace",
            channelId: "channel",
            messageTs: "1720000000.123456",
            threadTs: null,
          },
        },
      ],
    },
  ],
});
describe.skipIf(!url)("Extensions PostgreSQL consent and shared ledger", () => {
  for (const schemaState of ["phase-0", "phase-1", "missing-row", "missing-table"] as const) {
    it.live(`checks Contextual readiness before funding with ${schemaState}`, () =>
      run(
        Effect.gen(function* () {
          const f = yield* schemaState === "phase-1" ? fixture : unpromotedFixture;
          if (schemaState === "missing-row") yield* f.sql`DELETE FROM relay_extensions_schema`;
          if (schemaState === "missing-table")
            yield* f.sql`ALTER TABLE relay_extensions_schema RENAME TO unavailable_extensions_schema`;
          let dispatches = 0;
          const service = yield* makeExtensionsService(
            parseExtensionsConfig({
              EXTENSIONS_DECISIONS_ENABLED: "true",
              EXTENSIONS_DECISIONS_COHORT: "*",
              EXTENSIONS_CONTEXTUAL_ENABLED: "true",
              EXTENSIONS_CONTEXTUAL_COHORT: "*",
            }),
            "https://fixture.invalid",
            Effect.succeed({
              fetch: async () => {
                dispatches++;
                return new Response(null, { status: 503 });
              },
            }),
          );
          const ready = schemaState === "phase-1";
          expect((yield* service.status(f.payerId)).features).toMatchObject([
            { featureId: "decisions", available: true, eligible: true, reason: "eligible" },
            {
              featureId: "contextual",
              available: ready,
              eligible: ready,
              reason: ready ? "eligible" : "unavailable",
            },
          ]);
          if (schemaState !== "missing-table") {
            const decisions = service.funding.decisions;
            const challenge = yield* decisions.challenge(f.host, 0);
            yield* decisions.approve(f.payerId, challenge.challengeId, "fixture@example.invalid");
            expect(yield* decisions.redeem(f.host, challenge.challengeId, 0)).toMatchObject({
              state: "active",
              eligible: true,
            });
          }
          const contextual = service.funding.contextual;
          if (ready) {
            const challenge = yield* contextual.challenge(f.host, 0);
            yield* contextual.approve(f.payerId, challenge.challengeId, "fixture@example.invalid");
            expect(yield* contextual.redeem(f.host, challenge.challengeId, 0)).toMatchObject({
              state: "active",
              eligible: true,
            });
          } else {
            expect(yield* contextual.status(f.host)).toMatchObject({
              state: "unfunded",
              eligible: false,
              reason: "unavailable",
              allowance: null,
            });
            for (const blocked of [
              contextual.challenge(f.host, 0).pipe(Effect.asVoid),
              service
                .evaluate(f.host, contextualRequest(f.host.environmentId), "relevance")
                .pipe(Effect.asVoid),
              contextual
                .approve(f.payerId, "not-created", "fixture@example.invalid")
                .pipe(Effect.asVoid),
              contextual.redeem(f.host, "not-created", 0).pipe(Effect.asVoid),
            ]) {
              expect(yield* blocked.pipe(Effect.flip)).toMatchObject({
                code: "unavailable",
                message: "This extension is not ready yet",
              });
            }
            expect(
              yield* f.sql`SELECT 1 FROM relay_decision_funding WHERE feature_id='contextual'`,
            ).toHaveLength(0);
            expect(
              yield* f.sql`SELECT 1 FROM relay_decision_funding_challenges WHERE feature_id='contextual'`,
            ).toHaveLength(0);
          }
          expect(yield* f.sql`SELECT 1 FROM relay_decision_usage_attempts`).toHaveLength(0);
          expect(dispatches).toBe(0);
        }),
      ),
    );
  }

  it.live(
    "releases the entire reservation when bounded evaluation completes without upstream usage",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* fund(f, "contextual");
          const store = yield* makeExtensionsUsageStore<ContextualJudgment>({
            ...f.config,
            featureId: "contextual",
          });
          const input = {
            principal: f.host,
            payerId: f.payerId,
            fundingGeneration: 1,
            requestId: "bounded-no-call",
            runId: "bounded-no-call",
            fingerprint: "no-call",
            templateVersion: "contextual-v1",
            model: "extensions-v1",
            backend: "private-evaluator" as const,
          };
          const admitted = yield* store.reserve(input);
          if (admitted.kind !== "admitted") throw new Error("Expected admission");
          expect((yield* store.getSharedAllowance(f.payerId)).reservedInputTokens).toBeGreaterThan(
            0,
          );
          yield* store.markDispatched(admitted.attemptId);
          const result = yield* store.settle(admitted.attemptId, {
            inputTokens: 0,
            judgments: [
              {
                targetId: "target",
                useful: 0,
                usableEvidence: 0,
                contradicts: 0,
                sufficientContext: 0,
                reasons: [],
                selectedEvidenceIds: [],
                evaluationComplete: false,
              },
            ],
          });
          expect(result.kind).toBe("settled");
          const allowance = yield* store.getSharedAllowance(f.payerId);
          expect(allowance.usedInputTokens).toBe(0);
          expect(allowance.reservedInputTokens).toBe(0);
          expect(allowance.remainingInputTokens).toBe(allowance.limitInputTokens);
          expect((yield* store.reserve(input)).kind).toBe("replay");
        }),
      ),
  );

  it.live(
    "promotes only after compatibility deployments, then fences old reservation writers",
    () =>
      run(
        Effect.gen(function* () {
          const { $client: sql } = yield* RelayDb;
          expect(
            (yield* sql`SELECT relay_extensions_promote(false,'fixture-sha')`.pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          const f = yield* fixture;
          expect(
            (yield* sql`INSERT INTO relay_decision_funding(environment_id,public_key) VALUES ('obsolete-fixture','old-key')`.pipe(
              Effect.result,
            ))._tag,
          ).toBe("Failure");
          expect((yield* f.decisions.challenge(f.host, 0)).generation).toBe(0);
        }),
      ),
  );
  it.live(
    "requires separate feature consent and observes only an exact pending host operation",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const d = yield* fund(f, "decisions");
          expect((yield* f.contextual.status(f.host)).state).toBe("unfunded");
          expect(
            (yield* f.contextual.observe(f.host, d.challengeId, 0).pipe(Effect.flip)).code,
          ).toBe("forbidden");
          const c = yield* f.contextual.challenge(f.host, 0);
          expect(yield* f.contextual.observe(f.host, c.challengeId, 0)).toMatchObject({
            state: "awaiting-approval",
            accountLabel: null,
          });
          yield* f.contextual.approve(f.payerId, c.challengeId, "fixture@example.invalid");
          expect(yield* f.contextual.observe(f.host, c.challengeId, 0)).toMatchObject({
            state: "approved-awaiting-host",
            accountLabel: "fixture@example.invalid",
          });
          yield* f.contextual.redeem(f.host, c.challengeId, 0);
          expect((yield* f.contextual.observe(f.host, c.challengeId, 0)).state).toBe("linked");
          const replacement = yield* f.contextual.challenge(f.host, 1);
          yield* f.contextual.cancel(f.host, replacement.challengeId, 1);
          expect((yield* f.contextual.status(f.host)).state).toBe("active");
          expect((yield* f.contextual.observe(f.host, replacement.challengeId, 1)).state).toBe(
            "canceled",
          );
        }),
      ),
  );
  it.live(
    "shares one window and concurrency across features while request IDs and usage attribution remain independent",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* fund(f, "decisions");
          yield* fund(f, "contextual");
          const decisions = yield* makeExtensionsUsageStore({
            ...f.config,
            featureId: "decisions",
          });
          const contextual = yield* makeExtensionsUsageStore({
            ...f.config,
            featureId: "contextual",
          });
          const input = {
            principal: f.host,
            payerId: f.payerId,
            fundingGeneration: 1,
            requestId: "same-request",
            runId: "same-run",
            fingerprint: "hash",
            templateVersion: "fixture",
            model: "extensions-v1",
            backend: "private-evaluator" as const,
          };
          const first = yield* decisions.reserve(input);
          if (first.kind !== "admitted") throw new Error("Expected admission");
          expect((yield* contextual.reserve(input).pipe(Effect.flip)).code).toBe("rate-limited");
          yield* decisions.markDispatched(first.attemptId);
          const unqualified = yield* decisions.settle(first.attemptId, {
            inputTokens: 123,
            judgments: [],
            qualificationId: "must-not-leak",
          });
          if (unqualified.kind !== "settled") throw new Error("Expected settlement");
          expect(unqualified.result).not.toHaveProperty("qualificationId");
          const second = yield* contextual.reserve(input);
          if (second.kind !== "admitted") throw new Error("Expected admission");
          yield* contextual.markDispatched(second.attemptId);
          yield* contextual.settle(second.attemptId, { inputTokens: 321, judgments: [] });
          const allowance = yield* contextual.getSharedAllowance(f.payerId);
          expect(validAllowance(allowance)).toBe(true);
          expect(allowance.usedInputTokens).toBe(444);
          expect(allowance.byFeature).toEqual(
            expect.arrayContaining([
              { featureId: "decisions", usedInputTokens: 123, reservedInputTokens: 0 },
              { featureId: "contextual", usedInputTokens: 321, reservedInputTokens: 0 },
            ]),
          );
          expect((yield* decisions.reserve(input)).kind).toBe("replay");
          yield* f.decisions.revokeEnvironment(f.host.environmentId);
          expect((yield* f.contextual.status(f.host)).state).toBe("revoked");
        }),
      ),
  );
  it.live(
    "pins grant allowance through replay and feature transitions without multiplying balances",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.sql`UPDATE relay_billing_accounts SET paid_facts=NULL WHERE user_id=${f.payerId}`;
          yield* f.sql`INSERT INTO relay_decision_grants(id,user_id,starts_at,ends_at,monthly_input_tokens,operator,reason) VALUES (${f.payerId},${f.payerId},${f.now - 50},${f.now + 86400},700000,'fixture','grant fixture')`;
          yield* fund(f, "decisions");
          const store = yield* makeExtensionsUsageStore({ ...f.config, featureId: "decisions" });
          const input = {
            principal: f.host,
            payerId: f.payerId,
            fundingGeneration: 1,
            requestId: "grant",
            runId: "grant",
            fingerprint: "hash",
            templateVersion: "fixture",
            model: "extensions-v1",
          };
          const a = yield* store.reserve(input);
          if (a.kind !== "admitted") throw new Error("Expected admission");
          yield* store.markDispatched(a.attemptId);
          yield* store.settle(a.attemptId, { inputTokens: 20, judgments: [] });
          const repeated = yield* store.settle(a.attemptId, { inputTokens: 20, judgments: [] });
          if (repeated.kind !== "settled") throw new Error("Expected settlement");
          expect(repeated.result.allowance.limitInputTokens).toBe(700000);
          yield* f.sql`INSERT INTO relay_decision_grants(id,user_id,starts_at,ends_at,monthly_input_tokens,operator,reason) VALUES (${f.payerId + "new"},${f.payerId},${f.now - 10},${f.now + 86400},900000,'fixture','later grant')`;
          expect((yield* store.getSharedAllowance(f.payerId)).limitInputTokens).toBe(700000);
          const contextualAccess = yield* makeDecisionsAccess({
            ...f.config,
            featureId: "contextual",
          });
          expect((yield* contextualAccess.status(f.payerId)).eligible).toBe(false);
          yield* f.sql`INSERT INTO relay_extension_admission_grants(id,user_id,feature_id,starts_at,ends_at,operator,reason) VALUES (${f.payerId},${f.payerId},'contextual',${f.now - 1},${f.now + 1000},'fixture','feature admission')`;
          expect((yield* contextualAccess.status(f.payerId)).eligible).toBe(true);
        }),
      ),
  );
  it.live(
    "dispatches a paid identity once, settles recovered unknown status, and refuses revoked result access",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* fund(f, "decisions");
          let calls = 0;
          let completed = false;
          const binding = {
            fetch: async (req: Request) => {
              const identity = (await req.json()) as { attemptId: string; policyVersion: string };
              if (new URL(req.url).pathname === "/evaluate") {
                calls++;
                return Response.json({
                  status: "unknown",
                  attemptId: identity.attemptId,
                  reason: "upstream-unknown",
                });
              }
              completed = true;
              return Response.json({
                status: "completed",
                attemptId: identity.attemptId,
                replayed: true,
                result: {
                  model: "extensions-v1",
                  policyVersion: identity.policyVersion,
                  inputTokens: 101,
                  judgments: [{ targetId: "target", exists: "yes", relevant: "yes" }],
                },
              });
            },
          };
          const service = yield* makeExtensionsService(
            parseExtensionsConfig({
              EXTENSIONS_DECISIONS_ENABLED: "true",
              EXTENSIONS_DECISIONS_COHORT: "*",
            }),
            "https://fixture.invalid",
            Effect.succeed(binding),
          );
          const legacy = yield* makeDecisionsService(
            parseDecisionsConfig({
              EXTENSIONS_DECISIONS_ENABLED: "true",
              EXTENSIONS_DECISIONS_COHORT: "*",
              EXTENSIONS_EVALUATOR_WORKER: "fixture-evaluator",
            }),
            "https://fixture.invalid",
          ).pipe(
            Effect.provideService(ExtensionsService, service),
            Effect.provide(FetchHttpClient.layer),
          );
          const input = {
            requestId: "unknown",
            runId: "unknown",
            fundingGeneration: 1,
            templateVersion: "decisions-v1",
            targets: [{ id: "target", text: "Use shared Postgres." }],
            context: "",
            description: "",
          };
          expect((yield* legacy.evaluate(f.host, input).pipe(Effect.flip)).code).toBe(
            "in-progress",
          );
          expect((yield* legacy.evaluate(f.host, input).pipe(Effect.flip)).code).toBe(
            "in-progress",
          );
          expect(calls).toBe(1);
          const rollbackExtensions = yield* makeExtensionsService(
            parseExtensionsConfig({
              EXTENSIONS_DECISIONS_ENABLED: "true",
              EXTENSIONS_DECISIONS_COHORT: "*",
            }),
            "https://fixture.invalid",
            Effect.succeed(undefined),
          );
          const rollback = yield* makeDecisionsService(
            parseDecisionsConfig({
              DECISIONS_ENABLED: "true",
              DECISIONS_COHORT: "*",
              EXTENSIONS_EVALUATOR_WORKER: "",
            }),
            "https://fixture.invalid",
          ).pipe(
            Effect.provideService(ExtensionsService, rollbackExtensions),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("Rollback must not dispatch legacy evaluation")),
            ),
          );
          expect((yield* rollback.evaluate(f.host, input).pipe(Effect.flip)).code).toBe(
            "in-progress",
          );
          expect(
            yield* service.evaluationStatus(f.host, {
              featureId: "decisions",
              requestId: "unknown",
              fundingGeneration: 1,
            }),
          ).toMatchObject({ state: "succeeded", inputTokens: 101 });
          expect(completed).toBe(true);
          expect(yield* legacy.evaluate(f.host, input)).toMatchObject({
            replayed: true,
            inputTokens: 101,
          });
          expect(yield* rollback.evaluate(f.host, input)).toMatchObject({
            replayed: true,
            inputTokens: 101,
          });
          expect(calls).toBe(1);
          yield* f.decisions.revokeByHost(f.host, 1);
          expect(
            (yield* service
              .evaluationStatus(f.host, {
                featureId: "decisions",
                requestId: "unknown",
                fundingGeneration: 1,
              })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
        }),
      ),
  );
  it.live(
    "retains equivalence qualification through reconciliation and rechecks it on cached replay",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* fund(f, "decisions");
          let evaluateCalls = 0;
          let unknownOnEvaluate = true;
          let qualificationId: string | undefined = "synthetic-qualified-policy";
          let bindingAvailable = true;
          const binding = {
            fetch: async (req: Request) => {
              const identity = (await req.json()) as { attemptId: string; policyVersion: string };
              if (new URL(req.url).pathname === "/evaluate") {
                evaluateCalls++;
                if (unknownOnEvaluate)
                  return Response.json({
                    status: "unknown",
                    attemptId: identity.attemptId,
                    reason: "upstream-unknown",
                  });
              }
              return Response.json({
                status: "completed",
                attemptId: identity.attemptId,
                replayed: true,
                result: {
                  model: "extensions-v1",
                  policyVersion: identity.policyVersion,
                  inputTokens: 19,
                  ...(qualificationId ? { qualificationId } : {}),
                  judgments: [
                    {
                      targetId: "pair",
                      equivalentCommitment: 1,
                      sameApplicability: 1,
                      sufficientEvidence: 1,
                      relation: "equivalent",
                    },
                  ],
                },
              });
            },
          };
          const service = yield* makeExtensionsService(
            parseExtensionsConfig({
              EXTENSIONS_DECISIONS_ENABLED: "true",
              EXTENSIONS_DECISIONS_COHORT: "*",
            }),
            "https://fixture.invalid",
            Effect.sync(() => (bindingAvailable ? binding : undefined)),
          );
          const candidate = (id: string) => ({
            id,
            sourceId: id,
            occurrenceId: id,
            recordRevision: 1,
            guidanceId: id,
            contentFingerprint: id,
            lineageIds: [],
            coverage: {
              complete: false,
              missingAntecedents: false,
              truncated: false,
              unexaminedCount: 0,
            },
            state: "ready",
            sourceKind: "lecturn-decision",
            environmentId: f.host.environmentId,
            projectId: "project",
            threadId: id,
            decisionId: id,
            decisionRevision: 1,
            attribution: "user-directed",
            reviewState: "unreviewed",
            lifecycle: "current",
            replacementIds: [],
            derivedSummary: {
              title: "Use SQLite",
              body: "Use SQLite",
              rationale: null,
              userEdited: false,
            },
            evidence: [
              {
                id,
                sourceId: id,
                occurrenceId: id,
                sourceKind: "lecturn-decision",
                sourceRevision: 1,
                sourceHash: id,
                canonicalVersion: "1",
                coordinateSystem: "utf16",
                quote: "Use SQLite",
                start: 0,
                end: 10,
                prefix: "",
                suffix: "",
                author: "Synthetic",
                occurredAt: "2026-09-26T00:00:00.000Z",
                observedAt: "2026-09-26T00:00:00.000Z",
                sourceUrl: null,
                availability: "available",
                lineageIds: [],
                locator: {
                  sourceKind: "lecturn-decision",
                  environmentId: f.host.environmentId,
                  projectId: "project",
                  threadId: id,
                  messageId: id,
                  messageRole: "user",
                  decisionId: id,
                  evidenceId: id,
                },
              },
            ],
          });
          const input = {
            featureId: "decisions",
            environmentId: f.host.environmentId,
            projectId: "project",
            requestId: "qualified",
            runId: "qualified",
            fundingGeneration: 1,
            templateVersion: "decisions-equivalence-v1",
            targets: [{ id: "pair", left: candidate("left"), right: candidate("right") }],
          };
          expect(
            (yield* service.evaluate(f.host, input, "equivalence").pipe(Effect.flip)).code,
          ).toBe("in-progress");
          yield* service.reconcilePrivate();
          expect(yield* service.evaluate(f.host, input, "equivalence")).toMatchObject({
            qualificationId,
            replayed: true,
            inputTokens: 19,
          });
          qualificationId = undefined;
          expect(yield* service.evaluate(f.host, input, "equivalence")).not.toHaveProperty(
            "qualificationId",
          );
          qualificationId = "different-qualified-policy";
          expect(yield* service.evaluate(f.host, input, "equivalence")).not.toHaveProperty(
            "qualificationId",
          );
          bindingAvailable = false;
          expect(yield* service.evaluate(f.host, input, "equivalence")).not.toHaveProperty(
            "qualificationId",
          );
          expect(evaluateCalls).toBe(1);
          expect(
            (yield* service.usage.decisions.getSharedAllowance(f.payerId)).usedInputTokens,
          ).toBe(19);
          const rows = yield* f.sql<{
            qualification_id: string;
          }>`SELECT qualification_id FROM relay_decision_usage_requests WHERE payer_id=${f.payerId}`;
          expect(rows[0]?.qualification_id).toBe("synthetic-qualified-policy");
          bindingAvailable = true;
          qualificationId = "synthetic-qualified-policy";
          yield* f.sql`UPDATE relay_decision_usage_requests SET active_attempt_id=NULL WHERE payer_id=${f.payerId}`;
          expect(yield* service.evaluate(f.host, input, "equivalence")).not.toHaveProperty(
            "qualificationId",
          );
          unknownOnEvaluate = false;
          expect(
            yield* service.evaluate(
              f.host,
              { ...input, requestId: "fresh", runId: "fresh" },
              "equivalence",
            ),
          ).toMatchObject({ qualificationId, replayed: false });
          expect(evaluateCalls).toBe(2);
          expect(
            (yield* service.usage.decisions.getSharedAllowance(f.payerId)).usedInputTokens,
          ).toBe(38);
        }),
      ),
  );
  it.live(
    "reconciles a late private result as operator exposure without debiting the shared allowance",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* fund(f, "decisions");
          const binding = {
            fetch: async (req: Request) => {
              const identity = (await req.json()) as { attemptId: string; policyVersion: string };
              return Response.json(
                new URL(req.url).pathname === "/evaluate"
                  ? { status: "unknown", attemptId: identity.attemptId, reason: "upstream-unknown" }
                  : {
                      status: "completed",
                      attemptId: identity.attemptId,
                      replayed: true,
                      result: {
                        model: "extensions-v1",
                        policyVersion: identity.policyVersion,
                        inputTokens: 77,
                        judgments: [{ targetId: "target", exists: "yes", relevant: "yes" }],
                      },
                    },
              );
            },
          };
          const service = yield* makeExtensionsService(
            parseExtensionsConfig({
              EXTENSIONS_DECISIONS_ENABLED: "true",
              EXTENSIONS_DECISIONS_COHORT: "*",
            }),
            "https://fixture.invalid",
            Effect.succeed(binding),
          );
          yield* service
            .evaluate(
              f.host,
              {
                requestId: "late",
                runId: "late",
                fundingGeneration: 1,
                templateVersion: "decisions-v1",
                targets: [{ id: "target", text: "Use Postgres." }],
                context: "",
                description: "",
              },
              "decisions",
            )
            .pipe(Effect.flip);
          yield* f.sql`UPDATE relay_decision_usage_attempts SET deadline=1 WHERE payer_id=${f.payerId}`;
          yield* service.usage.decisions.reconcile();
          yield* service.reconcilePrivate();
          expect(
            (yield* service.usage.decisions.getSharedAllowance(f.payerId)).usedInputTokens,
          ).toBe(0);
          const rows = yield* f.sql<{
            status: string;
            cost_nano: number;
          }>`SELECT status,cost_nano::float8 FROM relay_decision_usage_attempts WHERE payer_id=${f.payerId}`;
          expect(rows[0]).toEqual({ status: "late", cost_nano: 77 * 42 });
          expect((yield* service.usage.decisions.health).exposureNanoUsd).toBeGreaterThanOrEqual(0);
        }),
      ),
  );
  it.live(
    "migrates existing funding and reserved usage without resetting balances or admitting old writers after promotion",
    () =>
      run(
        Effect.gen(function* () {
          const { $client: sql } = yield* RelayDb;
          const fs = yield* FileSystem.FileSystem;
          const legacyFundingSql = yield* fs.readFileString(
            new URL(
              "../../migrations/postgres/20260923000100_decision_funding/migration.sql",
              import.meta.url,
            ).pathname,
          );
          const legacyUsageSql = yield* fs.readFileString(
            new URL(
              "../../migrations/postgres/20260923000200_decision_usage/migration.sql",
              import.meta.url,
            ).pathname,
          );
          const extensionMigrationSql = yield* fs.readFileString(
            new URL(
              "../../migrations/postgres/20260926000000_extensions_compatibility/migration.sql",
              import.meta.url,
            ).pathname,
          );
          const schema = "extensions_migration_" + NodeCrypto.randomUUID().replaceAll("-", "");
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
              yield* sql.unsafe(`SET LOCAL search_path TO ${schema}`);
              yield* sql`CREATE TABLE relay_billing_accounts(user_id text PRIMARY KEY)`;
              yield* sql.unsafe(legacyFundingSql);
              yield* sql.unsafe(legacyUsageSql);
              yield* sql`INSERT INTO relay_decision_funding(environment_id,public_key,generation,payer_id,state) VALUES ('old-host','old-key',7,'old-payer','active')`;
              yield* sql`INSERT INTO relay_decision_usage_windows(payer_id,window_start,window_end,used_input_tokens,reserved_input_tokens) VALUES ('old-payer',100,200,123,456)`;
              yield* sql`INSERT INTO relay_decision_usage_requests(payer_id,request_id,environment_id,public_key,credential_id,funding_generation,run_id,fingerprint,model,template_version,window_start,window_end,created_at,hold_tokens,debited_input_tokens) VALUES ('old-payer','old-request','old-host','old-key','old-credential',7,'old-run','old-fingerprint','extensions-v1','decisions-v1',100,200,100,456,123)`;
              yield* sql.unsafe(extensionMigrationSql);
              expect(
                (yield* sql<{
                  feature_id: string;
                  generation: number;
                }>`SELECT feature_id,generation FROM relay_decision_funding`)[0],
              ).toEqual({ feature_id: "decisions", generation: 7 });
              expect(
                (yield* sql<{
                  used: number;
                  reserved: number;
                }>`SELECT used_input_tokens::float8 AS used,reserved_input_tokens::float8 AS reserved FROM relay_decision_usage_windows`)[0],
              ).toEqual({ used: 123, reserved: 456 });
              expect(
                (yield* sql<{
                  legacy_fingerprint: string;
                }>`SELECT legacy_fingerprint FROM relay_decision_usage_requests`)[0]
                  ?.legacy_fingerprint,
              ).toBe("old-fingerprint");
              yield* sql`UPDATE relay_extensions_schema SET compatibility_deployments=2 WHERE id=1`;
              yield* sql`SELECT relay_extensions_promote(true,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`;
              yield* sql`SELECT set_config('lecturn.extensions_reservation_epoch','1',true)`;
              yield* sql`INSERT INTO relay_decision_funding(feature_id,environment_id,public_key,generation,payer_id,state) VALUES ('contextual','old-host','old-key',1,'old-payer','active')`;
              expect((yield* sql`SELECT 1 FROM relay_decision_usage_windows`).length).toBe(1);
              expect((yield* sql`SELECT 1 FROM relay_decision_funding`).length).toBe(2);
              yield* sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
            }),
          );
        }),
      ),
  );
  it.live("cleanup advances only after unresolved financial proof has been settled", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* fund(f, "decisions");
        const store = yield* makeExtensionsUsageStore({ ...f.config, featureId: "decisions" });
        const admitted = yield* store.reserve({
          principal: f.host,
          payerId: f.payerId,
          fundingGeneration: 1,
          requestId: "cleanup",
          runId: "cleanup",
          fingerprint: "fingerprint",
          templateVersion: "decisions-v1",
          model: "extensions-v1",
          backend: "private-evaluator",
        });
        if (admitted.kind !== "admitted") throw new Error("Expected admission");
        yield* store.markDispatched(admitted.attemptId);
        yield* store.markUnknown(admitted.attemptId);
        const oldEpoch = f.now - 172800;
        yield* f.sql`UPDATE relay_decision_usage_attempts SET created_at=${oldEpoch} WHERE id=${admitted.attemptId}`;
        const watermarks: number[] = [];
        const binding = {
          fetch: async (request: Request) => {
            const body = (await request.json()) as { minimumAdmissibilityEpoch: number };
            watermarks.push(body.minimumAdmissibilityEpoch);
            return Response.json({ status: "cleaned" });
          },
        };
        const service = yield* makeExtensionsService(
          parseExtensionsConfig({
            EXTENSIONS_DECISIONS_ENABLED: "true",
            EXTENSIONS_DECISIONS_COHORT: "*",
          }),
          "https://fixture.invalid",
          Effect.succeed(binding),
        );
        yield* service.cleanupPrivate();
        expect(watermarks).toEqual([oldEpoch]);
        yield* store.refuse(admitted.attemptId);
        yield* f.sql`UPDATE relay_extensions_evaluator_cleanup SET next_check_at=0 WHERE environment_id=${f.host.environmentId}`;
        yield* service.cleanupPrivate();
        expect(watermarks[1]).toBeGreaterThan(oldEpoch);
        expect(watermarks[1]).toBeLessThanOrEqual(f.now - 86400 + 1);
      }),
    ),
  );
});
