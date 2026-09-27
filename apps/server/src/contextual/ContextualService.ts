import * as NodeCrypto from "node:crypto";
import * as C from "@lecturn/contracts";
import { Context, DateTime, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { getContextualProviderCapabilities } from "../provider/ContextualCapabilities.ts";
import { ExtensionsRuntime } from "../extensions/ExtensionsRuntime.ts";
import { ExtensionsCloudClient } from "../extensions/ExtensionsCloudClient.ts";
import {
  DecisionCandidates,
  completeCoverage,
  deduplicateCandidates,
  fingerprint,
} from "./DecisionCandidates.ts";
import {
  ContextualSettings,
  contextualBoundary,
  contextualNow,
  requireContextualThread,
  staleContextual,
  appendContextualEvent,
} from "./ContextualSettings.ts";
import {
  ContextualRepository,
  assertContextualFence,
  recordContextualPacketLineage,
} from "./ContextualRepository.ts";
import { ContextualPurge } from "./ContextualPurge.ts";
import { applyContextualSelection, contextualEvidenceCovered } from "./ContextualSelection.ts";
import { ContextualGroups } from "./ContextualGroups.ts";
import { ContextualNotifications } from "./ContextualNotifications.ts";
import {
  contextualDecisionMeaning,
  contextualDecisionSummary,
  normalizeContextualPacketGroups,
  contextualPacketByteBound,
} from "./ContextualPacketText.ts";

export interface TaskSnapshotInput {
  readonly threadId: C.ThreadId;
  readonly submissionId: string;
  readonly messageId: C.MessageId;
  readonly providerInstanceId: string;
  readonly newestMessage: string;
  readonly recentContext: string;
  readonly explicitReferences?: readonly string[];
  readonly turnId?: C.TurnId | null;
  readonly trigger?: C.ContextualTaskSnapshot["trigger"];
}
const isContextualError = Schema.is(C.ContextualError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePacket = Schema.encodeSync(Schema.fromJsonString(C.ContextualPacket));
const encodePolicy = Schema.encodeSync(Schema.fromJsonString(C.ContextualSourcePolicy));
const encodeConflict = Schema.encodeSync(Schema.fromJsonString(C.ContextualConflict));
const encodeResolution = Schema.encodeSync(Schema.fromJsonString(C.ContextualConflictResolution));
const decodePreparation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(C.ContextualPreparation),
);
const decodeConflictResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(C.ContextualConflictCheckResult),
);
const normalizeQuote = (quote: string) => quote.normalize("NFC").replace(/\s+/gu, " ").trim();
const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(C.ContextualSourcePolicy));
const decodeCandidate = Schema.decodeUnknownEffect(Schema.fromJsonString(C.ContextualCandidate));
const encodeCandidate = Schema.encodeSync(Schema.fromJsonString(C.ContextualCandidate));
const decodeConflict = Schema.decodeUnknownEffect(Schema.fromJsonString(C.ContextualConflict));
const encodeEvaluation = Schema.encodeSync(Schema.fromJsonString(C.ContextualEvaluationResult));
const decodeEvaluation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(C.ContextualEvaluationResult),
);
const decodeTask = Schema.decodeUnknownEffect(C.ContextualTaskSnapshot);
const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(C.ModelSelection));
const decodeConflictValue = Schema.decodeUnknownEffect(C.ContextualConflict);
export const collectionEligible = (status: C.ExtensionFundingStatusResult): boolean =>
  status.state === "active" && status.reason === "eligible";
const transient = new Set<C.ContextualPreparationState>([
  "requested",
  "retrieving",
  "evaluating",
  "checking-conflicts",
]);
export const routineFollowup = (text: string): boolean =>
  /^(?:thanks(?: you)?|thank you|ok(?:ay)?|great|got it|sounds good|continue|go on|yes|yep|sure|nice)[.!\s]*$/iu.test(
    text.trim(),
  );
