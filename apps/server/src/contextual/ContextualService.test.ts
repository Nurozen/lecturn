import type { ExtensionsResults, ExtensionsPayloads } from "../extensions/ExtensionsSupervisor.ts";
import { assert, it } from "@effect/vitest";
import * as C from "@lecturn/contracts";
import { Deferred, Effect, Fiber, Layer, Queue, Result, Schema, Stream } from "effect";
import { ContextualNotifications, make as makeNotifications } from "./ContextualNotifications.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ExtensionsRuntime } from "../extensions/ExtensionsRuntime.ts";
import { ExtensionsCloudClient } from "../extensions/ExtensionsCloudClient.ts";
import { DecisionCandidates, completeCoverage, decisionCandidate } from "./DecisionCandidates.ts";
import {
  contextualBoundary,
  ContextualSettings,
  make as makeSettings,
} from "./ContextualSettings.ts";
import { ContextualRepository, make as makeRepository } from "./ContextualRepository.ts";
import { ContextualPurge, make as makePurge, emptyPolicy } from "./ContextualPurge.ts";
import { ContextualGroups, make as makeGroups } from "./ContextualGroups.ts";
import { DecisionRepository } from "../threadDecisions/DecisionRepository.ts";
import {
  readContextualOrigins,
  recordContextualLineage,
} from "../threadDecisions/DecisionContextualLineage.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderUnsupportedError } from "../provider/Errors.ts";
import { make, routineFollowup } from "./ContextualService.ts";
import { applyContextualLifecycle } from "../orchestration/ContextualLifecycle.ts";
import { nativeContextualFixture } from "./ContextualNativeTestFixture.ts";
import { applyContextualSelection, contextualEvidenceCovered } from "./ContextualSelection.ts";
import { contextualPacketText } from "./ContextualPacketText.ts";
import { HostProcessPlatform, HostProcessArchitecture } from "@lecturn/shared/hostProcess";

const environmentId = C.EnvironmentId.make("synthetic-env");
const projectId = C.ProjectId.make("synthetic-project");
const threadId = C.ThreadId.make("synthetic-thread");
const at = "2026-09-25T00:00:00.000Z";
const sourceId = "slack:synthetic";
const decisionSourceId = `decisions:${projectId}`;
const unavailable = new C.ContextualError({
  code: "unavailable",
  message: "Synthetic offline helper",
});
const candidate = (id = "a"): C.ContextualSlackCandidate => ({
  id,
  sourceId,
  sourceKind: "slack",
  occurrenceId: id,
  recordRevision: 1,
  guidanceId: id,
  contentFingerprint: id,
  lineageIds: [],
  coverage: completeCoverage,
  state: "not-yet-evaluated",
  workspaceId: "w",
  channelId: "c",
  messageTs: "1.1",
  threadTs: null,
  evidence: [
    {
      id: `e-${id}`,
      sourceId,
      sourceKind: "slack",
      occurrenceId: id,
      sourceRevision: 1,
      sourceHash: id,
      canonicalVersion: "v1",
      coordinateSystem: "utf16",
      quote: "Use SQLite",
      start: 0,
      end: 10,
      prefix: "",
      suffix: "",
      author: "Synthetic",
      occurredAt: at,
      observedAt: at,
      sourceUrl: null,
      availability: "available",
      lineageIds: [],
      locator: {
        sourceKind: "slack",
        workspaceId: "w",
        channelId: "c",
        messageTs: "1.1",
        threadTs: null,
      },
    },
  ],
});
const savedCandidate = (
  id: string,
  revision = 1,
  quote = "Use SQLite",
): C.ContextualDecisionCandidate => {
  const original = candidate(id);
  return {
    ...original,
    sourceId: decisionSourceId,
    sourceKind: "lecturn-decision",
    recordRevision: revision,
    contentFingerprint: `${id}:${revision}:${quote}`,
    environmentId,
    projectId,
    threadId: C.ThreadId.make("source-thread"),
    decisionId: C.DecisionId.make(id),
    decisionRevision: revision,
    attribution: "user-directed",
    reviewState: "confirmed",
    lifecycle: "current",
    replacementIds: [],
    derivedSummary: { title: quote, body: quote, rationale: null, userEdited: false },
    evidence: original.evidence.map((e) => ({
      ...e,
      sourceId: decisionSourceId,
      sourceKind: "lecturn-decision",
      sourceRevision: revision,
      sourceHash: `${id}:${revision}`,
      quote,
      end: quote.length,
      locator: {
        sourceKind: "lecturn-decision",
        environmentId,
        projectId,
        threadId: C.ThreadId.make("source-thread"),
        messageId: C.MessageId.make(`source-message-${id}`),
        messageRole: "user",
        decisionId: C.DecisionId.make(id),
        evidenceId: e.id,
      },
    })),
  };
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = (runtime?: ExtensionsRuntime["Service"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of [
      "contextual_host_state",
      "contextual_project_settings",
      "contextual_thread_settings",
      "contextual_preparations",
      "contextual_packets",
      "contextual_receipts",
      "contextual_supply",
      "contextual_lineage",
      "contextual_suppression",
      "contextual_purge_jobs",
      "contextual_actions",
      "contextual_conflicts",
      "contextual_outbox",
      "contextual_exclusions",
      "contextual_evaluations",
      "contextual_candidate_observations",
      "contextual_group_members",
      "contextual_decision_groups",
      "contextual_inherited_disclosures",
    ])
      yield* sql`DELETE FROM ${sql(table)}`;
    yield* sql`INSERT OR REPLACE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${projectId},'Synthetic','/tmp/contextual','[]',${at},${at})`;
    yield* sql`INSERT OR REPLACE INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES(${threadId},${projectId},'Synthetic','{}',${at},${at},'full-access','default')`;
    const notifications = yield* makeNotifications;
    const settings = yield* makeSettings.pipe(
      Effect.provideService(ContextualNotifications, notifications),
    );
    yield* settings.updateProject({
      projectId,
      defaultEnabled: true,
      sourceIds: [decisionSourceId],
      expectedRevision: 0,
    });
    yield* settings.updateThread({
      threadId,
      enabled: true,
      sourceIds: [decisionSourceId],
      expectedRevision: 0,
    });
    const repository = yield* makeRepository;
    let candidates: C.ContextualCandidate[] = [candidate()];
    let evaluateCalls = 0;
    let conflictCalls = 0;
    const comparisonRequests: C.ContextualComparisonPair[] = [];
    let conflict = false;
    let retrievalFails = false;
    const invalidOccurrences = new Set<string>();
    let selectedSpans: C.ContextualJudgment["selectedEvidenceSpans"];
    let evaluationComplete = true;
    let usefulScore = 1;
    let sufficientContext = 1;
    let helperCandidates: C.ContextualCandidate[] = [];
    let fundingEligible = true;
    let fundingUnavailable = false;
    let fundingAllowance: C.ExtensionFundingStatusResult["allowance"] = null;
    let fundingWait: Effect.Effect<void> = Effect.void;
    let captureState: C.ContextualCaptureStatusResult["state"] = "paused";
    let captureGeneration = 0;
    let nativePolicy = emptyPolicy;
    let nativePurgeGeneration = 0;
    const retrieveRequests: C.ContextualRetrieveRequest[] = [];
    const captureRequests: C.ContextualCaptureSetStateRequest[] = [];
    let purgeFails = false;
    const helper: ExtensionsRuntime["Service"] = runtime ?? {
      hostName: "Synthetic",
      environmentId,
      describe: Effect.succeed(null),
      readExport: () => Effect.fail(unavailable),
      request: <O extends C.ExtensionsHelperRequest["operation"]>(
        operation: O,
        payload: ExtensionsPayloads[O],
      ) =>
        Effect.gen(function* () {
          if (operation === "contextual.capture.status")
            return {
              state: captureState,
              reason: "requested",
              generation: captureGeneration,
              sourceGeneration: 0,
              purgeGeneration: nativePurgeGeneration,
              receiptId: "capture",
              observedAt: at,
              capturedRecords: 0,
              coverage: "unknown",
            } as ExtensionsResults[O];
          if (operation === "contextual.capture.setState") {
            const request = payload as C.ContextualCaptureSetStateRequest;
            assert.equal(request.expectedGeneration, captureGeneration);
            captureRequests.push(request);
            captureState = request.state;
            captureGeneration++;
            return {
              state: captureState,
              reason: "requested",
              generation: captureGeneration,
              sourceGeneration: 0,
              purgeGeneration: nativePurgeGeneration,
              receiptId: "capture",
              observedAt: at,
              capturedRecords: 0,
              coverage: "unknown",
            } as ExtensionsResults[O];
          }
          if (operation === "contextual.data.forget") {
            const hosts = yield* sql<{
              purge_generation: number;
            }>`SELECT purge_generation FROM contextual_host_state WHERE singleton=1`;
            assert.isAbove(
              hosts[0]!.purge_generation,
              0,
              "host fence must commit before helper forget",
            );
            if (purgeFails) return yield* unavailable;
            return {
              jobId: "job",
              actionId: (payload as C.ContextualDataForgetRequest).actionId,
              operation: "forget",
              state: "completed",
              sourceGeneration: 2,
              purgeGeneration: 1,
              artifactId: null,
              affectedRecords: 1,
              updatedAt: at,
            } as ExtensionsResults[O];
          }
          if (operation === "contextual.retrieve") {
            if (retrievalFails) return yield* unavailable;
            retrieveRequests.push(payload as C.ContextualRetrieveRequest);
            return {
              candidates: helperCandidates,
              coverage: { ...completeCoverage, complete: false, unexaminedCount: 1 },
              sourceGeneration: 2,
              purgeGeneration: nativePurgeGeneration,
            } as unknown as ExtensionsResults[O];
          }
          if (operation === "contextual.sources.configure") {
            nativePolicy = (payload as C.ContextualSourcesConfigureRequest).policy;
            return { policy: nativePolicy, sourceGeneration: 2 } as ExtensionsResults[O];
          }
          if (operation === "contextual.evidence.read") {
            const request = payload as C.ContextualEvidenceReadRequest;
            const evidence = candidates
              .flatMap((value) => value.evidence)
              .find((value) => value.id === request.evidenceId);
            if (!evidence) return yield* unavailable;
            return { evidence, purgeGeneration: nativePurgeGeneration } as ExtensionsResults[O];
          }
          if (operation === "contextual.sources.list")
            return {
              sources: [],
              nextCursor: null,
              policy: nativePolicy,
              sourceGeneration: 2,
            } as unknown as unknown as ExtensionsResults[O];
          return yield* unavailable;
        }).pipe(Effect.mapError(contextualBoundary)),
    };
    const cloud: ExtensionsCloudClient["Service"] = {
      reconcilePending: Effect.void,
      status: () =>
        Effect.gen(function* () {
          yield* fundingWait;
          return {
            featureId: "contextual",
            environmentId,
            state: fundingUnavailable ? "unavailable" : "active",
            generation: 1,
            accountLabel: "Synthetic",
            eligible: !fundingUnavailable && fundingEligible,
            reason: fundingUnavailable ? "unavailable" : fundingEligible ? "eligible" : "not-paid",
            allowance: fundingAllowance,
            remoteRevocationPending: false,
          } satisfies C.ExtensionFundingStatusResult;
        }),
      funding: () => Effect.fail(unavailable),
      pending: () => Effect.succeed(null),
      equivalence: () => Effect.fail(unavailable),
      evaluate: (input) => {
        evaluateCalls++;
        return Effect.succeed({
          requestId: input.requestId,
          runId: input.runId,
          templateVersion: "contextual-v1",
          policyVersion: "contextual-v1",
          model: "synthetic",
          judgments: input.targets.map((t) => ({
            targetId: t.id,
            useful: usefulScore,
            usableEvidence: 1,
            contradicts: 0,
            sufficientContext,
            reasons: ["constraint"],
            selectedEvidenceIds:
              selectedSpans?.map((e) => e.evidenceId) ?? t.evidence.map((e) => e.id),
            ...(selectedSpans ? { selectedEvidenceSpans: selectedSpans } : {}),
            evaluationComplete,
          })),
          inputTokens: 1,
          allowance: {
            poolId: "pool",
            basis: "grant",
            windowStart: at,
            windowEnd: "2026-10-25T00:00:00.000Z",
            limitInputTokens: 100,
            usedInputTokens: 1,
            reservedInputTokens: 0,
            remainingInputTokens: 99,
            byFeature: [{ featureId: "contextual", usedInputTokens: 1, reservedInputTokens: 0 }],
          },
          replayed: false,
        } satisfies C.ContextualEvaluationResult);
      },
      conflicts: (input) => {
        conflictCalls++;
        comparisonRequests.push(...input.pairs);
        return Effect.succeed({
          requestId: input.requestId,
          runId: input.runId,
          policyVersion: "contextual-v1",
          model: "synthetic",
          judgments: input.pairs.map((p) => ({
            pairId: p.id,
            relation: conflict && !p.right.id.startsWith("live:") ? "incompatible" : "compatible",
            materialToTask: 1,
            leftEvidenceIds: p.left.evidence.map((e) => e.id),
            rightEvidenceIds: p.right.evidence.map((e) => e.id),
            reasons: ["conflict"],
          })),
          coverage: completeCoverage,
          inputTokens: 1,
          allowance: {
            poolId: "pool",
            basis: "grant",
            windowStart: at,
            windowEnd: "2026-10-25T00:00:00.000Z",
            limitInputTokens: 100,
            usedInputTokens: 1,
            reservedInputTokens: 0,
            remainingInputTokens: 99,
            byFeature: [{ featureId: "contextual", usedInputTokens: 1, reservedInputTokens: 0 }],
          },
          replayed: false,
        } satisfies C.ContextualConflictCheckResult);
      },
    };
    const adapter: DecisionCandidates["Service"] = {
      retrieve: () => Effect.succeed(candidates as C.ContextualDecisionCandidate[]),
      revalidate: () => Effect.succeed(true),
      candidate: () => Effect.succeed(null),
      revalidateGroup: (group) => Effect.succeed(!invalidOccurrences.has(group.occurrenceId)),
    };
    const groups: ContextualGroups["Service"] = {
      group: () => Effect.fail(unavailable),
      mutateGroup: () => Effect.fail(unavailable),
      undoGroup: () => Effect.fail(unavailable),
      ensure: () => Effect.succeed("group"),
    };
    const purge = yield* makePurge.pipe(Effect.provideService(ExtensionsRuntime, helper));
    let providerDriver: string | null = "codex";
    let providerEnabled = true;
    const resolvedInstances: C.ProviderInstanceId[] = [];
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mock(ProviderService)({
          getInstanceInfo: (instanceId) => {
            resolvedInstances.push(instanceId);
            if (providerDriver === null)
              return Effect.fail(new ProviderUnsupportedError({ provider: instanceId }));
            const driverKind = C.ProviderDriverKind.make(providerDriver);
            return Effect.succeed({
              instanceId,
              driverKind,
              enabled: providerEnabled,
              displayName: undefined,
              continuationIdentity: { driverKind, continuationKey: "synthetic-provider" },
            });
          },
        }),
      ),
      Effect.provideService(ContextualNotifications, notifications),
      Effect.provideService(ContextualSettings, settings),
      Effect.provideService(ContextualRepository, repository),
      Effect.provideService(ExtensionsRuntime, helper),
      Effect.provideService(ExtensionsCloudClient, cloud),
      Effect.provideService(DecisionCandidates, adapter),
      Effect.provideService(ContextualPurge, purge),
      Effect.provideService(ContextualGroups, groups),
    );
    yield* service.fundingStatus({ featureId: "contextual" });
    const task = (text = "Implement database storage", submission = "submission") =>
      service.taskSnapshot({
        threadId,
        submissionId: submission,
        messageId: C.MessageId.make(submission),
        providerInstanceId: "provider",
        newestMessage: text,
        recentContext: "",
      });
    return {
      resolvedInstances,
      setProvider: (driver: string | null, enabled = true) => {
        providerDriver = driver;
        providerEnabled = enabled;
      },
      setRetrievalFails: () => {
        retrievalFails = true;
      },
      sql,
      helper,
      settings,
      repository,
      service,
      purge,
      task,
      captureRequests,
      retrieveRequests,
      setNativeGenerations: () => {
        nativePolicy = { ...emptyPolicy, revision: 7, allowedSourceIds: [sourceId] };
        nativePurgeGeneration = 11;
      },
      setFundingWait: (wait: Effect.Effect<void>) => {
        fundingWait = wait;
      },
      setAllowance: (value: C.ExtensionFundingStatusResult["allowance"]) => {
        fundingAllowance = value;
      },
      setFundingUnavailable: () => {
        fundingUnavailable = true;
      },
      setFunding: (value: boolean) => {
        fundingEligible = value;
      },
      setSufficientContext: (value: number) => {
        sufficientContext = value;
      },
      setHelperCandidates: (value: C.ContextualCandidate[]) => {
        helperCandidates = value;
      },
      setSelection: (value: C.ContextualJudgment["selectedEvidenceSpans"], complete = true) => {
        selectedSpans = value;
        evaluationComplete = complete;
      },
      setUseful: (value: number) => {
        usefulScore = value;
      },
      setCandidates: (value: C.ContextualCandidate[]) => {
        candidates = value;
      },
      invalidateOccurrence: (id: string) => {
        invalidOccurrences.add(id);
      },
      setConflict: () => {
        conflict = true;
      },
      setPurgeFails: (value: boolean) => {
        purgeFails = value;
      },
      calls: () => ({ evaluateCalls, conflictCalls }),
      comparisonRequests,
    };
  });
it.layer(SqlitePersistenceMemory)("Contextual service", (it) => {
  it.effect("reports provider readiness from the next-turn instance without paid preparation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const instanceId = C.ProviderInstanceId.make("custom-account-instance");
      const selection = encode({ instanceId, model: "selected-model" });
      yield* f.sql`UPDATE projection_threads SET model_selection_json=${selection} WHERE thread_id=${threadId}`;
      // A previous Claude session must not override a newly selected Codex instance.
      yield* f.sql`INSERT OR REPLACE INTO projection_thread_sessions(thread_id,status,provider_name,provider_instance_id,updated_at) VALUES(${threadId},'ready','claude','previous-account',${at})`;
      for (const [driver, enabled, expected] of [
        ["codex", true, "ready"],
        ["cursor", true, "ready"],
        ["grok", true, "ready"],
        ["opencode", true, "ready"],
        ["antigravity", true, "ready"],
        ["claude", true, "unsupported-provider"],
        ["claudeAgent", true, "unsupported-provider"],
        ["future-driver", true, "unsupported-provider"],
        [null, true, "unavailable"],
        ["codex", false, "unavailable"],
      ] as const) {
        f.setProvider(driver, enabled);
        const status = yield* f.service.status({ threadId });
        assert.strictEqual(status.effective.reason, expected);
        assert.strictEqual(status.effective.effective, expected === "ready");
        assert.isTrue(status.effective.enabled);
        assert.isTrue(status.effective.decisionsAvailable);
        assert.isNull(status.preparation);
      }
      assert.deepStrictEqual(f.resolvedInstances, Array(10).fill(instanceId));
      assert.deepStrictEqual(f.calls(), { evaluateCalls: 0, conflictCalls: 0 });
      assert.lengthOf(f.retrieveRequests, 0);
    }),
  );
  it.effect("keeps missing-model drafts unavailable and disabled threads off", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const draft = yield* f.service.status({ threadId });
      assert.strictEqual(draft.effective.reason, "unavailable");
      assert.isFalse(draft.effective.effective);
      assert.lengthOf(f.resolvedInstances, 0);
      const thread = yield* f.settings.thread(threadId);
      yield* f.settings.updateThread({
        threadId,
        enabled: false,
        sourceIds: thread.sourceIds,
        expectedRevision: thread.revision,
      });
      assert.strictEqual((yield* f.service.status({ threadId })).effective.reason, "off");
      assert.deepStrictEqual(f.calls(), { evaluateCalls: 0, conflictCalls: 0 });
    }),
  );
  it.effect(
    "reports optional retrieval failure as skipped rather than claiming no useful evidence",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setCandidates([]);
        f.setRetrievalFails();
        f.setNativeGenerations();
        yield* f.sql`UPDATE contextual_host_state SET source_policy_json=${encode({ ...emptyPolicy, allowedSourceIds: [sourceId] })} WHERE singleton=1`;
        yield* f.settings.updateProject({
          projectId,
          expectedRevision: 1,
          defaultEnabled: true,
          sourceIds: [sourceId],
        });
        yield* f.settings.updateThread({
          threadId,
          expectedRevision: 1,
          enabled: true,
          sourceIds: [sourceId],
        });
        const p = yield* f.service.prepare(yield* f.task(), "{}");
        assert.equal(p.state, "skipped");
        assert.equal(p.skipReason, "source-unavailable");
        assert.equal((yield* f.repository.get(p.id)).skipReason, "source-unavailable");
        assert.isFalse(p.coverage.complete);
        assert.equal(f.calls().evaluateCalls, 0);
      }),
  );
  it.effect(
    "works with saved Decisions when the helper is unavailable and does not drain on thanks",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.isTrue((yield* f.service.status({ threadId })).effective.decisionsAvailable);
        assert.isFalse((yield* f.service.status({ threadId })).effective.slackAvailable);
        const p = yield* f.service.prepare(yield* f.task(), "{}");
        assert.equal(p.state, "prepared");
        assert.equal(f.calls().evaluateCalls, 1);
        const thanks = yield* f.service.prepare(yield* f.task("Thanks!", "thanks"), "{}");
        assert.equal(thanks.state, "no-useful-context");
        assert.equal(f.calls().evaluateCalls, 1);
        assert.isTrue(routineFollowup("continue"));
        assert.isFalse(routineFollowup("Continue with SQLite instead of Postgres"));
      }),
  );
  it.effect("records only the chosen conflict side as the final supplied packet origin", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setCandidates([savedCandidate("left"), savedCandidate("right")]);
      f.setConflict();
      const p = yield* f.service.prepare(yield* f.task(), "{}");
      const conflict = (yield* f.service.conflicts({ threadId, preparationId: p.id })).items[0]!;
      yield* f.service.resolveConflict({
        actionId: "choose-right",
        threadId,
        taskFingerprint: p.task.taskFingerprint,
        conflictId: conflict.id,
        expectedRevision: conflict.revision,
        leftRevision: conflict.pair.left.revision,
        rightRevision: conflict.pair.right.revision,
        action: "use-right",
        clarification: null,
      });
      const packet = yield* f.repository.packet(p.packetId!, threadId);
      assert.equal(packet?.groups[0]?.occurrenceId, "right");
      const origins = yield* f.sql<{
        source_evidence_id: string;
      }>`SELECT source_evidence_id FROM contextual_lineage WHERE entity_kind='packet-origin' AND entity_id=${p.packetId!}`;
      assert.deepEqual(
        origins.map((o) => o.source_evidence_id),
        packet!.groups[0]!.evidence.map((e) => e.id),
      );
    }),
  );
  it.effect("persists conflict holds and never releases them during recovery", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setCandidates([candidate("a"), candidate("b")]);
      f.setConflict();
      const p = yield* f.service.prepare(yield* f.task(), "{}");
      assert.equal(p.state, "awaiting-conflict-review");
      assert.equal(p.conflictIds.length, 1);
      for (let index = 0; index < 20; index++)
        yield* f.sql`INSERT INTO contextual_conflicts(id,thread_id,preparation_id,revision,relation_json,resolution_json,status,updated_at) SELECT ${`000-history-${index}`},thread_id,'old-preparation',revision,relation_json,NULL,'resolved',updated_at FROM contextual_conflicts WHERE id=${p.conflictIds[0]!}`;
      const current = yield* f.service.conflicts({ threadId, preparationId: p.id, limit: 1 });
      assert.deepEqual(
        current.items.map((c) => c.id),
        p.conflictIds,
      );
      assert.isNull(current.nextCursor);
      yield* f.service.recover();
      assert.equal((yield* f.repository.get(p.id)).state, "awaiting-conflict-review");
      const skipped = yield* f.service.preparationAction({
        actionId: "skip",
        preparationId: p.id,
        expectedRevision: p.revision,
        action: "send-without-context",
      });
      assert.equal(skipped.state, "skipped");
      assert.equal(skipped.skipReason, "user-requested");
    }),
  );
  it.effect(
    "invalidates a preparation before helper failure and retries the same durable purge after restart",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const p = yield* f.service.prepare(yield* f.task(), "{}");
        f.setPurgeFails(true);
        const request: C.ContextualDataForgetRequest = {
          actionId: "forget",
          selection: { kind: "sources", sourceIds: [sourceId] },
          expectedSourceGeneration: 1,
          expectedPurgeGeneration: 0,
        };
        assert.isTrue(Result.isFailure(yield* f.service.forget(request).pipe(Effect.result)));
        assert.equal((yield* f.repository.get(p.id)).state, "skipped");
        assert.isNull(yield* f.repository.packet(p.packetId!, threadId));
        f.setPurgeFails(false);
        yield* f.purge.recover();
        const jobs = yield* f.sql<{ state: string }>`SELECT state FROM contextual_purge_jobs`;
        assert.equal(jobs[0]?.state, "completed");
        const receipt = yield* f.service.forget(request);
        assert.equal(receipt.jobId, "job");
      }),
  );
  it.effect(
    "suppresses unknown supply across an unverified epoch and scope changes invalidate handoff",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const task = yield* f.task();
        yield* f.sql`INSERT INTO contextual_supply(thread_id,guidance_id,fingerprint,context_epoch,packet_id,dispatch_id,message_id,source_revision,acceptance,supplied_at) VALUES(${threadId},'a','a','old','packet','dispatch','message',1,'unknown',${at})`;
        assert.equal((yield* f.service.prepare(task, "{}")).state, "no-useful-context");
        assert.equal(f.calls().evaluateCalls, 0);
        const next = yield* f.task("Choose storage", "next");
        yield* f.settings.updateThread({
          threadId,
          expectedRevision: 1,
          enabled: false,
          sourceIds: [decisionSourceId],
        });
        assert.isTrue(
          Result.isFailure(
            yield* f.service.prepare(next, encode({ id: "continuation" })).pipe(Effect.result),
          ),
        );
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual explicit reuse controls", (it) => {
  it.effect(
    "preserves exclusions across real merges, undo and detached aliases without excluding unrelated guidance",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const notes = new Map(
          ["a", "b", "c"].map((id): [string, C.ThreadDecision] => [
            id,
            {
              id: C.DecisionId.make(id),
              projectId,
              threadId,
              threadTitle: null,
              title: "Use SQLite",
              body: "Use SQLite",
              rationale: null,
              comment: null,
              attribution: "user-directed",
              reviewState: "confirmed",
              lifecycle: "current",
              userEdited: false,
              revision: 1,
              occurrence: 1,
              occurredAt: at,
              createdAt: at,
              updatedAt: at,
              relationships: [],
              evidence: [],
              provenance: {
                descriptionRevision: 0,
                sourceFingerprint: id,
                canonicalVersion: "1",
                templateVersion: "1",
                detectorModel: "synthetic",
                writerSelection: {
                  instanceId: C.ProviderInstanceId.make("synthetic"),
                  model: "synthetic",
                },
                writerConfigurationGeneration: "1",
                identityConfidence: "configuration-only",
              },
            },
          ]),
        );
        const unavailable = new C.ThreadDecisionError({
          code: "not-found",
          message: "Synthetic missing",
        });
        const repository: DecisionRepository["Service"] = {
          get: ({ id }) =>
            notes.has(id) ? Effect.succeed(notes.get(id)!) : Effect.fail(unavailable),
          list: () => Effect.fail(unavailable),
          mutate: () => Effect.fail(unavailable),
          export: () => Effect.fail(unavailable),
          createFromWriter: () => Effect.fail(unavailable),
          addEvidence: () => Effect.fail(unavailable),
          projectRevision: () => Effect.succeed(0),
          bumpRevision: () => Effect.succeed(0),
        };
        const groups = yield* makeGroups.pipe(
          Effect.provideService(DecisionRepository, repository),
          Effect.provideService(ExtensionsRuntime, f.helper),
        );
        const excluded = Effect.fn(function* (guidanceId: string, value = true) {
          yield* f.service.exclude({
            actionId: `exclude-${guidanceId}-${value}`,
            threadId,
            guidanceId,
            excluded: value,
            expectedRevision: (yield* f.settings.thread(threadId)).exclusionRevision,
          });
        });
        const check = Effect.fn(function* (
          id: string,
          expected: C.ContextualPreparationState,
          epoch: string,
        ) {
          const membership = yield* f.sql<{
            group_id: string;
          }>`SELECT group_id FROM contextual_group_members WHERE decision_id=${id}`;
          f.setCandidates([
            {
              ...savedCandidate(id),
              guidanceId: membership[0] ? `group:${membership[0].group_id}` : `decision:${id}`,
            },
          ]);
          if (epoch.startsWith("refresh:"))
            yield* f.service.refresh({
              actionId: epoch,
              threadId,
              expectedRevision: (yield* f.settings.thread(threadId)).revision,
            });
          else
            yield* f.sql`UPDATE contextual_thread_settings SET context_epoch=${epoch} WHERE thread_id=${threadId}`;
          const calls = f.calls();
          const prepared = yield* f.service.prepare(
            yield* f.task("Implement database storage", epoch),
            "{}",
          );
          assert.equal(prepared.state, expected);
          if (expected === "no-useful-context") assert.deepEqual(f.calls(), calls);
          return prepared;
        });
        const delivered = yield* check("a", "prepared", "initial");
        yield* f.repository.update(
          {
            ...delivered,
            state: "dispatching",
            dispatchId: "excluded-original",
            revision: delivered.revision + 1,
          },
          delivered.revision,
        );
        yield* f.service.recover();
        yield* excluded("decision:a");
        // ensure and mutateGroup are the production merge path, including its group identity change.
        yield* groups.ensure(notes.get("a")!);
        const merged = yield* groups.mutateGroup({
          actionId: "merge-ab",
          groupId: "a",
          expectedRevision: 0,
          canonicalDecisionId: C.DecisionId.make("a"),
          occurrenceId: C.DecisionId.make("b"),
          expectedOccurrenceRevision: 1,
          action: "merge",
        });
        yield* check("a", "no-useful-context", "refresh:merged");
        yield* check("b", "no-useful-context", "compaction:merged");
        yield* groups.undoGroup({
          actionId: "undo-ab",
          mergeId: "merge-ab",
          groupId: "a",
          expectedRevision: merged.revision,
          expectedOccurrenceRevision: 1,
        });
        yield* check("a", "no-useful-context", "refresh:undo-a");
        yield* check("b", "prepared", "refresh:undo-b");
        yield* excluded("group:a", false);
        yield* check("a", "prepared", "refresh:restored-a");
        const again = yield* groups.mutateGroup({
          actionId: "merge-again",
          groupId: "a",
          expectedRevision: 2,
          canonicalDecisionId: C.DecisionId.make("a"),
          occurrenceId: C.DecisionId.make("b"),
          expectedOccurrenceRevision: 1,
          action: "merge",
        });
        yield* excluded("group:a");
        yield* groups.mutateGroup({
          actionId: "detach-b",
          groupId: "a",
          expectedRevision: again.revision,
          canonicalDecisionId: C.DecisionId.make("a"),
          occurrenceId: C.DecisionId.make("b"),
          expectedOccurrenceRevision: 1,
          action: "detach",
        });
        yield* check("b", "no-useful-context", "compaction:detached-b");
        yield* groups.mutateGroup({
          actionId: "merge-ac",
          groupId: "a",
          expectedRevision: 4,
          canonicalDecisionId: C.DecisionId.make("a"),
          occurrenceId: C.DecisionId.make("c"),
          expectedOccurrenceRevision: 1,
          action: "merge",
        });
        yield* check("c", "no-useful-context", "refresh:alias-c");
        yield* groups.undoGroup({
          actionId: "undo-ac",
          mergeId: "merge-ac",
          groupId: "a",
          expectedRevision: 5,
          expectedOccurrenceRevision: 1,
        });
        yield* check("c", "prepared", "refresh:unrelated-c");
        yield* excluded("decision:b", false);
        yield* check("b", "prepared", "refresh:restored-b");
        yield* check("a", "no-useful-context", "refresh:still-excluded-a");
      }),
  );

  it.effect("consumes explicit refresh once and derives provider-confirmed compaction epochs", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.service.refresh({ actionId: "refresh", threadId, expectedRevision: 1 });
      const task = yield* f.task("Refresh database context", "refresh-turn");
      assert.equal(task.trigger, "refresh");
      yield* f.service.prepare(task, "{}");
      assert.equal((yield* f.task("Another task", "after-refresh")).trigger, "submission");
      yield* f.sql`UPDATE contextual_thread_settings SET context_epoch='compaction:verified' WHERE thread_id=${threadId}`;
      assert.equal(
        (yield* f.task("Another task", "after-compaction")).trigger,
        "confirmed-compaction",
      );
      const thanks = yield* f.service.prepare(
        yield* f.task("thanks", "after-compaction-thanks"),
        "{}",
      );
      assert.equal(thanks.state, "no-useful-context");
    }),
  );
  it.effect("forgets local Decision reuse while offline without deleting saved notes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setPurgeFails(true);
      const result = yield* f.service.forget({
        actionId: "local-forget",
        selection: { kind: "sources", sourceIds: [decisionSourceId] },
        expectedSourceGeneration: 0,
        expectedPurgeGeneration: 0,
      });
      assert.equal(result.state, "completed");
      assert.deepEqual((yield* f.settings.thread(threadId)).sourceIds, []);
      const suppressions = yield* f.sql<{
        entity_id: string;
      }>`SELECT entity_id FROM contextual_suppression WHERE entity_kind='source'`;
      assert.equal(suppressions[0]?.entity_id, decisionSourceId);
    }),
  );
  it.effect(
    "forgets an expired Slack occurrence and suppresses its derived Decision without deleting the saved note",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const prepared = yield* f.service.prepare(yield* f.task(), "{}");
        assert.isNotNull(prepared.packetId);
        yield* f.repository.update(
          {
            ...prepared,
            state: "dispatching",
            dispatchId: "expired-dispatch",
            revision: prepared.revision + 1,
          },
          prepared.revision,
        );
        yield* f.service.recover();
        yield* f.sql`UPDATE contextual_packets SET packet_json=NULL,payload_bytes=0,retention='expired' WHERE id=${prepared.packetId}`;
        const origins = yield* readContextualOrigins(f.sql, threadId, "derived-job");
        assert.equal(origins.origins[0]?.quote, null);
        assert.equal(origins.origins[0]?.sourceHash, null);
        const decisionId = C.DecisionId.make("derived-decision");
        yield* recordContextualLineage(
          f.sql,
          "derived-job",
          decisionId,
          origins.origins.map((o) => o.evidenceId),
        );
        yield* f.sql`INSERT INTO thread_decisions(id,project_id,thread_id,thread_title,title,body,attribution,source_sequence,occurred_at,created_at,updated_at,provenance_json,action_key) VALUES(${decisionId},${projectId},${threadId},'Synthetic','Use SQLite','Keep this saved note','user-directed',1,${at},${at},${at},'{}','derived-action')`;
        const saved = yield* f.sql`SELECT * FROM thread_decisions WHERE id=${decisionId}`;
        const lineage = yield* f.sql<{
          source_evidence_id: string;
        }>`SELECT source_evidence_id FROM contextual_lineage WHERE entity_kind='decision' AND entity_id=${decisionId}`;
        assert.includeMembers(
          lineage.map((row) => row.source_evidence_id),
          ["e-a", "occurrence:a"],
        );
        const derived = decisionCandidate(
          {
            id: decisionId,
            projectId,
            threadId: C.ThreadId.make("another-thread"),
            threadTitle: null,
            title: "Use SQLite",
            body: "Keep this saved note",
            rationale: null,
            comment: null,
            attribution: "user-directed",
            reviewState: "confirmed",
            lifecycle: "current",
            userEdited: false,
            revision: 1,
            occurrence: 1,
            occurredAt: at,
            createdAt: at,
            updatedAt: at,
            relationships: [],
            provenance: {
              descriptionRevision: 1,
              sourceFingerprint: "synthetic",
              canonicalVersion: "1",
              templateVersion: "1",
              detectorModel: "synthetic",
              writerSelection: {
                instanceId: C.ProviderInstanceId.make("synthetic"),
                model: "synthetic",
              },
              writerConfigurationGeneration: "1",
              identityConfidence: "configuration-only",
            },
            evidence: [
              {
                id: C.DecisionEvidenceId.make("derived-anchor"),
                threadId: C.ThreadId.make("another-thread"),
                messageId: C.MessageId.make("derived-message"),
                messageRole: "user",
                sourceGeneration: 0,
                sourceHash: "derived-hash",
                canonicalVersion: "1",
                quote: "Use SQLite",
                start: 0,
                end: 10,
                prefix: "",
                suffix: "",
                occurrence: 1,
                availability: "available",
              },
            ],
          },
          yield* f.task(),
          lineage.map((row) => row.source_evidence_id),
        );
        assert.isNotNull(derived);
        f.setCandidates([derived!]);
        const beforeForget = yield* f.service.prepare(
          yield* f.task("Use derived storage decision", "before-forget"),
          "{}",
        );
        assert.equal(beforeForget.state, "prepared");
        const callsBefore = f.calls().evaluateCalls;
        yield* f.service.forget({
          actionId: "forget-expired-occurrence",
          selection: { kind: "items", sourceId, occurrenceIds: ["a"] },
          expectedSourceGeneration: 0,
          expectedPurgeGeneration: 0,
        });
        const afterForget = yield* f.service.prepare(
          yield* f.task("Use derived storage decision", "after-forget"),
          "{}",
        );
        assert.equal(afterForget.state, "no-useful-context");
        assert.equal(f.calls().evaluateCalls, callsBefore);
        assert.deepEqual(
          yield* f.sql`SELECT * FROM thread_decisions WHERE id=${decisionId}`,
          saved,
        );
        const blocked =
          yield* f.sql`SELECT 1 FROM contextual_suppression WHERE entity_kind='decision' AND entity_id=${decisionId}`;
        assert.lengthOf(blocked, 1);
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual evaluation cache", (it) => {
  it.effect(
    "reuses an identical no-match without another paid attempt and invalidates on known-context change",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setUseful(0);
        const first = yield* f.service.prepare(yield* f.task("Review storage", "first"), "{}");
        assert.equal(first.state, "no-useful-context");
        assert.equal(f.calls().evaluateCalls, 1);
        const second = yield* f.service.prepare(yield* f.task("Review storage", "second"), "{}");
        assert.equal(second.attemptsUsed, 0);
        assert.equal(f.calls().evaluateCalls, 1);
        const changed = yield* f.service.taskSnapshot({
          threadId,
          submissionId: "changed",
          messageId: C.MessageId.make("changed"),
          providerInstanceId: "provider",
          newestMessage: "Review storage",
          recentContext: "The task now applies to production",
        });
        yield* f.service.prepare(changed, "{}");
        assert.equal(f.calls().evaluateCalls, 2);
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual collection lease", (it) => {
  it.effect(
    "renews requested collection without inference, pauses loss of paid eligibility, preserves intent and honors explicit pause",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.service.setCapture({ state: "running", expectedGeneration: 0 });
        yield* f.service.maintainCapture();
        assert.equal(f.captureRequests.length, 2);
        assert.equal(f.captureRequests[1]?.state, "running");
        assert.isNotNull(f.captureRequests[1]?.eligibilityValidUntil);
        assert.equal(f.calls().evaluateCalls, 0);
        f.setFunding(false);
        yield* f.service.maintainCapture();
        assert.equal(f.captureRequests.at(-1)?.state, "paused");
        const requested = yield* f.sql<{
          capture_requested: number;
        }>`SELECT capture_requested FROM contextual_host_state WHERE singleton=1`;
        assert.equal(requested[0]?.capture_requested, 1);
        f.setFunding(true);
        yield* f.service.maintainCapture();
        assert.equal(f.captureRequests.at(-1)?.state, "running");
        yield* f.service.setCapture({ state: "paused", expectedGeneration: 4 });
        const count = f.captureRequests.length;
        yield* f.service.maintainCapture();
        assert.equal(f.captureRequests.length, count);
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual crash recovery", (it) => {
  it.effect(
    "converts a pre-handoff marker into stable unknown supply without retrying inference",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const prepared = yield* f.service.prepare(yield* f.task("Build storage", "crash"), "{}");
        yield* f.repository.update(
          {
            ...prepared,
            state: "dispatching",
            dispatchId: "uncertain-dispatch",
            revision: prepared.revision + 1,
          },
          prepared.revision,
        );
        yield* f.service.recover();
        assert.equal((yield* f.repository.get(prepared.id)).state, "delivery-unknown");
        assert.isTrue(yield* f.repository.supplied(threadId, "a", "a", "initial"));
        const disclosures = yield* f.repository.disclosures(threadId);
        assert.equal(disclosures[0]?.receipt.id, "contextual:uncertain-dispatch");
        assert.equal(disclosures[0]?.receipt.acceptance, "unknown");
        const next = yield* f.service.prepare(
          yield* f.task("Keep building storage", "after-crash"),
          "{}",
        );
        assert.equal(next.state, "no-useful-context");
        assert.equal(f.calls().evaluateCalls, 1);
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual stale conflict choices", (it) => {
  for (const escape of ["skip-context", "cancel-turn"] as const) {
    it.effect(
      `rejects a choice when only the discarded occurrence changed and still permits ${escape}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          f.setCandidates([savedCandidate("a"), savedCandidate("b", 1, "Use Postgres")]);
          f.setConflict();
          const prepared = yield* f.service.prepare(yield* f.task(), "{}");
          assert.equal(prepared.state, "awaiting-conflict-review");
          const conflict = (yield* f.service.conflicts({ threadId, preparationId: prepared.id }))
            .items[0]!;
          const packet = yield* f.repository.packet(prepared.packetId!, threadId);
          assert.equal(packet?.groups[0]?.occurrenceId, conflict.pair.left.occurrenceId);
          f.invalidateOccurrence(conflict.pair.right.occurrenceId);
          const request: C.ContextualConflictResolution = {
            actionId: "stale-choice",
            conflictId: conflict.id,
            expectedRevision: conflict.revision,
            leftRevision: conflict.pair.left.revision,
            rightRevision: conflict.pair.right.revision,
            threadId,
            taskFingerprint: conflict.taskFingerprint,
            action: "use-left",
            clarification: null,
          };
          const result = yield* f.service.resolveConflict(request).pipe(Effect.result);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.equal(result.failure.code, "stale-revision");
          assert.equal((yield* f.repository.get(prepared.id)).state, "awaiting-conflict-review");
          assert.equal(
            (yield* f.service.conflicts({ threadId, preparationId: prepared.id })).items[0]?.state,
            "awaiting-review",
          );
          yield* f.service.resolveConflict({
            ...request,
            actionId: `recover-${escape}`,
            action: escape,
          });
          assert.equal(
            (yield* f.repository.get(prepared.id)).state,
            escape === "skip-context" ? "skipped" : "canceled",
          );
        }),
    );
  }
});

it.layer(SqlitePersistenceMemory)("Contextual incremental corrections", (it) => {
  it.effect(
    "keeps legacy quote-only supply suppressed when the saved summary was never delivered",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = savedCandidate("legacy-summary");
        f.setCandidates([original]);
        const p = yield* f.service.prepare(yield* f.task(), "{}");
        const packet = (yield* f.repository.packet(p.packetId!, threadId))!;
        const legacy = {
          ...packet,
          groups: packet.groups.map((group) => ({ ...group, derivedSummary: null })),
        };
        yield* f.sql`UPDATE contextual_packets SET packet_json=${encode(legacy)} WHERE id=${packet.id}`;
        yield* f.repository.update(
          {
            ...p,
            state: "dispatching",
            dispatchId: "legacy-summary-dispatch",
            revision: p.revision + 1,
          },
          p.revision,
        );
        yield* f.service.recover();
        const calls = f.calls();
        f.setCandidates([{ ...original, recordRevision: 2, contentFingerprint: "legacy-review" }]);
        assert.equal(
          (yield* f.service.prepare(
            yield* f.task("Implement database storage", "legacy-review"),
            "{}",
          )).state,
          "no-useful-context",
        );
        assert.deepEqual(f.calls(), calls);
      }),
  );
  it.effect(
    "supplies derived Decision text after quotes and checks changed commitments with unchanged anchors",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = savedCandidate("summary");
        f.setCandidates([original]);
        const first = yield* f.service.prepare(
          yield* f.task("Implement database storage", "summary-first"),
          "{}",
        );
        const firstPacket = (yield* f.repository.packet(first.packetId!, threadId))!;
        const rendered = contextualPacketText(firstPacket);
        assert.include(rendered, "Derived summary: Generated saved Decision: Use SQLite");
        assert.isBelow(rendered.indexOf("Synthetic ("), rendered.indexOf("Derived summary:"));
        yield* f.repository.update(
          {
            ...first,
            state: "dispatching",
            dispatchId: "summary-dispatch",
            revision: first.revision + 1,
          },
          first.revision,
        );
        yield* f.service.recover();
        const calls = f.calls();
        const cosmetic = {
          ...original,
          recordRevision: 2,
          contentFingerprint: "summary-cosmetic",
          derivedSummary: {
            ...original.derivedSummary,
            title: "Storage selection",
            body: "Use  SQLite",
            userEdited: true,
          },
        };
        f.setCandidates([cosmetic]);
        assert.equal(
          (yield* f.service.prepare(
            yield* f.task("Implement database storage", "summary-cosmetic"),
            "{}",
          )).state,
          "no-useful-context",
        );
        assert.deepEqual(f.calls(), calls);
        const revised = {
          ...cosmetic,
          recordRevision: 3,
          contentFingerprint: "summary-material",
          derivedSummary: {
            ...cosmetic.derivedSummary,
            body: "Use Postgres for shared storage; SQLite is only the local cache.",
          },
        };
        f.setCandidates([revised]);
        // The default compatible judgment must reject cosmetic/unsupported corrections.
        assert.equal(
          (yield* f.service.prepare(
            yield* f.task("Implement database storage", "summary-compatible"),
            "{}",
          )).state,
          "no-useful-context",
        );
        const comparison = f.comparisonRequests.find((p) => p.right.id.startsWith("previous:"))!;
        assert.include(comparison.left.derivedSummary!, revised.derivedSummary.body);
        assert.include(comparison.right.derivedSummary!, original.derivedSummary.body);
        assert.deepEqual(comparison.left.evidence, comparison.right.evidence);
        f.setConflict();
        // A different task state invalidates the cached compatible judgment.
        const next = yield* f.service.prepare(
          yield* f.task("Implement shared database storage now", "summary-correction"),
          "{}",
        );
        assert.equal(next.state, "prepared");
        const packet = (yield* f.repository.packet(next.packetId!, threadId))!;
        assert.equal(packet.purpose, "correction");
        assert.include(packet.groups[0]!.derivedSummary!, revised.derivedSummary.body);
        assert.deepEqual(packet.groups[0]!.evidence, original.evidence);
        yield* f.repository.update(
          {
            ...next,
            state: "dispatching",
            dispatchId: "summary-correction-dispatch",
            revision: next.revision + 1,
          },
          next.revision,
        );
        yield* f.service.recover();
        f.setCandidates([
          { ...revised, contentFingerprint: "summary-metadata", recordRevision: 4 },
        ]);
        const after = f.calls();
        assert.equal(
          (yield* f.service.prepare(
            yield* f.task("Implement database storage", "summary-after"),
            "{}",
          )).state,
          "no-useful-context",
        );
        assert.deepEqual(f.calls(), after);
      }),
  );
  it.effect(
    "restores once after compaction and suppresses metadata and group aliases while permitting corrections",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = { ...savedCandidate("a"), guidanceId: "decision:a" };
        f.setCandidates([original]);
        const supply = Effect.fn(function* (submission: string) {
          const p = yield* f.service.prepare(
            yield* f.task("Implement database storage", submission),
            "{}",
          );
          assert.equal(p.state, "prepared");
          yield* f.repository.update(
            { ...p, state: "dispatching", dispatchId: submission, revision: p.revision + 1 },
            p.revision,
          );
          yield* f.service.recover();
          return p;
        });
        yield* supply("before-compaction");
        yield* f.sql`UPDATE contextual_thread_settings SET context_epoch='compaction:verified' WHERE thread_id=${threadId}`;
        const restored = yield* supply("restore");
        assert.equal(
          (yield* f.repository.packet(restored.packetId!, threadId))?.purpose,
          "restored-after-compaction",
        );
        const calls = f.calls();
        f.setCandidates([
          { ...original, contentFingerprint: "review-confirmed", recordRevision: 2 },
        ]);
        const reviewed = yield* f.service.prepare(
          yield* f.task("Implement database storage", "reviewed"),
          "{}",
        );
        assert.equal(reviewed.state, "no-useful-context");
        assert.equal(reviewed.task.trigger, "confirmed-compaction");
        yield* f.sql`INSERT INTO contextual_group_members(group_id,decision_id,occurrence_revision,merge_id) VALUES('merged','a',1,'merge')`;
        f.setCandidates([
          {
            ...original,
            guidanceId: "group:merged",
            contentFingerprint: "merged",
            recordRevision: 3,
          },
        ]);
        const merged = yield* f.service.prepare(
          yield* f.task("Implement database storage", "merged"),
          "{}",
        );
        assert.equal(merged.state, "no-useful-context");
        assert.deepEqual(f.calls(), calls);
        f.setConflict();
        f.setCandidates([{ ...savedCandidate("a", 4, "Use Postgres"), guidanceId: "decision:a" }]);
        const correction = yield* supply("corrected");
        const packet = yield* f.repository.packet(correction.packetId!, threadId);
        assert.equal(packet?.purpose, "correction");
        assert.notInclude(encode(packet), "Use SQLite");
        assert.include(encode(packet), "Use Postgres");
        assert.equal(
          (yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM contextual_supply WHERE thread_id=${threadId}`)[0]
            ?.count,
          3,
        );
      }),
  );
  it.effect(
    "compares a fork correction with inherited evidence without exposing unrelated parent packets",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setCandidates([savedCandidate("a")]);
        const first = yield* f.service.prepare(
          yield* f.task("Implement database storage", "parent-message"),
          "{}",
        );
        yield* f.repository.update(
          {
            ...first,
            state: "dispatching",
            dispatchId: "parent-dispatch",
            revision: first.revision + 1,
          },
          first.revision,
        );
        yield* f.service.recover();
        const child = C.ThreadId.make("child-thread");
        yield* f.sql`INSERT OR REPLACE INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES(${child},${projectId},'Child','{}',${at},${at},'full-access','default')`;
        yield* f.settings.updateThread({
          threadId: child,
          enabled: true,
          sourceIds: [decisionSourceId],
          expectedRevision: 0,
        });
        assert.isNull(yield* f.repository.suppliedPacket(first.packetId!, child));
        const childMessage = C.MessageId.make("child-message");
        yield* applyContextualLifecycle(f.sql, {
          type: "thread.forked",
          sequence: 1,
          eventId: C.EventId.make("fork"),
          aggregateKind: "thread",
          aggregateId: child,
          occurredAt: at,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: child,
            forkedFrom: {
              threadId,
              turnId: C.TurnId.make("parent-turn"),
              turnCount: 1,
              messageId: null,
            },
            forkSource: null,
            contextualMessageIdMap: [{ sourceId: first.task.messageId, targetId: childMessage }],
            history: {
              messages: [
                {
                  id: childMessage,
                  role: "user",
                  text: "Implement database storage",
                  createdAt: at,
                  updatedAt: at,
                  turnId: null,
                  streaming: false,
                },
              ],
              activities: [],
              proposedPlans: [],
              turns: [],
            },
          },
        });
        assert.isNull(yield* f.repository.packet(first.packetId!, child));
        const childTask = (submission: string) =>
          f.service.taskSnapshot({
            threadId: child,
            submissionId: submission,
            messageId: C.MessageId.make(submission),
            providerInstanceId: "provider",
            newestMessage: "Implement database storage",
            recentContext: "",
          });
        const calls = f.calls();
        const unchanged = yield* f.service.prepare(yield* childTask("child-unchanged"), "{}");
        assert.equal(unchanged.state, "no-useful-context");
        assert.deepEqual(f.calls(), calls);
        f.setConflict();
        f.setCandidates([savedCandidate("a", 2, "Use Postgres")]);
        const revised = yield* f.service.prepare(yield* childTask("child-correction"), "{}");
        assert.equal(revised.state, "prepared");
        const packet = yield* f.repository.packet(revised.packetId!, child);
        assert.equal(packet?.purpose, "correction");
        assert.notInclude(encode(packet), "Use SQLite");
        assert.include(encode(packet), "Use Postgres");
      }),
  );
  it.effect(
    "delivers a material revision of previously supplied guidance as a correction on the same task",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setCandidates([savedCandidate("a")]);
        const first = yield* f.service.prepare(
          yield* f.task("Implement database storage", "first"),
          "{}",
        );
        assert.equal(first.state, "prepared");
        yield* f.repository.update(
          {
            ...first,
            state: "dispatching",
            dispatchId: "first-dispatch",
            revision: first.revision + 1,
          },
          first.revision,
        );
        yield* f.service.recover();
        f.setConflict();
        f.setCandidates([savedCandidate("a", 2, "Use Postgres")]);
        const next = yield* f.service.prepare(
          yield* f.task("Implement database storage", "correction"),
          "{}",
        );
        assert.equal(next.state, "prepared");
        const packet = yield* f.repository.packet(next.packetId!, threadId);
        assert.equal(packet?.purpose, "correction");
        assert.equal(packet?.groups[0]?.recordRevision, 2);
        const body = encode(packet);
        assert.notInclude(body, "Use SQLite");
        assert.include(body, "Use Postgres");
      }),
  );
  it.effect(
    "suppresses a cosmetic whitespace revision of supplied guidance without another evaluation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setCandidates([savedCandidate("a")]);
        const first = yield* f.service.prepare(
          yield* f.task("Implement database storage", "first"),
          "{}",
        );
        yield* f.repository.update(
          {
            ...first,
            state: "dispatching",
            dispatchId: "cosmetic-dispatch",
            revision: first.revision + 1,
          },
          first.revision,
        );
        yield* f.service.recover();
        const calls = f.calls();
        f.setCandidates([savedCandidate("a", 2, "Use  SQLite")]);
        const next = yield* f.service.prepare(
          yield* f.task("Implement database storage", "cosmetic"),
          "{}",
        );
        assert.equal(next.state, "no-useful-context");
        assert.deepEqual(f.calls(), calls);
      }),
  );
  it.effect(
    "reassesses useful deferred evidence and newly arrived evidence for the same task",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const a = savedCandidate("a");
        const b = savedCandidate("b", 1, "Enable backups");
        f.setCandidates([a, b]);
        const first = yield* f.service.prepare(
          yield* f.task("Implement database storage", "first"),
          "{}",
        );
        assert.equal(first.state, "prepared");
        assert.deepEqual(
          (yield* f.repository.packet(first.packetId!, threadId))?.groups.map(
            (g) => g.occurrenceId,
          ),
          ["a"],
        );
        yield* f.repository.update(
          {
            ...first,
            state: "dispatching",
            dispatchId: "pool-dispatch",
            revision: first.revision + 1,
          },
          first.revision,
        );
        yield* f.service.recover();
        const unchanged = yield* f.service.prepare(
          yield* f.task("Implement database storage", "unchanged"),
          "{}",
        );
        assert.equal(unchanged.state, "prepared");
        assert.deepEqual(
          (yield* f.repository.packet(unchanged.packetId!, threadId))?.groups.map(
            (g) => g.occurrenceId,
          ),
          ["b"],
        );
        yield* f.repository.update(
          {
            ...unchanged,
            state: "dispatching",
            dispatchId: "deferred-pool-dispatch",
            revision: unchanged.revision + 1,
          },
          unchanged.revision,
        );
        yield* f.service.recover();
        f.setCandidates([a, b, savedCandidate("c", 1, "Encrypt backups")]);
        const fresh = yield* f.service.prepare(
          yield* f.task("Implement database storage", "fresh"),
          "{}",
        );
        assert.equal(fresh.state, "prepared");
        const packet = yield* f.repository.packet(fresh.packetId!, threadId);
        assert.equal(packet?.purpose, "new-context");
        assert.deepEqual(
          packet?.groups.map((g) => g.occurrenceId),
          ["c"],
        );
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual visible preparation wait", (it) => {
  it.effect(
    "persists a requested preparation before waiting for funding and preserves an explicit skip",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setFundingWait(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        );
        const task = yield* f.task("Implement database storage", "waiting");
        const fiber = yield* f.service.prepare(task, "{}").pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const rows = yield* f.sql<{
          id: string;
        }>`SELECT id FROM contextual_preparations WHERE thread_id=${threadId} AND submission_id='waiting'`;
        assert.lengthOf(rows, 1);
        const pending = yield* f.repository.get(rows[0]!.id);
        assert.equal(pending.state, "requested");
        yield* f.service.preparationAction({
          actionId: "skip-wait",
          preparationId: pending.id,
          expectedRevision: pending.revision,
          action: "send-without-context",
        });
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(fiber)).state, "skipped");
        assert.equal(f.calls().evaluateCalls, 0);
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual native generation boundary", (it) => {
  for (const scenario of [
    {
      name: "admits sufficient partial-cache evidence",
      gap: false,
      truncated: false,
      score: 1,
      calls: 1,
      state: "prepared",
    },
    {
      name: "omits semantically insufficient partial-cache evidence",
      gap: false,
      truncated: false,
      score: 0.2,
      calls: 1,
      state: "no-useful-context",
    },
    {
      name: "rejects missing antecedents before evaluation",
      gap: true,
      truncated: false,
      score: 1,
      calls: 0,
      state: "no-useful-context",
    },
    {
      name: "rejects truncated exchanges before evaluation",
      gap: false,
      truncated: true,
      score: 1,
      calls: 0,
      state: "no-useful-context",
    },
  ]) {
    it.effect(scenario.name, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setCandidates([]);
        f.setNativeGenerations();
        f.setSufficientContext(scenario.score);
        const partial = {
          ...candidate(),
          coverage: {
            complete: false,
            missingAntecedents: scenario.gap,
            truncated: scenario.truncated,
            unexaminedCount: 0,
          },
        };
        f.setHelperCandidates([partial]);
        yield* f.sql`UPDATE contextual_host_state SET source_policy_json=${encode({ ...emptyPolicy, allowedSourceIds: [sourceId] })} WHERE singleton=1`;
        yield* f.settings.updateProject({
          projectId,
          expectedRevision: 1,
          defaultEnabled: true,
          sourceIds: [sourceId],
        });
        yield* f.settings.updateThread({
          threadId,
          expectedRevision: 1,
          enabled: true,
          sourceIds: [sourceId],
        });
        const preparation = yield* f.service.prepare(yield* f.task(), "{}");
        assert.equal(preparation.state, scenario.state);
        assert.isFalse(preparation.coverage.complete);
        assert.equal(f.calls().evaluateCalls, scenario.calls);
        if (preparation.packetId) {
          const packet = yield* f.repository.packet(preparation.packetId, threadId);
          assert.deepEqual(packet?.groups[0]?.evidence, partial.evidence);
        }
      }),
    );
  }
  it.effect(
    "uses helper generations for retrieval and inspection while retaining host task fences",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setCandidates([]);
        f.setNativeGenerations();
        const policy = encode({ ...emptyPolicy, revision: 3, allowedSourceIds: [sourceId] });
        yield* f.sql`UPDATE contextual_host_state SET source_policy_json=${policy},source_revision=5,purge_generation=2 WHERE singleton=1`;
        yield* f.settings.updateProject({
          projectId,
          expectedRevision: 1,
          defaultEnabled: true,
          sourceIds: [sourceId],
        });
        yield* f.settings.updateThread({
          threadId,
          expectedRevision: 1,
          enabled: true,
          sourceIds: [sourceId],
        });
        const task = yield* f.task("Find storage policy", "native-boundary");
        assert.equal(task.sourceScopeRevision, 5);
        assert.equal(task.purgeGeneration, 2);
        const prepared = yield* f.service.prepare(task, "{}");
        assert.equal(prepared.state, "no-useful-context");
        assert.isFalse(prepared.coverage.complete);
        assert.equal(prepared.task.sourceScopeRevision, 5);
        assert.equal(prepared.task.purgeGeneration, 2);
        assert.lengthOf(f.retrieveRequests, 1);
        assert.equal(f.retrieveRequests[0]?.task.sourceScopeRevision, 7);
        assert.equal(f.retrieveRequests[0]?.task.purgeGeneration, 11);
        assert.deepEqual(f.retrieveRequests[0]?.sourceIds, [sourceId]);
        assert.isFalse(f.retrieveRequests[0]?.includeHistorical);
        yield* f.service.inspect({ query: "storage policy", sourceIds: [sourceId], limit: 5 });
        assert.lengthOf(f.retrieveRequests, 2);
        assert.equal(f.retrieveRequests[1]?.task.sourceScopeRevision, 7);
        assert.equal(f.retrieveRequests[1]?.task.purgeGeneration, 11);
        assert.isTrue(f.retrieveRequests[1]?.includeHistorical);
        assert.deepEqual(f.calls(), { evaluateCalls: 0, conflictCalls: 0 });
      }),
  );
});