export const explicitCurrentDirection = (text: string): boolean =>
  /^(?:please\s+)?(?:switch\b.+\bto\b|change\b.+\bto\b|replace\b.+\bwith\b|use\b.+\b(?:instead|rather than)\b)/imu.test(
    text,
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const providers = yield* ProviderService;
  const settings = yield* ContextualSettings;
  const repository = yield* ContextualRepository;
  const helper = yield* ExtensionsRuntime;
  const cloud = yield* ExtensionsCloudClient;
  const decisions = yield* DecisionCandidates;
  const purge = yield* ContextualPurge;
  const groups = yield* ContextualGroups;
  const captureMutex = yield* Semaphore.make(1);
  const notifications = yield* Effect.serviceOption(ContextualNotifications);
  const publish = Option.isSome(notifications) ? notifications.value.publish : Effect.void;
  const host = Effect.gen(function* () {
    yield* purge.ensureHost;
    const rows = yield* sql<{
      source_policy_json: string;
      source_revision: number;
      purge_generation: number;
      funding_generation: number;
    }>`SELECT * FROM contextual_host_state WHERE singleton=1`;
    return rows[0]!;
  });
  const fundingStatus = Effect.fn("Contextual.fundingStatus")(function* (input: {
    featureId: C.ExtensionFeatureId;
  }) {
    const value = yield* cloud.status(input.featureId);
    if (input.featureId === "contextual") {
      const changed = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* purge.ensureHost;
          const next = fingerprint([encodeJson(value)]);
          const rows = yield* sql<{
            funding_status_fingerprint: string | null;
          }>`SELECT funding_status_fingerprint FROM contextual_host_state WHERE singleton=1`;
          if (rows[0]?.funding_status_fingerprint === next) return false;
          yield* sql`UPDATE contextual_host_state SET funding_generation=${value.generation},funding_status_fingerprint=${next},updated_at=${yield* contextualNow} WHERE singleton=1`;
          yield* appendContextualEvent(sql, {
            revision: value.generation,
            kind: "funding-changed",
            entityId: "contextual",
          });
          return true;
        }),
      );
      if (changed) yield* publish;
    }
    return value;
  }, Effect.mapError(contextualBoundary));
  const funding = Effect.fn("Contextual.funding")(function* (input: C.ExtensionHostFundingRequest) {
    const result = yield* cloud.funding(input);
    if (input.featureId === "contextual") {
      yield* fundingStatus({ featureId: "contextual" });
      if (input.operation === "revoke") {
        const capture = yield* helper.request("contextual.capture.status", {}).pipe(Effect.option);
        if (Option.isSome(capture))
          yield* helper
            .request("contextual.capture.setState", {
              state: "paused",
              expectedGeneration: capture.value.generation,
              fundingGeneration: (yield* host).funding_generation,
              eligibilityValidUntil: null,
            })
            .pipe(Effect.ignore);
      }
    }
    if (input.featureId === "contextual") {
      yield* appendContextualEvent(sql, {
        revision: (yield* host).funding_generation,
        kind: "funding-changed",
        entityId: "contextual",
      });
      yield* publish;
    }
    return result;
  }, Effect.mapError(contextualBoundary));
  const latest = Effect.fn("Contextual.latest")(function* (threadId: C.ThreadId) {
    const rows = yield* sql<{
      preparation_json: string;
    }>`SELECT preparation_json FROM contextual_preparations WHERE thread_id=${threadId} ORDER BY created_at DESC,id DESC LIMIT 1`;
    return rows[0] ? yield* decodePreparation(rows[0].preparation_json) : null;
  });
  const status = Effect.fn("Contextual.status")(function* (input: { threadId: C.ThreadId }) {
    const projectId = yield* requireContextualThread(sql, input.threadId);
    const thread = yield* settings.thread(input.threadId);
    const project = yield* settings.project(projectId);
    const selections = yield* sql<{
      model_selection_json: string;
    }>`SELECT model_selection_json FROM projection_threads WHERE thread_id=${input.threadId}`;
    const selection = yield* decodeSelection(selections[0]?.model_selection_json ?? "{}").pipe(
      Effect.option,
    );
    // Contextual prepares for the selected next-turn instance, which can differ
    // from the existing session after a model/provider change.
    const instance = Option.isSome(selection)
      ? yield* providers.getInstanceInfo(selection.value.instanceId).pipe(Effect.option)
      : Option.none();
    const providerSupported =
      Option.isSome(instance) &&
      instance.value.enabled &&
      getContextualProviderCapabilities(instance.value.driverKind).delivery !== "unsupported";
    const funding = yield* fundingStatus({ featureId: "contextual" });
    const capture = yield* helper.request("contextual.capture.status", {}).pipe(Effect.option);
    const decisionsAvailable =
      thread.sourceIds.includes(`decisions:${projectId}`) &&
      project.sourceIds.includes(`decisions:${projectId}`);
    const policy = yield* decodePolicy((yield* host).source_policy_json);
    const slackAvailable =
      Option.isSome(capture) &&
      thread.sourceIds.some(
        (id) => project.sourceIds.includes(id) && policy.allowedSourceIds.includes(id),
      );
    const permittedSources: { id: string; label: string; hostName: string }[] = [];
    if (project.sourceIds.includes(`decisions:${projectId}`))
      permittedSources.push({
        id: `decisions:${projectId}`,
        label: "Lecturn Decisions",
        hostName: helper.hostName,
      });
    const permitted = new Set(
      project.sourceIds.filter((id) => policy.allowedSourceIds.includes(id)),
    );
    let cursor: string | undefined;
    for (let page = 0; permitted.size && page < 6; page++) {
      const result = yield* helper
        .request("contextual.sources.list", { limit: 50, ...(cursor ? { cursor } : {}) })
        .pipe(Effect.option);
      if (Option.isNone(result)) break;
      for (const source of result.value.sources)
        if (permitted.delete(source.id))
          permittedSources.push({ id: source.id, label: source.label, hostName: source.hostName });
      if (!result.value.nextCursor) break;
      cursor = result.value.nextCursor;
    }
    const allowanceExhausted = funding.allowance?.remainingInputTokens === 0;
    const effective =
      thread.enabled &&
      providerSupported &&
      funding.eligible &&
      !allowanceExhausted &&
      (decisionsAvailable || slackAvailable);
    const reason = effective
      ? "ready"
      : !thread.enabled
        ? "off"
        : Option.isNone(selection) || Option.isNone(instance) || !instance.value.enabled
          ? "unavailable"
          : !providerSupported
            ? "unsupported-provider"
            : !funding.eligible
              ? funding.state === "unavailable" ||
                ["unavailable", "stale-billing", "disabled", "cohort"].includes(funding.reason)
                ? "unavailable"
                : "funding-required"
              : allowanceExhausted
                ? "allowance-exhausted"
                : !decisionsAvailable && Option.isNone(capture)
                  ? "helper-unavailable"
                  : "source-unavailable";
    return {
      thread,
      project,
      permittedSources,
      effective: {
        enabled: thread.enabled,
        effective,
        reason,
        slackAvailable,
        decisionsAvailable,
        collectionState: Option.isSome(capture) ? capture.value.state : "unavailable",
      },
      hostName: helper.hostName,
      preparation: yield* latest(input.threadId),
    } satisfies C.ContextualStatusResult;
  }, Effect.mapError(contextualBoundary));
  const taskSnapshot = Effect.fn("Contextual.taskSnapshot")(function* (input: TaskSnapshotInput) {
    const projectId = yield* requireContextualThread(sql, input.threadId);
    const thread = yield* settings.thread(input.threadId);
    const project = yield* settings.project(projectId);
    if (!thread.enabled)
      return yield* new C.ContextualError({
        code: "forbidden",
        message: "Contextual is not enabled for this thread.",
      });
    const state = yield* host;
    const contexts = yield* sql<{
      context_epoch: string;
      refresh_epoch: number;
    }>`SELECT context_epoch,refresh_epoch FROM contextual_thread_settings WHERE thread_id=${input.threadId}`;
    const descriptions = yield* sql<{
      description: string;
    }>`SELECT description FROM decision_project_settings WHERE project_id=${projectId}`;
    const description = descriptions[0]?.description ?? "";
    const priorEpoch =
      yield* sql`SELECT 1 FROM contextual_preparations WHERE thread_id=${input.threadId} AND json_extract(preparation_json,'$.task.providerContextEpoch')=${contexts[0]?.context_epoch ?? "initial"} LIMIT 1`;
    const trigger =
      input.trigger ??
      (contexts[0]?.context_epoch.startsWith("refresh:") && !priorEpoch.length
        ? "refresh"
        : contexts[0]?.context_epoch.startsWith("compaction:")
          ? "confirmed-compaction"
          : "submission");
    // Never silently cut task constraints. Oversized tasks fail open without optional context.
    return yield* decodeTask({
      environmentId: helper.environmentId,
      projectId,
      threadId: input.threadId,
      submissionId: input.submissionId,
      messageId: input.messageId,
      turnId: input.turnId ?? null,
      providerInstanceId: input.providerInstanceId,
      providerContextEpoch: contexts[0]?.context_epoch ?? "initial",
      taskFingerprint: fingerprint([
        input.newestMessage,
        description,
        input.explicitReferences ?? [],
        contexts[0]?.refresh_epoch ?? 0,
      ]),
      knownContextFingerprint: fingerprint(input.recentContext),
      threadSettingsRevision: thread.revision,
      projectSettingsRevision: project.revision,
      sourceScopeRevision: state.source_revision,
      threadExclusionRevision: thread.exclusionRevision,
      fundingGeneration: state.funding_generation,
      purgeGeneration: state.purge_generation,
      newestMessage: input.newestMessage,
      projectDescription: description,
      explicitReferences: input.explicitReferences ?? [],
      recentContext: input.recentContext,
      trigger,
    });
  }, Effect.mapError(contextualBoundary));
  const eligible = Effect.fn("Contextual.candidateEligible")(function* (
    candidate: C.ContextualCandidate,
    task: C.ContextualTaskSnapshot,
    comparisonOnly = false,
  ) {
    const aliases =
      candidate.sourceKind === "lecturn-decision" && candidate.guidanceId.startsWith("group:")
        ? yield* sql<{
            decision_id: string;
          }>`SELECT decision_id FROM contextual_group_members WHERE group_id=${candidate.guidanceId.slice(6)}`
        : [];
    const guidanceIds = [
      candidate.guidanceId,
      ...(candidate.sourceKind === "lecturn-decision" ? [`decision:${candidate.decisionId}`] : []),
      ...aliases.map((a) => `decision:${a.decision_id}`),
    ];
    const excluded =
      yield* sql`SELECT 1 FROM contextual_exclusions WHERE thread_id=${task.threadId} AND guidance_id IN ${sql.in(guidanceIds)} LIMIT 1`;
    const suppressed =
      yield* sql`SELECT 1 FROM contextual_suppression WHERE (entity_kind='source' AND entity_id=${candidate.sourceId}) OR (entity_kind='occurrence' AND entity_id=${candidate.occurrenceId}) OR (entity_kind='evidence' AND entity_id IN ${sql.in(candidate.evidence.flatMap((e) => [e.id, ...e.lineageIds]))}) LIMIT 1`;
    // Partial archive coverage does not imply an unusable exchange. Explicit gaps
    // stay ineligible; semantic sufficiency is checked by the evaluator below.
    if (
      excluded.length ||
      suppressed.length ||
      candidate.coverage.missingAntecedents ||
      candidate.coverage.truncated
    )
      return false;
    if (comparisonOnly) return true;
    if (task.trigger === "submission" || task.trigger === "confirmed-compaction") {
      // A private selection consumes only its exact original ranges, not the entire Slack window.
      if (candidate.sourceKind === "slack") {
        const receipts = yield* sql<{
          packet_id: string;
        }>`SELECT packet_id FROM contextual_supply WHERE thread_id=${task.threadId} AND guidance_id=${candidate.guidanceId} AND (${task.trigger === "confirmed-compaction" ? 1 : 0}=0 OR context_epoch=${task.providerContextEpoch}) ORDER BY supplied_at DESC LIMIT 64`;
        if (receipts.length) {
          const supplied: C.ContextualEvidence[] = [];
          for (const receipt of receipts) {
            const packet = yield* repository.suppliedPacket(receipt.packet_id, task.threadId);
            // Expired or unknown retained payloads cannot authorize automatic resupply.
            if (!packet) return false;
            supplied.push(
              ...packet.groups
                .filter((g) => g.guidanceId === candidate.guidanceId)
                .flatMap((g) => g.evidence),
            );
          }
          return !contextualEvidenceCovered(candidate.evidence, supplied);
        }
        return true;
      }
      const supply = yield* sql<{
        fingerprint: string;
        source_revision: number;
        packet_id: string;
      }>`SELECT fingerprint,source_revision,packet_id FROM contextual_supply WHERE thread_id=${task.threadId} AND (guidance_id IN ${sql.in(guidanceIds)} OR (${Number(candidate.sourceKind === "lecturn-decision")}=1 AND fingerprint=${candidate.contentFingerprint})) AND (${task.trigger === "confirmed-compaction" ? 1 : 0}=0 OR context_epoch=${task.providerContextEpoch}) ORDER BY supplied_at DESC,source_revision DESC LIMIT 1`;
      if (supply[0]) {
        if (
          supply[0].fingerprint === candidate.contentFingerprint ||
          candidate.recordRevision <= supply[0].source_revision
        )
          return false;
        const priorPacket = yield* repository.suppliedPacket(supply[0].packet_id, task.threadId);
        const prior = priorPacket?.groups.find((g) => guidanceIds.includes(g.guidanceId));
        if (
          !prior ||
          (normalizeQuote(prior.evidence.map((e) => e.quote).join(" ")) ===
            normalizeQuote(candidate.evidence.map((e) => e.quote).join(" ")) &&
            (candidate.sourceKind !== "lecturn-decision" ||
              !prior.derivedSummary?.match(/^(User-edited|Generated) saved Decision:/u) ||
              normalizeQuote(contextualDecisionMeaning(prior.derivedSummary)) ===
                normalizeQuote(contextualDecisionMeaning(contextualDecisionSummary(candidate)))))
        )
          return false;
      }
    } else if (
      yield* repository.supplied(
        task.threadId,
        candidate.guidanceId,
        candidate.contentFingerprint,
        task.providerContextEpoch,
      )
    )
      return false;
    return true;
  });
  const retrieve = Effect.fn("Contextual.retrieve")(function* (task: C.ContextualTaskSnapshot) {
    yield* assertContextualFence(sql, task);
    const thread = yield* settings.thread(task.threadId);
    const project = yield* settings.project(task.projectId);
    const policy = yield* decodePolicy((yield* host).source_policy_json);
    const allowed = thread.sourceIds.filter((id) => project.sourceIds.includes(id));
    const local = allowed.includes(`decisions:${task.projectId}`)
      ? yield* decisions.retrieve(task)
      : [];
    const slackIds = allowed.filter((id) => policy.allowedSourceIds.includes(id));
    const remote = slackIds.length
      ? yield* Effect.gen(function* () {
          const capture = yield* helper.request("contextual.capture.status", {});
          const sources = yield* helper.request("contextual.sources.list", { limit: 1 });
          const result = yield* helper.request("contextual.retrieve", {
            task: {
              ...task,
              sourceScopeRevision: sources.policy.revision,
              purgeGeneration: capture.purgeGeneration,
            },
            sourceIds: slackIds.filter((id) => sources.policy.allowedSourceIds.includes(id)),
            limit: 24,
            includeHistorical: false,
          });
          yield* assertContextualFence(sql, task);
          return result;
        }).pipe(Effect.option)
      : Option.none<C.ContextualRetrieveResult>();
    const candidates = deduplicateCandidates([
      ...local,
      ...(Option.isSome(remote) ? remote.value.candidates : []),
    ]);
    const selected: C.ContextualCandidate[] = [];
    const previouslySupplied: C.ContextualCandidate[] = [];
    for (const candidate of candidates) {
      if (!(yield* eligible(candidate, task, true))) continue;
      if (yield* eligible(candidate, task)) selected.push(candidate);
      else previouslySupplied.push(candidate);
    }
    return {
      candidates: selected,
      previouslySupplied,
      unavailable: slackIds.length > 0 && Option.isNone(remote),
      coverage: Option.isSome(remote)
        ? remote.value.coverage
        : slackIds.length
          ? { ...completeCoverage, complete: false, unexaminedCount: 1 }
          : completeCoverage,
    };
  }, Effect.mapError(contextualBoundary));
  const transition = Effect.fn("Contextual.transition")(function* (
    p: C.ContextualPreparation,
    state: C.ContextualPreparationState,
    patch: Partial<C.ContextualPreparation> = {},
  ) {
    const next = yield* repository.update(
      { ...p, ...patch, state, revision: p.revision + 1, updatedAt: yield* contextualNow },
      p.revision,
    );
    yield* publish;
    return next;
  });
  const prepareUnsafe = Effect.fn("Contextual.prepare")(
    function* (task: C.ContextualTaskSnapshot, continuation: string) {
      let p = yield* repository.create(
        {
          id: NodeCrypto.randomUUID(),
          task,
          revision: 0,
          state: "requested",
          packetId: null,
          dispatchId: null,
          conflictIds: [],
          attemptsUsed: 0,
          comparisonPairsChecked: 0,
          coverage: completeCoverage,
          updatedAt: yield* contextualNow,
        },
        continuation,
      );
      if (p.state !== "requested") return p;
      // Persist admission first so a slow funding check still has a visible skip/cancel target.
      const funding = yield* fundingStatus({ featureId: "contextual" });
      if (!funding.eligible || funding.generation !== task.fundingGeneration)
        return yield* transition(p, "skipped", {
          skipReason:
            funding.generation !== task.fundingGeneration ||
            funding.state === "unavailable" ||
            ["unavailable", "stale-billing", "disabled", "cohort"].includes(funding.reason)
              ? "unavailable"
              : "funding-required",
        });
      p = yield* transition(p, "retrieving");
      if (task.trigger !== "refresh" && routineFollowup(task.newestMessage))
        return yield* transition(p, "no-useful-context");
      const found = yield* retrieve(task);
      if (!found.candidates.length)
        return yield* transition(p, found.unavailable ? "skipped" : "no-useful-context", {
          coverage: found.coverage,
          ...(found.unavailable ? { skipReason: "source-unavailable" as const } : {}),
        });
      p = yield* transition(p, "evaluating", { coverage: found.coverage });
      const selected: { candidate: C.ContextualCandidate; judgment: C.ContextualJudgment }[] = [];
      const evaluateTargets = Effect.fn("Contextual.evaluateTargets")(function* (
        targets: readonly C.ContextualCandidate[],
      ) {
        const requestId = NodeCrypto.randomUUID();
        const envelope = {
          featureId: "contextual" as const,
          requestId,
          runId: p.id,
          fundingGeneration: task.fundingGeneration,
          templateVersion: "contextual-v1" as const,
          task,
        };
        const cacheKey = fingerprint([
          "contextual-v1",
          task.environmentId,
          task.projectId,
          task.taskFingerprint,
          task.knownContextFingerprint,
          task.sourceScopeRevision,
          task.threadExclusionRevision,
          task.threadSettingsRevision,
          task.projectSettingsRevision,
          task.fundingGeneration,
          task.purgeGeneration,
          targets,
        ]);
        const cachedRows = yield* sql<{
          result_json: string;
        }>`SELECT result_json FROM contextual_evaluations WHERE fingerprint LIKE ${`evaluation:${cacheKey}:%`} AND policy_version='contextual-v1' AND purge_generation=${task.purgeGeneration} ORDER BY updated_at DESC LIMIT 1`;
        let result: C.ContextualEvaluationResult;
        if (cachedRows[0])
          result = {
            ...(yield* decodeEvaluation(cachedRows[0].result_json)),
            requestId,
            runId: p.id,
            replayed: true,
          };
        else {
          p = yield* transition(p, "evaluating", { attemptsUsed: p.attemptsUsed + 1 });
          result = yield* cloud.evaluate({ ...envelope, targets });
          yield* assertContextualFence(sql, task);
          if (
            result.requestId !== requestId ||
            result.runId !== p.id ||
            result.policyVersion !== "contextual-v1"
          )
            return yield* staleContextual();
          yield* sql`INSERT OR REPLACE INTO contextual_evaluations(fingerprint,feature_id,policy_version,purge_generation,result_json,updated_at) VALUES(${`evaluation:${cacheKey}:${result.model}`},'contextual','contextual-v1',${task.purgeGeneration},${encodeEvaluation(result)},${yield* contextualNow})`;
          yield* sql`DELETE FROM contextual_evaluations WHERE fingerprint LIKE 'evaluation:%' AND fingerprint NOT IN (SELECT fingerprint FROM contextual_evaluations WHERE fingerprint LIKE 'evaluation:%' ORDER BY updated_at DESC,fingerprint DESC LIMIT 512)`;
        }
        if (result.requestId !== requestId || result.runId !== p.id)
          return yield* new C.ContextualError({
            code: "unavailable",
            message: "Context evaluation did not match this preparation.",
          });
        return result;
      });
      let index = 0;
      let evaluationIncomplete = false;
      // Reserve two calls for relation checks. There is no automatic retry of paid requests.
      while (index < found.candidates.length && p.attemptsUsed < 4) {
        const targets: C.ContextualCandidate[] = [];
        const requestId = NodeCrypto.randomUUID();
        const envelope = {
          featureId: "contextual" as const,
          requestId,
          runId: p.id,
          fundingGeneration: task.fundingGeneration,
          templateVersion: "contextual-v1" as const,
          task,
        };
        while (index < found.candidates.length && targets.length < 8) {
          const candidate = found.candidates[index++]!;
          if (encodeJson({ ...envelope, targets: [...targets, candidate] }).length > 48000) {
            if (targets.length) {
              index--;
              break;
            }
            continue;
          }
          targets.push(candidate);
        }
        if (!targets.length) continue;
        const result = yield* evaluateTargets(targets);
        const incomplete = result.judgments.filter(
          (judgment) => judgment.evaluationComplete === false,
        ).length;
        if (incomplete) evaluationIncomplete = true;
        if (incomplete)
          p = yield* transition(p, "evaluating", {
            coverage: {
              ...p.coverage,
              complete: false,
              unexaminedCount: p.coverage.unexaminedCount + incomplete,
            },
          });
        for (const judgment of result.judgments) {
          const candidate = targets.find((c) => c.id === judgment.targetId);
          if (
            !candidate ||
            judgment.selectedEvidenceIds.some((id) => !candidate.evidence.some((e) => e.id === id))
          )
            continue;
          if (
            judgment.useful >= 0.8 &&
            judgment.usableEvidence >= 0.8 &&
            judgment.sufficientContext >= 0.8 &&
            judgment.selectedEvidenceIds.length
          ) {
            const selection = applyContextualSelection(candidate, judgment);
            if (selection && (yield* eligible(selection, task)))
              selected.push({ candidate: selection, judgment });
          }
        }
      }
      if (index < found.candidates.length)
        p = yield* transition(p, "evaluating", {
          coverage: {
            ...p.coverage,
            complete: false,
            unexaminedCount: p.coverage.unexaminedCount + found.candidates.length - index,
          },
        });
      if (!selected.length)
        return yield* transition(
          p,
          evaluationIncomplete ? "skipped" : "no-useful-context",
          evaluationIncomplete ? { skipReason: "evaluation-incomplete" } : {},
        );
      // Keep validated original excerpts and their retained context, never fabricated strings.
      const choices = selected.filter(
        ({ candidate }) =>
          contextualPacketByteBound([
            {
              evidence: candidate.evidence,
              attribution:
                candidate.sourceKind === "lecturn-decision" ? candidate.attribution : null,
              derivedSummary: contextualDecisionSummary(candidate),
            },
          ]) <= 1500,
      );
      if (!choices.length)
        return yield* transition(p, "no-useful-context", {
          coverage: {
            ...p.coverage,
            complete: false,
            truncated: true,
            unexaminedCount: selected.length,
          },
        });
      const chosen = choices[0]!;
      const groups: C.ContextualPacketGroup[] = [
        {
          candidateId: chosen.candidate.id,
          occurrenceId: chosen.candidate.occurrenceId,
          guidanceId: chosen.candidate.guidanceId,
          contentFingerprint: chosen.candidate.contentFingerprint,
          recordRevision: chosen.candidate.recordRevision,
          evidence: chosen.candidate.evidence,
          attribution:
            chosen.candidate.sourceKind === "lecturn-decision"
              ? chosen.candidate.attribution
              : null,
          derivedSummary: contextualDecisionSummary(chosen.candidate),
          reasons: chosen.judgment.reasons,
        },
      ];
      p = yield* transition(p, "checking-conflicts");
      const pairs: C.ContextualComparisonPair[] = [];
      const claim = (c: C.ContextualCandidate): C.ContextualClaim => ({
        id: c.id,
        candidateId: c.id,
        occurrenceId: c.occurrenceId,
        revision: c.recordRevision,
        evidence: c.evidence,
        attribution: c.sourceKind === "lecturn-decision" ? c.attribution : null,
        derivedSummary: contextualDecisionSummary(c),
        scope: task.projectDescription,
        temporalApplicability:
          c.sourceKind === "lecturn-decision" ? c.lifecycle : "observed source exchange",
        acceptedReplacementIds: c.sourceKind === "lecturn-decision" ? c.replacementIds : [],
      });
      let correction = false;
      const previousSupply = yield* sql<{
        packet_id: string;
        fingerprint: string;
        source_revision: number;
        context_epoch: string;
      }>`SELECT packet_id,fingerprint,source_revision,context_epoch FROM contextual_supply WHERE thread_id=${task.threadId} AND guidance_id=${chosen.candidate.guidanceId} ORDER BY supplied_at DESC,source_revision DESC LIMIT 1`;
      if (
        previousSupply[0] &&
        (task.trigger === "submission" ||
          (task.trigger === "confirmed-compaction" &&
            previousSupply[0].context_epoch === task.providerContextEpoch)) &&
        previousSupply[0].fingerprint !== chosen.candidate.contentFingerprint
      ) {
        const previousPacket = yield* repository.suppliedPacket(
          previousSupply[0].packet_id,
          task.threadId,
        );
        const previous = previousPacket?.groups.find(
          (g) => g.guidanceId === chosen.candidate.guidanceId,
        );
        if (
          !previous ||
          previous.recordRevision >= chosen.candidate.recordRevision ||
          p.attemptsUsed >= 6
        )
          return yield* transition(p, "no-useful-context");
        const pair: C.ContextualComparisonPair = {
          id: fingerprint([
            "correction",
            previous.contentFingerprint,
            chosen.candidate.contentFingerprint,
          ]),
          left: claim(chosen.candidate),
          right: {
            id: `previous:${previousPacket!.id}`,
            candidateId: `previous:${previous.candidateId}`,
            occurrenceId: previous.occurrenceId,
            revision: previous.recordRevision,
            evidence: previous.evidence,
            attribution: previous.attribution,
            derivedSummary: previous.derivedSummary,
            scope: task.projectDescription,
            temporalApplicability:
              "Historical revision previously supplied to this thread; compare with the newer revision of the same source occurrence",
            acceptedReplacementIds: [],
          },
        };
        const requestId = NodeCrypto.randomUUID();
        const request = {
          featureId: "contextual" as const,
          requestId,
          runId: p.id,
          fundingGeneration: task.fundingGeneration,
          templateVersion: "contextual-v1" as const,
          task,
          pairs: [pair],
        };
        if (encodeJson(request).length > 48000) return yield* transition(p, "no-useful-context");
        const cacheKey = `correction:${fingerprint([pair, task.taskFingerprint, task.knownContextFingerprint, task.purgeGeneration, task.sourceScopeRevision, task.fundingGeneration])}`;
        const cached = yield* sql<{
          result_json: string;
        }>`SELECT result_json FROM contextual_evaluations WHERE fingerprint=${cacheKey} AND purge_generation=${task.purgeGeneration}`;
        let result: C.ContextualConflictCheckResult;
        if (cached[0]) {
          result = {
            ...(yield* decodeConflictResult(cached[0].result_json)),
            requestId,
            runId: p.id,
          };
          p = yield* transition(p, "checking-conflicts", {
            comparisonPairsChecked: p.comparisonPairsChecked + 1,
          });
        } else {
          p = yield* transition(p, "checking-conflicts", {
            attemptsUsed: p.attemptsUsed + 1,
            comparisonPairsChecked: p.comparisonPairsChecked + 1,
          });
          result = yield* cloud.conflicts(request);
          yield* assertContextualFence(sql, task);
          if (result.requestId !== requestId || result.runId !== p.id)
            return yield* staleContextual();
          yield* sql`INSERT OR REPLACE INTO contextual_evaluations VALUES(${cacheKey},'contextual','contextual-v1',${task.purgeGeneration},${encodeJson(result)},${yield* contextualNow})`;
        }
        const judgment = result.judgments.find((j) => j.pairId === pair.id);
        if (
          !judgment ||
          !["incompatible", "explicit-replacement"].includes(judgment.relation) ||
          judgment.materialToTask < 0.8 ||
          !judgment.leftEvidenceIds.length ||
          !judgment.rightEvidenceIds.length ||
          !judgment.leftEvidenceIds.every((id) => pair.left.evidence.some((e) => e.id === id)) ||
          !judgment.rightEvidenceIds.every((id) => pair.right.evidence.some((e) => e.id === id))
        )
          return yield* transition(p, "no-useful-context");
        correction = true;
        groups[0] = {
          ...groups[0]!,
          derivedSummary:
            chosen.candidate.sourceKind === "lecturn-decision"
              ? contextualDecisionSummary(chosen.candidate)
              : `Correction to previously supplied revision ${previous.recordRevision}. Previous source quotation: ${previous.evidence.map((e) => e.quote).join("\n")}\nThe exact evidence below is the newer source revision ${chosen.candidate.recordRevision}; it replaces that earlier guidance.`,
        };
        if (contextualPacketByteBound(groups) > 1500)
          return yield* transition(p, "no-useful-context");
      }
      const comparisonCandidates = deduplicateCandidates([
        ...found.previouslySupplied,
        ...choices.slice(1).map(({ candidate }) => candidate),
      ])
        .filter((candidate) => candidate.guidanceId !== chosen.candidate.guidanceId)
        .slice(0, 11);
      const comparisonGroup = (candidate: C.ContextualCandidate): C.ContextualPacketGroup => ({
        candidateId: candidate.id,
        occurrenceId: candidate.occurrenceId,
        guidanceId: candidate.guidanceId,
        contentFingerprint: candidate.contentFingerprint,
        recordRevision: candidate.recordRevision,
        evidence: candidate.evidence,
        attribution: candidate.sourceKind === "lecturn-decision" ? candidate.attribution : null,
        derivedSummary: contextualDecisionSummary(candidate),
        reasons: [],
      });
      for (const other of comparisonCandidates) {
        // Compare current permitted sources, never copies of prior provider history.
        if (found.previouslySupplied.some((candidate) => candidate.id === other.id))
          yield* revalidateGroup(comparisonGroup(other), task);
        pairs.push({
          id: fingerprint([chosen.candidate.id, other.id]),
          left: claim(chosen.candidate),
          right: claim(other),
        });
      }
      if (task.newestMessage.length <= 8000)
        pairs.unshift({
          id: fingerprint([chosen.candidate.id, task.messageId]),
          left: claim(chosen.candidate),
          right: {
            id: `live:${task.messageId}`,
            candidateId: `live:${task.messageId}`,
            occurrenceId: task.messageId,
            revision: 0,
            evidence: [
              {
                id: `live:${task.messageId}`,
                sourceKind: "thread-message",
                threadId: task.threadId,
                messageId: task.messageId,
                messageRole: "user",
                sourceHash: fingerprint(task.newestMessage),
                sourceRevision: 0,
                quote: task.newestMessage,
                start: 0,
                end: task.newestMessage.length,
                coordinateSystem: "utf16",
              },
            ],
            attribution: "user-directed",
            scope: task.projectDescription,
            temporalApplicability: "current explicit user request",
            acceptedReplacementIds: [],
          },
        });
      const cacheBytes = yield* sql<{
        bytes: number;
      }>`SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))),0) AS bytes FROM contextual_evaluations`;
      if ((cacheBytes[0]?.bytes ?? 0) > 8 * 1024 * 1024)
        yield* sql`DELETE FROM contextual_evaluations WHERE NOT EXISTS (SELECT 1 FROM contextual_preparations p WHERE p.state='awaiting-conflict-review' AND contextual_evaluations.fingerprint LIKE 'candidate:' || p.id || ':%')`;
      for (const candidate of [chosen.candidate, ...comparisonCandidates])
        yield* sql`INSERT OR REPLACE INTO contextual_evaluations(fingerprint,feature_id,policy_version,purge_generation,result_json,updated_at) VALUES(${`candidate:${p.id}:${candidate.id}`},'contextual','contextual-v1',${task.purgeGeneration},${encodeCandidate(candidate)},${yield* contextualNow})`;
      const conflicts: C.ContextualConflict[] = [];
      const earlierComparisons = p.comparisonPairsChecked;
      const comparisonLimit = Math.max(0, 12 - earlierComparisons);
      for (
        let start = 0;
        start < Math.min(comparisonLimit, pairs.length) &&
        p.attemptsUsed < 6 &&
        !conflicts.some((c) => c.state === "awaiting-review");
        start += 8
      ) {
        const requestId = NodeCrypto.randomUUID();
        let batch = pairs.slice(start, Math.min(start + 8, comparisonLimit));
        const base = {
          featureId: "contextual" as const,
          requestId,
          runId: p.id,
          fundingGeneration: task.fundingGeneration,
          templateVersion: "contextual-v1" as const,
          task,
        };
        while (batch.length && encodeJson({ ...base, pairs: batch }).length > 48000)
          batch = batch.slice(0, -1);
        if (!batch.length) continue;
        p = yield* transition(p, "checking-conflicts", {
          attemptsUsed: p.attemptsUsed + 1,
          comparisonPairsChecked: p.comparisonPairsChecked + batch.length,
        });
        const result = yield* cloud.conflicts({ ...base, pairs: batch });
        if (result.requestId !== requestId || result.runId !== p.id)
          return yield* staleContextual();
        yield* assertContextualFence(sql, task);
        for (const candidate of comparisonCandidates)
          if (
            found.previouslySupplied.some((prior) => prior.id === candidate.id) &&
            batch.some((pair) => pair.right.candidateId === candidate.id)
          )
            yield* revalidateGroup(comparisonGroup(candidate), task);
        for (const judgment of result.judgments) {
          const pair = batch.find((pair) => pair.id === judgment.pairId);
          if (
            pair?.right.evidence.some((e) => e.sourceKind === "thread-message") &&
            (judgment.relation === "explicit-replacement" ||
              (judgment.relation === "incompatible" &&
                explicitCurrentDirection(task.newestMessage)))
          )
            return yield* transition(p, "no-useful-context");
          if (
            !pair ||
            judgment.relation !== "incompatible" ||
            judgment.materialToTask < 0.4 ||
            !judgment.leftEvidenceIds.length ||
            !judgment.rightEvidenceIds.length
          )
            continue;
          if (
            pair.left.acceptedReplacementIds.includes(pair.right.occurrenceId) ||
            pair.right.acceptedReplacementIds.includes(pair.left.occurrenceId)
          )
            continue;
          const conflict = yield* decodeConflictValue({
            id: NodeCrypto.randomUUID(),
            threadId: task.threadId,
            taskFingerprint: task.taskFingerprint,
            revision: 0,
            pair,
            judgment,
            state: judgment.materialToTask >= 0.8 ? "awaiting-review" : "possible",
            createdAt: yield* contextualNow,
          });
          conflicts.push(conflict);
          yield* sql`INSERT INTO contextual_conflicts(id,thread_id,preparation_id,revision,relation_json,status,updated_at) VALUES(${conflict.id},${task.threadId},${p.id},0,${encodeConflict(conflict)},${conflict.state},${conflict.createdAt})`;
          if (conflict.state === "awaiting-review") {
            p = yield* transition(p, "awaiting-conflict-review", {
              conflictIds: conflicts.map((c) => c.id),
            });
            break;
          }
        }
      }
      if (conflicts.length && !conflicts.some((c) => c.state === "awaiting-review"))
        return yield* transition(p, "no-useful-context", {
          conflictIds: conflicts.map((c) => c.id),
        });
      if (
        chosen.judgment.contradicts >= 0.5 &&
        p.comparisonPairsChecked - earlierComparisons < pairs.length &&
        !conflicts.some((c) => c.state === "awaiting-review")
      )
        return yield* transition(p, "no-useful-context", {
          coverage: {
            ...p.coverage,
            complete: false,
            unexaminedCount:
              p.coverage.unexaminedCount +
              pairs.length -
              (p.comparisonPairsChecked - earlierComparisons),
          },
        });
      const packet: C.ContextualPacket = {
        id: NodeCrypto.randomUUID(),
        preparationId: p.id,
        task,
        groups,
        tokenCount: contextualPacketByteBound(groups),
        tokenCounting: "conservative-bound",
        payloadRef: NodeCrypto.randomUUID(),
        createdAt: yield* contextualNow,
        resolutionIds: [],
        purpose: correction
          ? "correction"
          : task.trigger === "refresh"
            ? "refresh"
            : task.trigger === "confirmed-compaction"
              ? "restored-after-compaction"
              : task.trigger === "correction"
                ? "correction"
                : "new-context",
      };
      if (packet.tokenCount > 1500) return yield* transition(p, "no-useful-context");
      yield* repository.putPacket(packet);
      return yield* transition(
        p,
        conflicts.some((c) => c.state === "awaiting-review")
          ? "awaiting-conflict-review"
          : "prepared",
        {
          packetId: packet.id,
          conflictIds: conflicts.map((c) => c.id),
          coverage: {
            ...p.coverage,
            complete:
              p.coverage.complete && p.comparisonPairsChecked - earlierComparisons >= pairs.length,
            unexaminedCount:
              p.coverage.unexaminedCount +
              Math.max(0, pairs.length - (p.comparisonPairsChecked - earlierComparisons)),
          },
        },
      );
    },
    Effect.mapError(contextualBoundary),
    Effect.withTracerEnabled(false),
  );
  const prepare = Effect.fn("Contextual.prepareBounded")(function* (
    task: C.ContextualTaskSnapshot,
    continuation: string,
  ) {
    return yield* prepareUnsafe(task, continuation).pipe(
      Effect.timeout("60 seconds"),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            preparation_json: string;
          }>`SELECT preparation_json FROM contextual_preparations WHERE thread_id=${task.threadId} AND submission_id=${task.submissionId}`;
          if (!rows[0])
            return yield* new C.ContextualError({
              code: "unavailable",
              message: "Optional context is unavailable.",
            });
          const p = yield* decodePreparation(rows[0].preparation_json);
          // A detected conflict is durable and never converted into timeout permission.
          return transient.has(p.state)
            ? yield* transition(p, "skipped", {
                skipReason:
                  isContextualError(error) && error.code === "allowance-exhausted"
                    ? "allowance-exhausted"
                    : "unavailable",
              })
            : p;
        }),
      ),
      Effect.mapError(contextualBoundary),
    );
  });
  const revalidateGroup = Effect.fn("Contextual.revalidateGroup")(function* (
    group: C.ContextualPacketGroup,
    task: C.ContextualTaskSnapshot,
  ) {
    const blocked =
      yield* sql`SELECT 1 FROM contextual_suppression WHERE (entity_kind='source' AND entity_id IN ${sql.in(group.evidence.map((e) => e.sourceId))}) OR (entity_kind='occurrence' AND entity_id=${group.occurrenceId}) OR (entity_kind='evidence' AND entity_id IN ${sql.in(group.evidence.flatMap((e) => [e.id, ...e.lineageIds]))}) LIMIT 1`;
    if (blocked.length) return yield* staleContextual();
    if (group.evidence.some((e) => e.sourceKind === "lecturn-decision")) {
      if (!(yield* decisions.revalidateGroup(group, task))) return yield* staleContextual();
    } else
      for (const e of group.evidence) {
        const capture = yield* helper.request("contextual.capture.status", {});
        const current = yield* helper.request("contextual.evidence.read", {
          evidenceId: e.id,
          sourceId: e.sourceId,
          expectedSourceRevision: e.sourceRevision,
          expectedPurgeGeneration: capture.purgeGeneration,
          expectedExchangeRevision: group.recordRevision,
          expectedExchangeFingerprint: group.contentFingerprint,
        });
        if (
          current.evidence.sourceHash !== e.sourceHash ||
          current.evidence.start > e.start ||
          current.evidence.end < e.end ||
          current.evidence.quote.slice(
            e.start - current.evidence.start,
            e.end - current.evidence.start,
          ) !== e.quote ||
          current.evidence.availability === "forgotten" ||
          current.evidence.availability === "changed"
        )
          return yield* staleContextual();
      }
  }, Effect.mapError(contextualBoundary));
  const revalidate = Effect.fn("Contextual.revalidate")(function* (
    preparationId: string,
    checkFunding = true,
  ) {
    const preparation = yield* repository.get(preparationId);
    if (checkFunding) {
      const funding = yield* fundingStatus({ featureId: "contextual" });
      if (!funding.eligible)
        return yield* new C.ContextualError({
          code: "forbidden",
          message: "Contextual funding is not currently eligible.",
        });
    }
    yield* assertContextualFence(sql, preparation.task);
    const packet = preparation.packetId
      ? yield* repository.packet(preparation.packetId, preparation.task.threadId)
      : null;
    if (preparation.packetId && !packet) return yield* staleContextual();
    if (packet) for (const group of packet.groups) yield* revalidateGroup(group, preparation.task);
    return { preparation, packet };
  }, Effect.mapError(contextualBoundary));
  const sources = (input: C.ContextualSourcesListRequest) =>
    helper.request("contextual.sources.list", input);
  const configureSources = Effect.fn("Contextual.configureSources")(function* (
    input: C.ContextualSourcesConfigureRequest,
  ) {
    // Fence previously prepared work before any helper mutation, including an uncertain transport outcome.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* host;
        const old = yield* decodePolicy(current.source_policy_json);
        const restrictive = {
          ...old,
          allowedSourceIds: old.allowedSourceIds.filter((id) =>
            input.policy.allowedSourceIds.includes(id),
          ),
          allowDirectMessages: old.allowDirectMessages && input.policy.allowDirectMessages,
          allowGroupDirectMessages:
            old.allowGroupDirectMessages && input.policy.allowGroupDirectMessages,
        };
        yield* sql`UPDATE contextual_host_state SET source_policy_json=${encodePolicy(restrictive)},source_revision=source_revision+1,updated_at=${yield* contextualNow} WHERE singleton=1`;
        yield* sql`DELETE FROM contextual_evaluations`;
        yield* appendContextualEvent(sql, {
          revision: current.source_revision + 1,
          kind: "source-policy-changed",
          entityId: "contextual",
        });
      }),
    );
    yield* publish;
    const result = yield* helper.request("contextual.sources.configure", input).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const actual = yield* helper.request("contextual.sources.list", { limit: 1 });
          if (encodePolicy(actual.policy) !== encodePolicy(input.policy)) return yield* error;
          return { policy: actual.policy, sourceGeneration: actual.sourceGeneration };
        }),
      ),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE contextual_host_state SET source_policy_json=${encodePolicy(result.policy)},updated_at=${yield* contextualNow} WHERE singleton=1`;
        // Explicit administrative re-selection grants future source capture, not item/lineage resurrection.
        for (const id of result.policy.allowedSourceIds)
          yield* sql`DELETE FROM contextual_suppression WHERE entity_kind='source' AND entity_id=${id}`;
        yield* appendContextualEvent(sql, {
          revision: (yield* host).source_revision,
          kind: "source-policy-changed",
          entityId: "contextual",
        });
      }),
    );
    yield* publish;
    return result;
  }, Effect.mapError(contextualBoundary));
  const captureStatus = () => helper.request("contextual.capture.status", {});
  const setCaptureUnsafe = Effect.fn("Contextual.setCapture")(function* (
    input: C.ContextualHostCaptureRequest,
  ) {
    const status = yield* fundingStatus({ featureId: "contextual" });
    if (input.state === "running" && !collectionEligible(status))
      return yield* new C.ContextualError({
        code: "forbidden",
        message: "Approve Contextual membership before starting collection.",
      });
    const current = yield* captureStatus();
    if (current.generation !== input.expectedGeneration) return yield* staleContextual();
    yield* sql`UPDATE contextual_host_state SET capture_requested=${Number(input.state === "running")},updated_at=${yield* contextualNow} WHERE singleton=1`;
    const now = yield* DateTime.now;
    const result = yield* helper.request("contextual.capture.setState", {
      ...input,
      fundingGeneration: status.generation,
      eligibilityValidUntil:
        input.state === "running" ? DateTime.formatIso(DateTime.add(now, { minutes: 5 })) : null,
    });
    yield* appendContextualEvent(sql, {
      revision: result.generation,
      kind: "capture-changed",
      entityId: "contextual",
    });
    yield* publish;
    return result;
  }, Effect.mapError(contextualBoundary));
  const setCapture = (input: C.ContextualHostCaptureRequest) =>
    setCaptureUnsafe(input).pipe(captureMutex.withPermits(1));
  const maintainCapture = Effect.fn("Contextual.maintainCapture")(
    function* () {
      yield* purge.ensureHost;
      const rows = yield* sql<{
        capture_requested: number;
      }>`SELECT capture_requested FROM contextual_host_state WHERE singleton=1`;
      const current = yield* captureStatus();
      if (rows[0]?.capture_requested !== 1 && current.state !== "running") return;
      const status = yield* fundingStatus({ featureId: "contextual" });
      const running = rows[0]?.capture_requested === 1 && collectionEligible(status);
      if (!running && current.state !== "running") return;
      const now = yield* DateTime.now;
      const result = yield* helper.request("contextual.capture.setState", {
        state: running ? "running" : "paused",
        expectedGeneration: current.generation,
        fundingGeneration: status.generation,
        eligibilityValidUntil: running
          ? DateTime.formatIso(DateTime.add(now, { minutes: 5 }))
          : null,
      });
      yield* appendContextualEvent(sql, {
        revision: result.generation,
        kind: "capture-changed",
        entityId: "contextual",
      });
      yield* publish;
    },
    captureMutex.withPermits(1),
    Effect.timeout("30 seconds"),
    Effect.mapError(contextualBoundary),
  );
  const projectSettings = (input: { projectId: C.ProjectId }) => settings.project(input.projectId);
  const updateProjectSettings = (input: C.ContextualProjectSettingsUpdateRequest) =>
    settings.updateProject(input).pipe(Effect.tap(() => publish));
  const updateThreadSettings = (input: C.ContextualThreadSettingsUpdateRequest) =>
    settings.updateThread(input).pipe(Effect.tap(() => publish));
  const refresh = Effect.fn("Contextual.refresh")(
    function* (input: C.ContextualRefreshRequest) {
      const old = yield* settings.thread(input.threadId);
      if (old.revision !== input.expectedRevision) return yield* staleContextual();
      yield* sql`UPDATE contextual_thread_settings SET revision=revision+1,refresh_epoch=refresh_epoch+1,context_epoch=${`refresh:${input.actionId}`},updated_at=${yield* contextualNow} WHERE thread_id=${input.threadId}`;
      yield* appendContextualEvent(sql, {
        threadId: input.threadId,
        revision: old.revision + 1,
        kind: "settings-changed",
        entityId: input.threadId,
      });
      return yield* settings.thread(input.threadId);
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );
  const exclude = Effect.fn("Contextual.exclude")(
    function* (input: C.ContextualExclusionRequest) {
      const old = yield* settings.thread(input.threadId);
      if (old.exclusionRevision !== input.expectedRevision) return yield* staleContextual();
      const members = input.guidanceId.startsWith("group:")
        ? yield* sql<{
            decision_id: string;
          }>`SELECT m.decision_id FROM contextual_group_members m JOIN contextual_decision_groups g ON g.id=m.group_id WHERE m.group_id=${input.guidanceId.slice(6)} AND g.project_id=(SELECT project_id FROM projection_threads WHERE thread_id=${input.threadId})`
        : [];
      // Exclusions belong to the occurrences selected now, not a mutable presentation group.
      // Current membership resolves their aliases at retrieval, without transferring the
      // exclusion to other occurrences after an undo or detach.
      const guidanceIds = members.length
        ? members.map((m) => `decision:${m.decision_id}`)
        : [input.guidanceId];
      if (input.excluded) {
        for (const guidanceId of guidanceIds)
          yield* sql`INSERT OR REPLACE INTO contextual_exclusions(thread_id,guidance_id,action_id) VALUES(${input.threadId},${guidanceId},${input.actionId})`;
      } else
        yield* sql`DELETE FROM contextual_exclusions WHERE thread_id=${input.threadId} AND guidance_id IN ${sql.in([input.guidanceId, ...guidanceIds])}`;
      yield* sql`UPDATE contextual_thread_settings SET exclusion_revision=exclusion_revision+1,updated_at=${yield* contextualNow} WHERE thread_id=${input.threadId}`;
      yield* appendContextualEvent(sql, {
        threadId: input.threadId,
        revision: old.revision + 1,
        kind: "settings-changed",
        entityId: input.threadId,
      });
      return yield* settings.thread(input.threadId);
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );
  const preparationAction = Effect.fn("Contextual.preparationAction")(function* (
    input: C.ContextualPreparationActionRequest,
  ) {
    const p = yield* repository.get(input.preparationId);
    if (p.revision !== input.expectedRevision) return yield* staleContextual();
    return yield* transition(p, input.action === "cancel" ? "canceled" : "skipped", {
      skipReason: "user-requested",
    });
  }, Effect.mapError(contextualBoundary));
  const disclosures = Effect.fn("Contextual.disclosures")(function* (
    input: C.ContextualReadRequest,
  ) {
    const limit = input.limit ?? 50;
    const items = yield* repository.disclosures(
      input.threadId,
      input.cursor,
      limit + 1,
      input.messageId,
    );
    const preparations = input.messageId
      ? yield* sql<{
          preparation_json: string;
        }>`SELECT preparation_json FROM contextual_preparations
          WHERE thread_id=${input.threadId} AND message_id=${input.messageId}
          ORDER BY created_at DESC,id DESC LIMIT 1`
      : [];
    return {
      preparation: preparations[0]
        ? yield* decodePreparation(preparations[0].preparation_json)
        : null,
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? items[limit - 1]!.receipt.id : null,
    };
  }, Effect.mapError(contextualBoundary));
  const conflicts = Effect.fn("Contextual.conflicts")(function* (
    input: C.ContextualConflictListRequest,
  ) {
    yield* requireContextualThread(sql, input.threadId);
    const rows = yield* sql<{
      relation_json: string;
    }>`SELECT relation_json FROM contextual_conflicts WHERE thread_id=${input.threadId} AND relation_json IS NOT NULL AND ${input.preparationId ? sql`preparation_id=${input.preparationId}` : sql`1=1`} AND ${input.cursor ? sql`id>${input.cursor}` : sql`1=1`} ORDER BY id LIMIT ${(input.limit ?? 50) + 1}`;
    const items = yield* Effect.forEach(rows.slice(0, input.limit ?? 50), (r) =>
      decodeConflict(r.relation_json),
    );
    return { items, nextCursor: rows.length > (input.limit ?? 50) ? items.at(-1)!.id : null };
  }, Effect.mapError(contextualBoundary));
  const resolveConflict = Effect.fn("Contextual.resolveConflict")(
    function* (input: C.ContextualConflictResolution) {
      const rows = yield* sql<{
        relation_json: string | null;
        preparation_id: string;
      }>`SELECT relation_json,preparation_id FROM contextual_conflicts WHERE id=${input.conflictId} AND thread_id=${input.threadId}`;
      const row = rows[0];
      if (!row?.relation_json) return yield* staleContextual();
      const conflict = yield* decodeConflict(row.relation_json);
      if (
        conflict.revision !== input.expectedRevision ||
        conflict.taskFingerprint !== input.taskFingerprint ||
        conflict.pair.left.revision !== input.leftRevision ||
        conflict.pair.right.revision !== input.rightRevision ||
        conflict.state !== "awaiting-review"
      )
        return yield* staleContextual();
      const original = yield* repository.get(row.preparation_id);
      if (original.state !== "awaiting-conflict-review") return yield* staleContextual();
      const escape = input.action === "cancel-turn" || input.action === "skip-context";
      const { preparation, packet } = escape
        ? { preparation: original, packet: null }
        : yield* revalidate(row.preparation_id, false);
      if (preparation.state !== "awaiting-conflict-review") return yield* staleContextual();
      const validatedGroups = new Map<string, C.ContextualPacketGroup>();
      if (!escape)
        for (const side of [conflict.pair.left, conflict.pair.right]) {
          if (side.evidence.every((e) => e.sourceKind === "thread-message")) continue;
          const rows = yield* sql<{
            result_json: string;
          }>`SELECT result_json FROM contextual_evaluations WHERE fingerprint=${`candidate:${preparation.id}:${side.candidateId}`} AND purge_generation=${preparation.task.purgeGeneration}`;
          if (!rows[0]) return yield* staleContextual();
          const candidate = yield* decodeCandidate(rows[0].result_json);
          if (
            candidate.recordRevision !== side.revision ||
            candidate.occurrenceId !== side.occurrenceId
          )
            return yield* staleContextual();
          const group: C.ContextualPacketGroup = {
            candidateId: candidate.id,
            occurrenceId: candidate.occurrenceId,
            guidanceId: candidate.guidanceId,
            contentFingerprint: candidate.contentFingerprint,
            recordRevision: candidate.recordRevision,
            evidence: candidate.evidence,
            attribution: candidate.sourceKind === "lecturn-decision" ? candidate.attribution : null,
            derivedSummary: `${contextualDecisionSummary(candidate) ? `${contextualDecisionSummary(candidate)}\n` : ""}Task-scoped user resolution: ${input.action}${input.clarification ? `. ${input.clarification}` : ""}`,
            reasons: ["conflict"],
          };
          yield* revalidateGroup(group, preparation.task);
          validatedGroups.set(side.id, group);
        }
      const next = { ...conflict, state: "resolved" as const, revision: conflict.revision + 1 };
      yield* sql`UPDATE contextual_conflicts SET relation_json=${encodeConflict(next)},resolution_json=${encodeResolution(input)},status='resolved',revision=${next.revision},updated_at=${yield* contextualNow} WHERE id=${conflict.id}`;
      if (input.action === "cancel-turn" || input.action === "skip-context")
        yield* transition(preparation, input.action === "cancel-turn" ? "canceled" : "skipped", {
          skipReason: "user-requested",
        });
      else if (packet) {
        // Both sides remain exact independent occurrences. A task resolution never edits saved truth.
        const sides =
          input.action === "use-left"
            ? [conflict.pair.left]
            : input.action === "use-right"
              ? [conflict.pair.right]
              : [conflict.pair.left, conflict.pair.right];
        const groups: C.ContextualPacketGroup[] = [];
        for (const side of sides) {
          if (side.evidence.every((e) => e.sourceKind === "thread-message")) continue;
          const group = validatedGroups.get(side.id);
          if (!group) return yield* staleContextual();
          groups.push(group);
        }
        if (!groups.length) {
          yield* transition(preparation, "skipped", { skipReason: "user-requested" });
          return next;
        }
        const normalizedGroups = normalizeContextualPacketGroups(groups);
        if (!normalizedGroups)
          return yield* new C.ContextualError({
            code: "invalid",
            message:
              "These source excerpts cannot be combined safely. Choose one guidance or skip additions.",
          });
        if (
          normalizedGroups.some((g) => !g.evidence.length) ||
          contextualPacketByteBound(normalizedGroups) > 1500
        )
          return yield* new C.ContextualError({
            code: "invalid",
            message: "Both complete claims do not fit. Choose one guidance or skip additions.",
          });
        const updated = {
          ...packet,
          groups: normalizedGroups,
          tokenCount: contextualPacketByteBound(normalizedGroups),
          resolutionIds: [...packet.resolutionIds, input.actionId],
        };
        yield* sql`UPDATE contextual_packets SET packet_json=${encodePacket(updated)},payload_bytes=${new TextEncoder().encode(encodePacket(updated)).length} WHERE id=${packet.id}`;
        yield* recordContextualPacketLineage(sql, updated);
        const remaining =
          yield* sql`SELECT 1 FROM contextual_conflicts WHERE preparation_id=${preparation.id} AND status='awaiting-review' LIMIT 1`;
        if (!remaining.length) yield* transition(preparation, "prepared");
      }
      yield* appendContextualEvent(sql, {
        threadId: input.threadId,
        revision: next.revision,
        kind: "conflict-changed",
        entityId: conflict.id,
      });
      return next;
    },
    sql.withTransaction,
    Effect.tap(() => publish),
    Effect.mapError(contextualBoundary),
  );
  const subscribe = (input: C.ContextualSubscribeRequest) => {
    let cursor = input.afterSequence;
    const read = Effect.gen(function* () {
      const projectId = input.threadId ? yield* requireContextualThread(sql, input.threadId) : null;
      const rows = yield* sql<{
        sequence: number;
        thread_id: C.ThreadId | null;
        project_id: C.ProjectId | null;
        revision: number;
        kind: C.ContextualEvent["kind"];
        entity_id: string;
        occurred_at: string;
      }>`SELECT * FROM contextual_outbox WHERE sequence>${cursor} AND ${input.threadId ? sql`(thread_id=${input.threadId} OR (thread_id IS NULL AND (project_id IS NULL OR project_id=${projectId})))` : sql`1=1`} ORDER BY sequence LIMIT 4096`;
      const events = rows.map((r) => ({
        sequence: r.sequence,
        threadId: r.thread_id,
        projectId: r.project_id,
        revision: r.revision,
        kind: r.kind,
        entityId: r.entity_id,
        occurredAt: r.occurred_at,
      }));
      cursor = events.at(-1)?.sequence ?? cursor;
      return events;
    }).pipe(Effect.mapError(contextualBoundary));
    const initial = Stream.fromEffect(read).pipe(Stream.flatMap(Stream.fromIterable));
    if (Option.isNone(notifications)) return initial;
    const shared = notifications.value;
    return Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* shared.subscribe;
        return Stream.concat(
          initial,
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect(() => read),
            Stream.flatMap(Stream.fromIterable),
          ),
        );
      }),
    );
  };
  const recover = Effect.fn("Contextual.recover")(function* () {
    yield* purge.recover();
    const uncertain = yield* sql<{
      preparation_json: string;
    }>`SELECT preparation_json FROM contextual_preparations WHERE state='dispatching'`;
    for (const row of uncertain) {
      const p = yield* decodePreparation(row.preparation_json);
      if (!p.dispatchId || !p.packetId) continue;
      yield* repository
        .receipt({
          id: `contextual:${p.dispatchId}`,
          preparationId: p.id,
          packetId: p.packetId,
          dispatchId: p.dispatchId,
          threadId: p.task.threadId,
          submissionId: p.task.submissionId,
          turnId: null,
          providerInstanceId: p.task.providerInstanceId,
          providerContextEpoch: p.task.providerContextEpoch,
          providerReceiptId: null,
          disposition: "fresh",
          acceptance: "unknown",
          evidenceIncluded: true,
          suppliedEvidenceIds: [],
          receivedAt: yield* contextualNow,
        })
        .pipe(
          Effect.catchTag("ContextualError", (error) =>
            error.code === "stale-revision" ? Effect.void : Effect.fail(error),
          ),
        );
    }
    const rows = yield* sql<{
      preparation_json: string;
    }>`SELECT preparation_json FROM contextual_preparations WHERE state IN ('requested','retrieving','evaluating','checking-conflicts')`;
    for (const row of rows) {
      const p = yield* decodePreparation(row.preparation_json);
      if (transient.has(p.state)) yield* transition(p, "skipped", { skipReason: "unavailable" });
    }
  }, Effect.mapError(contextualBoundary));
  const forget = (input: C.ContextualDataForgetRequest) =>
    purge.forget(input).pipe(Effect.tap(() => publish));
  const inspect = Effect.fn("Contextual.inspect")(function* (
    input: C.ContextualArchiveInspectRequest,
  ) {
    const state = yield* host;
    const policy = yield* decodePolicy(state.source_policy_json);
    if (input.sourceIds.some((id) => !policy.allowedSourceIds.includes(id)))
      return yield* new C.ContextualError({
        code: "forbidden",
        message: "Select sources enabled on this host.",
      });
    const capture = yield* helper.request("contextual.capture.status", {});
    const sources = yield* helper.request("contextual.sources.list", { limit: 1 });
    const task: C.ContextualTaskSnapshot = {
      environmentId: helper.environmentId,
      projectId: C.ProjectId.make("archive-inspection"),
      threadId: C.ThreadId.make("archive-inspection"),
      submissionId: NodeCrypto.randomUUID(),
      messageId: C.MessageId.make("archive-inspection"),
      turnId: null,
      providerInstanceId: "archive-inspection",
      providerContextEpoch: "inspection",
      taskFingerprint: fingerprint(input.query),
      knownContextFingerprint: fingerprint(""),
      threadSettingsRevision: 0,
      projectSettingsRevision: 0,
      sourceScopeRevision: sources.policy.revision,
      threadExclusionRevision: 0,
      fundingGeneration: state.funding_generation,
      purgeGeneration: capture.purgeGeneration,
      newestMessage: input.query,
      projectDescription: "",
      explicitReferences: [],
      recentContext: "",
      trigger: "submission",
    };
    return yield* helper.request("contextual.retrieve", {
      task,
      sourceIds: input.sourceIds,
      limit: input.limit,
      includeHistorical: true,
    });
  }, Effect.mapError(contextualBoundary));
  const group = (input: C.ContextualGroupReadRequest) => groups.group(input);
  const mutateGroup = (input: C.ContextualGroupMutationRequest) =>
    groups.mutateGroup(input).pipe(Effect.tap(() => publish));
  const undoGroup = (input: C.ContextualGroupUndoRequest) =>
    groups.undoGroup(input).pipe(Effect.tap(() => publish));
  const evidence = (input: C.ContextualEvidenceReadRequest) =>
    helper.request("contextual.evidence.read", input);
  const exportData = (input: C.ContextualDataExportRequest) =>
    helper.request("contextual.data.export", input);
  return {
    taskSnapshot,
    prepare,
    revalidate,
    recover,
    status,
    projectSettings,
    updateProjectSettings,
    updateThreadSettings,
    refresh,
    exclude,
    preparationAction,
    disclosures,
    conflicts,
    resolveConflict,
    group,
    mutateGroup,
    undoGroup,
    sources,
    configureSources,
    captureStatus,
    setCapture,
    maintainCapture,
    inspect,
    evidence,
    export: exportData,
    forget,
    subscribe,
    fundingStatus,
    funding,
  };
});
export class ContextualService extends Context.Service<
  ContextualService,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualService") {}
export const layer = Layer.effect(ContextualService, make);