// Private executable integration is opt-in; public/community CI needs no private artifact.
// LECTURN_CONTEXTUAL_TEST_HELPER=/absolute/path/lecturn-extensions-helper vp test run <this file>
const nativeHelperBinary = process.env.LECTURN_CONTEXTUAL_TEST_HELPER;
it.layer(SqlitePersistenceMemory)("Contextual actual native helper admission", (it) => {
  const cases = [
    {
      name: "prepares a cited standalone constraint from a partial native cache",
      messages: [{ ts: "1700000000.000001", text: "Use SQLite." }],
      sufficient: 1,
      expectedQuotes: ["Use SQLite."],
      expectedEvaluations: true,
    },
    {
      name: "preserves a cached proposal and its approval in one coherent packet",
      messages: [
        { ts: "1700000000.000001", text: "Use SQLite?", reply_count: 1 },
        { ts: "1700000001.000001", text: "Yes, use SQLite.", thread_ts: "1700000000.000001" },
      ],
      sufficient: 1,
      expectedQuotes: ["Use SQLite?", "Yes, use SQLite."],
      expectedEvaluations: true,
    },
    {
      name: "never injects a cached approval whose parent is missing",
      messages: [
        { ts: "1700000001.000001", text: "Yes, use SQLite.", thread_ts: "1700000000.000001" },
      ],
      sufficient: 1,
      expectedQuotes: [],
      expectedEvaluations: false,
    },
    {
      name: "rejects a prepared native exchange when a later reply changes its meaning",
      messages: [{ ts: "1700000000.000001", text: "Use SQLite." }],
      sufficient: 1,
      expectedQuotes: ["Use SQLite."],
      expectedEvaluations: true,
      afterPrepareMessages: [
        { ts: "1700000000.000001", text: "Use SQLite." },
        {
          ts: "1700000001.000001",
          text: "Correction: use Postgres.",
          thread_ts: "1700000000.000001",
        },
      ],
    },
    {
      name: "withholds native evidence when the mocked evaluator finds context insufficient",
      messages: [{ ts: "1700000000.000001", text: "Use SQLite." }],
      sufficient: 0,
      expectedQuotes: [],
      expectedEvaluations: true,
    },
  ];
  for (const scenario of cases)
    it.effect.skipIf(!nativeHelperBinary)(scenario.name, () =>
      Effect.acquireUseRelease(
        Effect.promise(() =>
          nativeContextualFixture(nativeHelperBinary!, scenario.messages, {
            platform: HostProcessPlatform.defaultValue(),
            architecture: HostProcessArchitecture.defaultValue(),
          }),
        ),
        ({ runtime, replaceMessages }) =>
          Effect.gen(function* () {
            const f = yield* fixture(runtime);
            f.setCandidates([]);
            f.setSufficientContext(scenario.sufficient);
            const discovered = yield* f.service.sources({ limit: 50 });
            assert.lengthOf(discovered.sources, 1);
            const nativeSourceId = discovered.sources[0]!.id;
            yield* f.service.configureSources({
              expectedRevision: discovered.policy.revision,
              policy: {
                ...discovered.policy,
                allowedSourceIds: [nativeSourceId],
                revision: discovered.policy.revision + 1,
              },
            });
            yield* f.settings.updateProject({
              projectId,
              defaultEnabled: true,
              sourceIds: [nativeSourceId],
              expectedRevision: 1,
            });
            yield* f.settings.updateThread({
              threadId,
              enabled: true,
              sourceIds: [nativeSourceId],
              expectedRevision: 1,
            });
            const captured = yield* runtime.request("contextual.capture.setState", {
              state: "running",
              expectedGeneration: 0,
              fundingGeneration: 1,
              eligibilityValidUntil: "2099-01-01T00:00:00.000Z",
            });
            assert.equal(captured.capturedRecords, scenario.messages.length);
            const task = yield* f.task("Implement SQLite storage", "native-submission");
            const prepared = yield* f.service.prepare(task, "{}");
            assert.equal(f.calls().evaluateCalls > 0, scenario.expectedEvaluations);
            if (scenario.expectedQuotes.length === 0) {
              assert.equal(prepared.state, "no-useful-context");
              assert.isNull(prepared.packetId);
              return;
            }
            assert.equal(prepared.state, "prepared");
            assert.isNotNull(prepared.packetId);
            if ("afterPrepareMessages" in scenario) {
              yield* Effect.promise(() => replaceMessages(scenario.afterPrepareMessages!));
              const currentSources = yield* runtime.request("contextual.sources.list", {
                limit: 50,
              });
              yield* runtime.request("contextual.sources.configure", {
                expectedRevision: currentSources.policy.revision,
                policy: { ...currentSources.policy, revision: currentSources.policy.revision + 1 },
              });
              const restarted = yield* runtime.request("contextual.capture.setState", {
                state: "paused",
                expectedGeneration: captured.generation,
                fundingGeneration: 1,
                eligibilityValidUntil: "2099-01-01T00:00:00.000Z",
              });
              const updated = yield* runtime.request("contextual.capture.setState", {
                state: "running",
                expectedGeneration: restarted.generation,
                fundingGeneration: 1,
                eligibilityValidUntil: "2099-01-01T00:00:00.000Z",
              });
              assert.equal(updated.capturedRecords, 2);
              const result = yield* f.service.revalidate(prepared.id).pipe(Effect.exit);
              assert.equal(
                result._tag,
                "Failure",
                "new replies invalidate the original prepared exchange",
              );
              return;
            }
            const validated = yield* f.service.revalidate(prepared.id);
            assert.isNotNull(validated.packet);
            const packet = validated.packet!;
            assert.lengthOf(packet.groups, 1);
            const evidence = packet.groups[0]!.evidence;
            assert.deepEqual(
              evidence.map((e) => e.quote),
              scenario.expectedQuotes,
            );
            assert.isFalse(
              prepared.coverage.complete,
              "the cache remains partial despite a sufficient exchange",
            );
            for (const e of evidence) {
              assert.equal(e.sourceKind, "slack");
              assert.equal(e.sourceId, nativeSourceId);
              assert.equal(e.sourceHash.length, 64);
              assert.equal(e.end - e.start, e.quote.length);
              assert.equal(e.locator.sourceKind, "slack");
            }
          }),
        (owned) => Effect.promise(() => owned.close()),
      ),
    );
});

it.layer(SqlitePersistenceMemory)("Contextual remaining pool", (it) => {
  for (const acceptance of ["accepted", "unknown"] as const) {
    it.effect(
      `reassesses unsupplied evidence after known context changes with ${acceptance} supply`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          f.setCandidates([savedCandidate("a"), savedCandidate("b", 1, "Enable backups")]);
          const task = (submission: string, recentContext: string) =>
            f.service.taskSnapshot({
              threadId,
              submissionId: submission,
              messageId: C.MessageId.make(submission),
              providerInstanceId: "provider",
              newestMessage: "Implement database storage",
              recentContext,
            });
          const deliver = Effect.fn("test.deliverRemainingPool")(function* (
            p: C.ContextualPreparation,
          ) {
            const packet = yield* f.repository.packet(p.packetId!, threadId);
            yield* f.repository.update(
              { ...p, state: "dispatching", dispatchId: p.id, revision: p.revision + 1 },
              p.revision,
            );
            yield* f.repository.receipt({
              id: `receipt:${p.id}`,
              preparationId: p.id,
              packetId: p.packetId,
              dispatchId: p.id,
              threadId,
              submissionId: p.task.submissionId,
              turnId: acceptance === "accepted" ? C.TurnId.make(`turn:${p.id}`) : null,
              providerInstanceId: p.task.providerInstanceId,
              providerContextEpoch: p.task.providerContextEpoch,
              providerReceiptId: acceptance === "accepted" ? `provider:${p.id}` : null,
              disposition: "fresh",
              acceptance,
              evidenceIncluded: true,
              suppliedEvidenceIds:
                acceptance === "accepted"
                  ? packet!.groups.flatMap((g) => g.evidence.map((e) => e.id))
                  : [],
              receivedAt: at,
            });
          });
          const originalTask = yield* task("first", "Build the initial database");
          const first = yield* f.service.prepare(originalTask, "{}");
          assert.equal(first.state, "prepared");
          assert.deepEqual(
            (yield* f.repository.packet(first.packetId!, threadId))?.groups.map(
              (g) => g.occurrenceId,
            ),
            ["a"],
          );
          yield* deliver(first);
          const calls = f.calls().evaluateCalls;
          const thanks = yield* f.service.prepare(yield* f.task("thanks", "thanks"), "{}");
          assert.equal(thanks.state, "no-useful-context");
          assert.equal(f.calls().evaluateCalls, calls);

          // Changed context permits reconsideration, not automatic delivery of old material.
          f.setUseful(0);
          const irrelevantTask = yield* task(
            "irrelevant",
            "Only update the database status display",
          );
          assert.equal(irrelevantTask.taskFingerprint, originalTask.taskFingerprint);
          assert.notEqual(
            irrelevantTask.knownContextFingerprint,
            originalTask.knownContextFingerprint,
          );
          const irrelevant = yield* f.service.prepare(irrelevantTask, "{}");
          assert.equal(irrelevant.state, "no-useful-context");
          assert.equal(f.calls().evaluateCalls, calls + 1);
          const repeated = yield* f.service.prepare(
            yield* task("repeat", irrelevantTask.recentContext),
            "{}",
          );
          assert.equal(repeated.state, "no-useful-context");
          assert.equal(f.calls().evaluateCalls, calls + 1);

          f.setUseful(1);
          const relevant = yield* f.service.prepare(
            yield* task("relevant", "Prepare database recovery and backup handling"),
            "{}",
          );
          assert.equal(relevant.state, "prepared");
          assert.equal(f.calls().evaluateCalls, calls + 2);
          assert.deepEqual(
            (yield* f.repository.packet(relevant.packetId!, threadId))?.groups.map(
              (g) => g.occurrenceId,
            ),
            ["b"],
          );
          yield* deliver(relevant);
          const exhausted = yield* f.service.prepare(
            yield* task("exhausted", "Finish the database recovery work"),
            "{}",
          );
          assert.equal(exhausted.state, "no-useful-context");
          assert.equal(f.calls().evaluateCalls, calls + 2);
          const supply = yield* f.sql<{
            guidance_id: string;
          }>`SELECT guidance_id FROM contextual_supply WHERE thread_id=${threadId} ORDER BY guidance_id`;
          assert.deepEqual(
            supply.map((row) => row.guidance_id),
            ["a", "b"],
          );
        }),
    );
  }
});

it.layer(SqlitePersistenceMemory)("Contextual remote invalidation", (it) => {
  it.effect("delivers host and project changes to two connected consumers and replays them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const initial = yield* f.sql<{
          sequence: number;
        }>`SELECT MAX(sequence) AS sequence FROM contextual_outbox`;
        const cursor = initial[0]!.sequence;
        const all = yield* Queue.unbounded<C.ContextualEvent>();
        const filtered = yield* Queue.unbounded<C.ContextualEvent>();
        yield* f.service.subscribe({ afterSequence: cursor - 1 }).pipe(
          Stream.runForEach((event) => Queue.offer(all, event)),
          Effect.forkScoped,
        );
        yield* f.service.subscribe({ afterSequence: cursor - 1, threadId }).pipe(
          Stream.runForEach((event) => Queue.offer(filtered, event)),
          Effect.forkScoped,
        );
        // Receiving the existing event proves both subscriptions are installed before mutating.
        assert.equal((yield* Queue.take(all)).sequence, cursor);
        assert.equal((yield* Queue.take(filtered)).sequence, cursor);
        const received: C.ContextualEvent[] = [];
        const next = (kind: C.ContextualEvent["kind"]) =>
          Effect.gen(function* () {
            const a = yield* Queue.take(all);
            const b = yield* Queue.take(filtered);
            assert.deepEqual(a, b);
            assert.equal(a.kind, kind);
            assert.isNull(a.threadId);
            assert.isAbove(a.sequence, received.at(-1)?.sequence ?? cursor);
            received.push(a);
            return a;
          });
        yield* f.service.updateProjectSettings({
          projectId,
          defaultEnabled: false,
          sourceIds: [decisionSourceId],
          expectedRevision: 1,
        });
        assert.equal((yield* next("settings-changed")).projectId, projectId);
        assert.equal((yield* f.service.projectSettings({ projectId })).revision, 2);
        yield* f.service.setCapture({ state: "running", expectedGeneration: 0 });
        assert.isNull((yield* next("capture-changed")).projectId);
        assert.equal((yield* f.service.captureStatus()).generation, 1);
        f.setFunding(false);
        yield* f.service.maintainCapture();
        yield* next("funding-changed");
        yield* next("capture-changed");
        assert.equal((yield* f.service.captureStatus()).state, "paused");
        // Identical reads must not invalidate themselves in a query/subscription feedback loop.
        yield* f.service.fundingStatus({ featureId: "contextual" });
        yield* f.service.fundingStatus({ featureId: "contextual" });
        yield* f.service.configureSources({
          policy: { ...emptyPolicy, revision: 1, allowedSourceIds: [sourceId] },
          expectedRevision: 0,
        });
        yield* next("source-policy-changed");
        yield* next("source-policy-changed");
        const replay = yield* f.service
          .subscribe({ afterSequence: cursor, threadId })
          .pipe(Stream.take(received.length), Stream.runCollect);
        assert.deepEqual([...replay], received);
        const durable =
          yield* f.sql`SELECT sequence FROM contextual_outbox WHERE sequence>${cursor}`;
        assert.lengthOf(durable, received.length);
      }),
    ),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual exhausted allowance", (it) => {
  it.effect("reports exhausted evaluation while preserving collection and thread intent", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const selection = encode({ instanceId: "supported-account", model: "selected-model" });
      yield* f.sql`UPDATE projection_threads SET model_selection_json=${selection} WHERE thread_id=${threadId}`;
      const allowance: NonNullable<C.ExtensionFundingStatusResult["allowance"]> = {
        poolId: "shared-pool",
        basis: "grant",
        windowStart: at,
        windowEnd: "2026-10-25T00:00:00.000Z",
        limitInputTokens: 100,
        usedInputTokens: 100,
        reservedInputTokens: 0,
        remainingInputTokens: 0,
        byFeature: [{ featureId: "decisions", usedInputTokens: 100, reservedInputTokens: 0 }],
      };
      f.setAllowance(allowance);
      const exhausted = yield* f.service.status({ threadId });
      assert.isTrue(exhausted.thread.enabled);
      assert.isTrue(exhausted.effective.enabled);
      assert.isFalse(exhausted.effective.effective);
      assert.equal(exhausted.effective.reason, "allowance-exhausted");
      // Collection depends on paid membership rather than the inference balance.
      yield* f.service.setCapture({ state: "running", expectedGeneration: 0 });
      yield* f.service.maintainCapture();
      assert.equal((yield* f.service.captureStatus()).state, "running");
      assert.equal(f.captureRequests.length, 2);
      f.setAllowance({ ...allowance, usedInputTokens: 99, remainingInputTokens: 1 });
      const replenished = yield* f.service.status({ threadId });
      assert.isTrue(replenished.effective.effective);
      assert.equal(replenished.effective.reason, "ready");
      assert.deepEqual(f.calls(), { evaluateCalls: 0, conflictCalls: 0 });
    }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual prior guidance comparisons and restoration", (it) => {
  for (const mode of ["conflict", "excluded", "source-removed", "stale"] as const)
    it.effect(`checks prior Decision against independent Slack with ${mode} source state`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const prior = savedCandidate("prior");
        f.setCandidates([prior]);
        const first = yield* f.service.prepare(
          yield* f.task("Implement database storage", "prior-first"),
          "{}",
        );
        yield* f.repository.update(
          {
            ...first,
            state: "dispatching",
            dispatchId: "prior-dispatch",
            revision: first.revision + 1,
          },
          first.revision,
        );
        yield* f.service.recover();
        yield* f.sql`UPDATE contextual_host_state SET source_policy_json=${encode({ ...emptyPolicy, allowedSourceIds: [sourceId] })} WHERE singleton=1`;
        const sources = mode === "source-removed" ? [sourceId] : [decisionSourceId, sourceId];
        yield* f.settings.updateProject({
          projectId,
          expectedRevision: 1,
          defaultEnabled: true,
          sourceIds: sources,
        });
        yield* f.settings.updateThread({
          threadId,
          expectedRevision: 1,
          enabled: true,
          sourceIds: sources,
        });
        const slack = candidate("new-slack");
        f.setHelperCandidates([
          {
            ...slack,
            evidence: slack.evidence.map((e) => ({ ...e, quote: "Use Postgres", end: 12 })),
          },
        ]);
        if (mode === "excluded")
          yield* f.service.exclude({
            actionId: "exclude-prior",
            threadId,
            guidanceId: prior.guidanceId,
            excluded: true,
            expectedRevision: 0,
          });
        if (mode === "stale") f.invalidateOccurrence(prior.occurrenceId);
        f.setConflict();
        const count = f.comparisonRequests.length;
        const next = yield* f.service.prepare(
          yield* f.task("Implement database storage", "independent"),
          "{}",
        );
        assert.equal(
          next.state,
          mode === "conflict"
            ? "awaiting-conflict-review"
            : mode === "stale"
              ? "skipped"
              : "prepared",
        );
        const comparisons = f.comparisonRequests.slice(count);
        if (mode === "conflict") {
          assert.isTrue(
            comparisons.some(
              (pair) => pair.left.candidateId === slack.id && pair.right.candidateId === prior.id,
            ),
          );
          const conflict = (yield* f.service.conflicts({ threadId })).items.find(
            (c) => c.pair.right.candidateId === prior.id,
          )!;
          assert.equal(conflict.state, "awaiting-review");
          const packet = (yield* f.repository.packet(next.packetId!, threadId))!;
          assert.deepEqual(
            packet.groups.map((group) => group.guidanceId),
            [slack.guidanceId],
          );
          assert.isFalse(
            packet.groups.some((group) =>
              group.evidence.some((e) => e.sourceKind === "lecturn-decision"),
            ),
          );
        } else assert.isFalse(comparisons.some((pair) => pair.right.candidateId === prior.id));
      }),
    );

  it.effect(
    "restores each item once per confirmed epoch after acknowledgments and no-match turns",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const originals = [savedCandidate("restore-a"), savedCandidate("restore-b")];
        const supply = Effect.fn(function* (submission: string) {
          const p = yield* f.service.prepare(
            yield* f.task("Implement database storage", submission),
            "{}",
          );
          assert.equal(p.state, "prepared");
          yield* f.repository.update(
            { ...p, state: "dispatching", dispatchId: submission, revision: p.revision + 1 },
            p.revision,
          );
          yield* f.service.recover();
          return (yield* f.repository.packet(p.packetId!, threadId))!;
        });
        f.setCandidates([originals[0]!]);
        yield* supply("original-a");
        f.setCandidates(originals);
        yield* supply("original-b");
        yield* f.sql`UPDATE contextual_thread_settings SET context_epoch='compaction:multiple' WHERE thread_id=${threadId}`;
        const calls = f.calls();
        assert.equal(
          (yield* f.service.prepare(yield* f.task("thanks", "compaction-thanks"), "{}")).state,
          "no-useful-context",
        );
        assert.deepEqual(f.calls(), calls);
        f.setUseful(0);
        assert.equal(
          (yield* f.service.prepare(
            yield* f.task("Inspect unrelated documentation", "compaction-unrelated"),
            "{}",
          )).state,
          "no-useful-context",
        );
        f.setUseful(1);
        const restoredA = yield* supply("restored-a");
        const restoredB = yield* supply("restored-b");
        assert.equal(restoredA.purpose, "restored-after-compaction");
        assert.equal(restoredB.purpose, "restored-after-compaction");
        assert.notEqual(restoredA.groups[0]!.guidanceId, restoredB.groups[0]!.guidanceId);
        const after = f.calls();
        assert.equal(
          (yield* f.service.prepare(
            yield* f.task("Implement database storage", "restored-finished"),
            "{}",
          )).state,
          "no-useful-context",
        );
        assert.deepEqual(f.calls(), after);
        assert.equal(
          (yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM contextual_supply WHERE thread_id=${threadId} AND context_epoch='compaction:multiple'`)[0]
            ?.count,
          2,
        );
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual unavailable funding", (it) => {
  it.effect(
    "records an outage without claiming membership is unpaid or no evidence was useful",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const task = yield* f.task();
        f.setFundingUnavailable();
        const selection = encode({ instanceId: "supported-account", model: "selected-model" });
        yield* f.sql`UPDATE projection_threads SET model_selection_json=${selection} WHERE thread_id=${threadId}`;
        assert.equal((yield* f.service.status({ threadId })).effective.reason, "unavailable");
        const prepared = yield* f.service.prepare(task, "{}");
        assert.equal(prepared.state, "skipped");
        assert.equal(prepared.skipReason, "unavailable");
        assert.equal((yield* f.repository.get(prepared.id)).skipReason, "unavailable");
        assert.deepEqual(f.calls(), { evaluateCalls: 0, conflictCalls: 0 });
      }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual historical outcomes", (it) => {
  it.effect("returns one recorded preparation for the requested message after later turns", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setFunding(false);
      const unavailable = yield* f.service.prepare(yield* f.task("Build storage", "earlier"), "{}");
      f.setFunding(true);
      yield* f.service.prepare(yield* f.task("thanks", "later"), "{}");
      const earlier = yield* f.service.disclosures({
        threadId,
        messageId: C.MessageId.make("earlier"),
        limit: 1,
      });
      assert.equal(earlier.preparation?.id, unavailable.id);
      assert.equal(earlier.preparation?.skipReason, "funding-required");
      assert.lengthOf(earlier.items, 0);
      const later = yield* f.service.disclosures({
        threadId,
        messageId: C.MessageId.make("later"),
        limit: 1,
      });
      assert.equal(later.preparation?.state, "no-useful-context");
      assert.isNull((yield* f.service.disclosures({ threadId })).preparation);
      assert.isNull(
        (yield* f.service.disclosures({ threadId, messageId: C.MessageId.make("missing") }))
          .preparation,
      );
    }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual overlapping window resolution", (it) => {
  it.effect("keeps both guidance identities while rendering shared exact evidence once", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const shared = savedCandidate("shared", 1, "The scope is this host.").evidence[0]!;
      const left = savedCandidate("left", 1, "Use SQLite.");
      const right = savedCandidate("right", 1, "Use Postgres.");
      f.setCandidates([
        { ...left, evidence: [shared, ...left.evidence] },
        { ...right, evidence: [shared, ...right.evidence] },
      ]);
      f.setConflict();
      const prepared = yield* f.service.prepare(yield* f.task(), "{}");
      assert.equal(prepared.state, "awaiting-conflict-review");
      const conflict = (yield* f.service.conflicts({ threadId, preparationId: prepared.id }))
        .items[0]!;
      yield* f.service.resolveConflict({
        actionId: "keep-overlapping",
        threadId,
        taskFingerprint: prepared.task.taskFingerprint,
        conflictId: conflict.id,
        expectedRevision: conflict.revision,
        leftRevision: conflict.pair.left.revision,
        rightRevision: conflict.pair.right.revision,
        action: "different-scopes",
        clarification: "SQLite for local, Postgres for shared data.",
      });
      const packet = (yield* f.repository.packet(prepared.packetId!, threadId))!;
      assert.deepEqual(
        packet.groups.map((g) => g.guidanceId),
        [left.guidanceId, right.guidanceId],
      );
      assert.equal(packet.groups[0]!.evidence[0]!.id, packet.groups[1]!.evidence[0]!.id);
      assert.equal(contextualPacketText(packet).split(shared.quote).length - 1, 1);
      const ready = yield* f.repository.get(prepared.id);
      assert.equal(ready.state, "prepared");
      yield* f.repository.update(
        { ...ready, state: "dispatching", dispatchId: ready.id, revision: ready.revision + 1 },
        ready.revision,
      );
      yield* f.repository.receipt({
        id: `receipt:${ready.id}`,
        preparationId: ready.id,
        packetId: packet.id,
        dispatchId: ready.id,
        threadId,
        submissionId: ready.task.submissionId,
        turnId: C.TurnId.make("turn"),
        providerInstanceId: ready.task.providerInstanceId,
        providerContextEpoch: ready.task.providerContextEpoch,
        providerReceiptId: "native",
        disposition: "fresh",
        acceptance: "accepted",
        evidenceIncluded: true,
        suppliedEvidenceIds: [
          ...new Set(packet.groups.flatMap((g) => g.evidence.map((e) => e.id))),
        ],
        receivedAt: at,
      });
      const supply = yield* f.sql<{
        guidance_id: string;
      }>`SELECT guidance_id FROM contextual_supply WHERE thread_id=${threadId} ORDER BY guidance_id`;
      assert.deepEqual(
        supply.map((s) => s.guidance_id),
        [left.guidanceId, right.guidanceId].sort(),
      );
    }),
  );
  it.effect("does not exhaust unseen Slack windows sharing an exchange fingerprint", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = { ...candidate("window-a"), contentFingerprint: "whole-exchange" };
      const second = { ...candidate("window-b"), contentFingerprint: "whole-exchange" };
      f.setCandidates([first, second]);
      const initial = yield* f.service.prepare(
        yield* f.task("Implement storage", "first-window"),
        "{}",
      );
      assert.equal(initial.state, "prepared");
      yield* f.repository.update(
        {
          ...initial,
          state: "dispatching",
          dispatchId: initial.id,
          revision: initial.revision + 1,
        },
        initial.revision,
      );
      yield* f.repository.receipt({
        id: `receipt:${initial.id}`,
        preparationId: initial.id,
        packetId: initial.packetId,
        dispatchId: initial.id,
        threadId,
        submissionId: initial.task.submissionId,
        turnId: C.TurnId.make("first-turn"),
        providerInstanceId: initial.task.providerInstanceId,
        providerContextEpoch: initial.task.providerContextEpoch,
        providerReceiptId: "native-first",
        disposition: "fresh",
        acceptance: "accepted",
        evidenceIncluded: true,
        suppliedEvidenceIds: first.evidence.map((e) => e.id),
        receivedAt: at,
      });
      const next = yield* f.service.prepare(
        yield* f.task("Implement storage", "next-window"),
        "{}",
      );
      assert.equal(next.state, "prepared");
      const packet = (yield* f.repository.packet(next.packetId!, threadId))!;
      assert.equal(packet.groups[0]!.guidanceId, second.guidanceId);
      assert.deepEqual(
        packet.groups[0]!.evidence.map((e) => e.id),
        second.evidence.map((e) => e.id),
      );
    }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual private source selections", (it) => {
  it.effect(
    "supplies another original fragment on a later task without resupplying the old selection",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const source = candidate();
        const quote = "Use SQLite. Disable network access.";
        f.setCandidates([
          { ...source, evidence: [{ ...source.evidence[0]!, quote, end: quote.length }] },
        ]);
        f.setSelection([{ evidenceId: "e-a", start: 0, end: 11 }]);
        const first = yield* f.service.prepare(
          yield* f.task("Implement storage", "fragment1"),
          "{}",
        );
        assert.equal(first.state, "prepared");
        const firstPacket = yield* f.repository.packet(first.packetId!, threadId);
        assert.equal(firstPacket?.groups[0]?.evidence[0]?.quote, "Use SQLite.");
        yield* f.repository.update(
          {
            ...first,
            state: "dispatching",
            dispatchId: "fragment-dispatch",
            revision: first.revision + 1,
          },
          first.revision,
        );
        yield* f.service.recover();
        const calls = f.calls().evaluateCalls;
        const repeat = yield* f.service.prepare(
          yield* f.task("Implement storage", "fragment-repeat"),
          "{}",
        );
        assert.equal(repeat.state, "no-useful-context");
        assert.equal(f.calls().evaluateCalls, calls);
        f.setSelection([{ evidenceId: "e-a", start: 12, end: quote.length }]);
        const second = yield* f.service.prepare(
          yield* f.task("Implement network isolation", "fragment2"),
          "{}",
        );
        assert.equal(second.state, "prepared");
        const secondPacket = yield* f.repository.packet(second.packetId!, threadId);
        assert.equal(secondPacket?.groups[0]?.evidence[0]?.quote, "Disable network access.");
        assert.equal(secondPacket?.groups[0]?.guidanceId, firstPacket?.groups[0]?.guidanceId);
      }),
  );
  it.effect(
    "reports incomplete private evaluation without claiming the candidate was irrelevant",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setSelection([], false);
        const prepared = yield* f.service.prepare(yield* f.task(), "{}");
        assert.equal(prepared.state, "skipped");
        assert.equal(prepared.skipReason, "evaluation-incomplete");
        assert.equal(prepared.coverage.complete, false);
        assert.equal(prepared.coverage.unexaminedCount, 1);
      }),
  );
});
it("validates exact UTF-16 selections and range union coverage", () => {
  const source = candidate(),
    quote = "A🦫BCDEF";
  const input = {
    ...source,
    evidence: [{ ...source.evidence[0]!, quote, start: 4, end: 4 + quote.length }],
  };
  const judgment: C.ContextualJudgment = {
    targetId: source.id,
    useful: 1,
    usableEvidence: 1,
    contradicts: 0,
    sufficientContext: 1,
    reasons: [],
    selectedEvidenceIds: ["e-a"],
    selectedEvidenceSpans: [{ evidenceId: "e-a", start: 5, end: 7 }],
  };
  assert.equal(applyContextualSelection(input, judgment)?.evidence[0]?.quote, "🦫");
  assert.isNull(
    applyContextualSelection(input, {
      ...judgment,
      selectedEvidenceSpans: [{ evidenceId: "e-a", start: 6, end: 7 }],
    }),
  );
  assert.isNull(
    applyContextualSelection(input, {
      ...judgment,
      selectedEvidenceSpans: [{ evidenceId: "e-a", start: 5, end: 99 }],
    }),
  );
  const part = (start: number, end: number) => ({
    ...input.evidence[0]!,
    start,
    end,
    quote: quote.slice(start - 4, end - 4),
  });
  assert.isTrue(contextualEvidenceCovered(input.evidence, [part(4, 7), part(7, 12)]));
  assert.isFalse(contextualEvidenceCovered(input.evidence, [part(4, 7), part(8, 12)]));
  assert.isFalse(
    contextualEvidenceCovered(input.evidence, [{ ...input.evidence[0]!, sourceHash: "changed" }]),
  );
});
