import * as NodeCrypto from "node:crypto";
import {
  DecisionEvidenceId,
  DecisionId,
  ProjectId,
  DecisionWriterOutput,
  ThreadDecisionError,
  type DecisionEvidence,
  type DecisionWriterInput,
  type DecisionWriterAction,
  type ThreadDecision,
} from "@lecturn/contracts";
import {
  decisionFingerprint,
  resolveDecisionQuote,
  splitDecisionText,
  type DecisionTextSpan,
} from "@lecturn/shared/decisionEvidence";
import { Context, Effect, Layer, Ref, Schema, Semaphore, Stream, type Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { ProviderWorkAdmission } from "../provider/ProviderWorkAdmission.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { DecisionRepository } from "./DecisionRepository.ts";
import { DecisionSettingsRepository } from "./DecisionSettingsRepository.ts";
import {
  DecisionJobRepository,
  emptyDecisionJobStage,
  type DecisionJob,
  type DecisionJobStage,
  type DecisionJobSource,
} from "./DecisionJobRepository.ts";
import { DecisionCloudClient } from "./DecisionCloudClient.ts";
import { DecisionWriterBinding, WriterBinding } from "./DecisionWriterBinding.ts";
import { localizeDecisionSpan } from "./DecisionTraversal.ts";

const MODEL = "jev-1.13.0";
const TEMPLATE = "decisions-v1";
const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Continuation = Schema.Struct({
  blockIndex: Counter,
  matched: Schema.Boolean,
  actionKeys: Schema.Array(Schema.String).check(Schema.isMaxLength(256)),
  stalled: Counter,
  candidates: Schema.Array(
    Schema.Struct({ id: Schema.String, evidenceIds: Schema.Array(DecisionEvidenceId) }),
  ).check(Schema.isMaxLength(64)),
});
type Continuation = typeof Continuation.Type;
const decodeContinuation = Schema.decodeUnknownEffect(Continuation);
const decodeBinding = Schema.decodeUnknownEffect(WriterBinding);
const decodeOutput = Schema.decodeUnknownEffect(DecisionWriterOutput, {
  onExcessProperty: "error",
});
const fail = (code: ThreadDecisionError["code"], message: string) =>
  new ThreadDecisionError({ code, message });
const initialContinuation: Continuation = {
  blockIndex: 0,
  matched: false,
  actionKeys: [],
  stalled: 0,
  candidates: [],
};
const evidenceFor = (source: DecisionJobSource, span: DecisionTextSpan): DecisionEvidence => ({
  id: DecisionEvidenceId.make(
    decisionFingerprint([
      source.threadId,
      source.messageId,
      source.sourceGeneration,
      source.sourceHash,
      span.start,
      span.end,
    ]),
  ),
  threadId: source.threadId,
  messageId: source.messageId as DecisionEvidence["messageId"],
  messageRole: source.role,
  sourceHash: source.sourceHash,
  sourceGeneration: source.sourceGeneration,
  canonicalVersion: "1",
  quote: span.text,
  start: span.start,
  end: span.end,
  prefix: source.text.slice(Math.max(0, span.start - 80), span.start),
  suffix: source.text.slice(span.end, span.end + 80),
  occurrence: source.sourceSequence,
  availability: "available",
});
const supportEvidence = (
  sources: ReadonlyArray<DecisionJobSource>,
  primary: string,
  budget: number,
) => {
  const evidence: DecisionEvidence[] = [];
  let remaining = budget;
  for (const source of sources.filter((source) => source.messageId !== primary).toReversed()) {
    if (remaining <= 0) break;
    const count = Math.min(8000, remaining, source.text.length);
    const start = Math.max(0, source.text.length - count);
    const quote = source.text.slice(start);
    if (quote.trim()) {
      evidence.push(evidenceFor(source, { start, end: source.text.length, text: quote }));
      remaining -= quote.length;
    }
  }
  return evidence.toReversed();
};
const contextText = (evidence: ReadonlyArray<DecisionEvidence>) =>
  evidence.map((item) => `[${item.messageRole} ${item.messageId}]\n${item.quote}`).join("\n\n");

interface ValidatedAction {
  readonly action: DecisionWriterAction;
  readonly evidence: ReadonlyArray<DecisionEvidence>;
  readonly key: string;
}
const validateActions = (
  output: DecisionWriterOutput,
  input: Omit<DecisionWriterInput, "modelSelection">,
  primaryId: string,
) =>
  Effect.gen(function* () {
    if (!output.complete && output.unresolvedCandidateIds.length === 0)
      return yield* fail(
        "invalid",
        "An incomplete writer response must identify the candidates that still need work.",
      );
    const candidates = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
    const anchors = new Map(input.evidence.map((anchor) => [anchor.id, anchor]));
    const existing = new Map(input.existingDecisions.map((note) => [note.id, note]));
    const mentioned = new Set<string>(output.unresolvedCandidateIds);
    const actions: ValidatedAction[] = [];
    for (const unresolved of output.unresolvedCandidateIds)
      if (!candidates.has(unresolved))
        return yield* fail("invalid", "The writer referenced an unknown unresolved candidate.");
    for (const action of output.actions) {
      const candidate = candidates.get(action.candidateId);
      if (!candidate) return yield* fail("invalid", "The writer referenced an unknown candidate.");
      mentioned.add(action.candidateId);
      const evidence: DecisionEvidence[] = [];
      if ("evidence" in action) {
        for (const reference of action.evidence) {
          const anchor = anchors.get(reference.evidenceId);
          if (!anchor)
            return yield* fail("invalid", "The writer referenced evidence outside its input.");
          const resolved = resolveDecisionQuote(anchor.quote, reference.quote);
          if (!resolved)
            return yield* fail(
              "invalid",
              "A writer quotation is missing or ambiguous in its supplied evidence.",
            );
          evidence.push({
            ...anchor,
            quote: reference.quote,
            start: anchor.start + resolved.start,
            end: anchor.start + resolved.end,
            prefix: `${anchor.prefix}${anchor.quote.slice(0, resolved.start)}`.slice(-80),
            suffix: `${anchor.quote.slice(resolved.end)}${anchor.suffix}`.slice(0, 80),
          });
        }
        if (
          !action.evidence.some(
            (reference) =>
              candidate.evidenceIds.includes(reference.evidenceId) &&
              anchors.get(reference.evidenceId)?.messageId === primaryId,
          )
        )
          return yield* fail(
            "invalid",
            "Each decision must cite its new target, not only old supporting context.",
          );
      }
      if (action.action === "duplicate" || action.action === "propose_replacement") {
        const id = action.action === "duplicate" ? action.existingId : action.predecessorId;
        if (existing.get(id)?.revision !== action.expectedRevision)
          return yield* fail(
            "invalid",
            "The writer referenced an existing decision or revision outside its input.",
          );
      }
      if (action.action === "create" || action.action === "propose_replacement") {
        const roles = new Set(evidence.map((anchor) => anchor.messageRole));
        if (
          (action.attribution === "user-directed" && !roles.has("user")) ||
          (action.attribution === "agent-chosen" && !roles.has("assistant")) ||
          (action.attribution === "user-accepted" &&
            (!roles.has("user") || !roles.has("assistant")))
        )
          return yield* fail(
            "invalid",
            "The claimed attribution lacks evidence from the required speaker.",
          );
      }
      actions.push({ action, evidence, key: decisionFingerprint([action]) });
    }
    for (const candidate of input.candidates)
      if (!mentioned.has(candidate.id))
        return yield* fail(
          "invalid",
          "The writer omitted a candidate without marking it unresolved.",
        );
    if (output.complete && output.actions.some((action) => action.action === "needs_context"))
      return yield* fail("invalid", "The writer cannot mark a context request complete.");
    return actions;
  });

export class DecisionWorker extends Context.Service<
  DecisionWorker,
  {
    readonly drive: Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly notify: Effect.Effect<void>;
  }
>()("lecturn/threadDecisions/DecisionWorker") {}

const relatedStopWords = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "will",
  "use",
  "should",
  "have",
  "from",
  "into",
  "instead",
]);

export const make = Effect.gen(function* () {
  const jobs = yield* DecisionJobRepository;
  const repository = yield* DecisionRepository;
  const settings = yield* DecisionSettingsRepository;
  const cloud = yield* DecisionCloudClient;
  const writer = yield* DecisionWriterBinding;
  const policy = yield* BackgroundPolicy;
  const admission = yield* ProviderWorkAdmission;
  const providers = yield* ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry;
  const sql = yield* SqlClient.SqlClient;
  const owner = NodeCrypto.randomUUID();
  const mutex = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);
  const requiredFunding = Effect.gen(function* () {
    const status = yield* cloud.fundingStatus;
    if (!status.eligible || status.state !== "active")
      return yield* fail("forbidden", "Decision tracking requires active funded access.");
    return status;
  });
  const related = Effect.fn("DecisionWorker.related")(function* (
    job: DecisionJob,
    evidence: ReadonlyArray<DecisionEvidence>,
  ) {
    const ids = evidence.map((anchor) => anchor.messageId);
    const overlapping = ids.length
      ? yield* sql<{
          id: string;
        }>`SELECT DISTINCT d.id FROM thread_decisions d JOIN decision_evidence e ON e.decision_id = d.id WHERE d.project_id = ${job.projectId} AND d.review_state <> 'dismissed' AND ${sql.in("e.message_id", ids)} ORDER BY d.occurred_at DESC,d.source_sequence DESC,d.id DESC LIMIT 20`
      : [];
    const notes = yield* Effect.forEach(overlapping, (row) =>
      repository.get({ projectId: job.projectId, id: DecisionId.make(row.id) }),
    );
    // Retrieve bounded lexical matches across the project before filling with
    // recent thread notes. A decision in another thread can be a predecessor.
    const terms = [
      ...new Set(
        evidence.flatMap((anchor) =>
          (anchor.quote.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).filter(
            (word) => word.length <= 64 && !relatedStopWords.has(word),
          ),
        ),
      ),
    ]
      .sort((left, right) => right.length - left.length)
      .slice(0, 8);
    if (notes.length < 20 && terms.length > 0) {
      const scores = terms.map(
        (term) =>
          sql`CASE WHEN instr(lower(d.title || ' ' || d.body || ' ' || coalesce(d.rationale, '')), ${term}) > 0 THEN 1 ELSE 0 END`,
      );
      const score = sql.join(" + ")(scores);
      const matching = yield* sql<{ id: string }>`SELECT d.id FROM thread_decisions d
        WHERE d.project_id = ${job.projectId} AND d.review_state <> 'dismissed'
          AND ${score} > 0
        ORDER BY ${score} DESC, d.occurred_at DESC, d.source_sequence DESC, d.id DESC LIMIT 20`;
      for (const row of matching) {
        if (notes.length >= 20) break;
        if (!notes.some((note) => note.id === row.id))
          notes.push(
            yield* repository.get({ projectId: job.projectId, id: DecisionId.make(row.id) }),
          );
      }
    }
    if (notes.length < 20) {
      const latest = yield* repository.list({
        projectId: job.projectId,
        threadId: job.threadId,
        limit: 20,
        lifecycle: "all",
      });
      for (const note of latest.decisions)
        if (!notes.some((existing) => existing.id === note.id) && notes.length < 20)
          notes.push(note);
    }
    return notes;
  });
  const process = Effect.fn("DecisionWorker.process")(function* (claimed: DecisionJob) {
    let job = claimed;
    let stage = job.stage;
    let continuation =
      stage.continuation === null
        ? initialContinuation
        : yield* decodeContinuation(stage.continuation).pipe(
            Effect.mapError(() => fail("invalid", "Invalid decision continuation.")),
          );
    const binding =
      job.providerBinding === null
        ? yield* writer.capture(job.projectId, job.threadId)
        : yield* decodeBinding(job.providerBinding).pipe(
            Effect.mapError(() => fail("conflict", "The saved writer binding is no longer valid.")),
          );
    yield* writer.validate(binding);
    if (yield* admission.hasForeground(binding.modelSelection.instanceId))
      return yield* fail("unavailable", "provider-foreground");
    const funding = yield* requiredFunding;
    const fence = { jobId: job.id, owner, fence: job.fence };
    const checkpoint = Effect.fn("DecisionWorker.checkpoint")(function* (
      state: "detecting" | "localizing" | "writing",
    ) {
      stage = { ...stage, continuation };
      job = yield* jobs.checkpoint({
        ...fence,
        state,
        stage,
        providerBinding: binding,
        leaseMs: 300000,
      });
    });
    yield* checkpoint(stage.evidence.length ? "writing" : "detecting");
    while (true) {
      if (!(yield* policy.shouldRunDurableWork)) return yield* fail("unavailable", "host-policy");
      yield* writer.validate(binding);
      const sources = yield* jobs.listSources({
        projectId: job.projectId,
        threadId: job.threadId,
        sourceGeneration: job.sourceGeneration,
        fromSequence: job.fromSequence,
        throughSequence: job.throughSequence,
        messageId: job.sourceMessageId,
        contextMessages: stage.contextExpansionCount > 0 ? 8 : 2,
      });
      const primary = sources.find((source) => source.messageId === job.sourceMessageId);
      if (
        !primary ||
        decisionFingerprint([
          job.threadId,
          job.sourceGeneration,
          primary.messageId,
          primary.sourceHash,
          job.configRevision,
          job.description,
        ]) !== job.fingerprint
      )
        return yield* fail("stale-source", "The source changed while Decisions was processing it.");
      const blocks = splitDecisionText(primary.text, 16000);
      if (continuation.blockIndex >= blocks.length) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* writer.validate(binding);
            yield* jobs.finish({
              ...fence,
              state: continuation.matched ? "committed" : "no_match",
              stage: { ...stage, continuation },
            });
          }),
        );
        return;
      }
      if (continuation.blockIndex >= 256)
        return yield* fail("invalid", "The source exceeds the bounded processing range.");
      const block = blocks[continuation.blockIndex]!;
      const supporting = supportEvidence(
        sources,
        primary.messageId,
        stage.contextExpansionCount > 0 ? 14000 : 7000,
      );
      const context = contextText(supporting);
      if (stage.evidence.length === 0 && stage.writerOutput === null) {
        yield* checkpoint("localizing");
        const localized = yield* localizeDecisionSpan(block, (spans) =>
          Effect.gen(function* () {
            yield* writer.validate(binding);
            if (!(yield* policy.shouldRunDurableWork))
              return yield* fail("unavailable", "host-policy");
            if (yield* admission.hasForeground(binding.modelSelection.instanceId))
              return yield* fail("unavailable", "provider-foreground");
            const targets = spans.map((span) => ({
              id: decisionFingerprint([job.sourceMessageId, span.start, span.end]),
              text: span.text,
            }));
            const fingerprint = decisionFingerprint([
              job.fingerprint,
              MODEL,
              TEMPLATE,
              targets,
              context,
            ]);
            let result = yield* jobs.getEvaluation(job.projectId, fingerprint);
            if (!result) {
              const currentFunding = yield* requiredFunding;
              if (currentFunding.generation !== funding.generation)
                return yield* fail("forbidden", "Decision funding changed.");
              let requestId =
                stage.evaluationRequestIds[fingerprint] ??
                decisionFingerprint([job.runId, fingerprint]);
              stage = {
                ...stage,
                evaluationRequestIds: { ...stage.evaluationRequestIds, [fingerprint]: requestId },
              };
              yield* checkpoint("localizing");
              const evaluate = (id: string) =>
                cloud.evaluate({
                  requestId: id,
                  runId: `${job.runId}:${continuation.blockIndex}`,
                  fundingGeneration: funding.generation,
                  targets,
                  context,
                  description: job.description,
                  templateVersion: TEMPLATE,
                  ...(job.reason === "user-retry" ? { explicitRetry: true } : {}),
                });
              result = yield* evaluate(requestId).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    if (cause.code !== "expired" || job.reason !== "user-retry")
                      return yield* cause;
                    // A tombstoned response cannot be replayed. Only an explicit
                    // retry may authorize fresh evaluation, under the same run cap.
                    requestId = decisionFingerprint([
                      job.runId,
                      fingerprint,
                      "expired-retry",
                      job.attempts,
                    ]);
                    stage = {
                      ...stage,
                      evaluationRequestIds: {
                        ...stage.evaluationRequestIds,
                        [fingerprint]: requestId,
                      },
                    };
                    yield* checkpoint("localizing");
                    return yield* evaluate(requestId);
                  }),
                ),
                Effect.mapError((cause) =>
                  ["unavailable", "in-progress", "expired"].includes(cause.code)
                    ? fail("unavailable", "detector-unavailable")
                    : cause,
                ),
              );
              if (
                result.model !== MODEL ||
                result.templateVersion !== TEMPLATE ||
                result.judgments.length !== targets.length ||
                new Set(result.judgments.map((item) => item.targetId)).size !== targets.length
              )
                return yield* fail("invalid", "The detector returned an incompatible result.");
              yield* jobs.putEvaluation(job.projectId, fingerprint, result);
            }
            const ordered = targets.map((target) =>
              result!.judgments.find((judgment) => judgment.targetId === target.id),
            );
            if (ordered.some((item) => item === undefined))
              return yield* fail("invalid", "The detector omitted a requested target.");
            stage = {
              ...stage,
              evaluatedFingerprints: [...new Set([...stage.evaluatedFingerprints, fingerprint])],
            };
            yield* checkpoint("localizing");
            return ordered.filter((item) => item !== undefined);
          }),
        );
        if (localized.spans.length === 0) {
          continuation = {
            ...initialContinuation,
            matched: continuation.matched,
            blockIndex: continuation.blockIndex + 1,
          };
          stage = { ...emptyDecisionJobStage, continuation };
          yield* checkpoint("detecting");
          continue;
        }
        const evidence: DecisionEvidence[] = [...supporting];
        const candidates: Continuation["candidates"][number][] = [];
        for (const span of localized.spans) {
          const pieces = splitDecisionText(span.text, 8000).map((piece) =>
            evidenceFor(primary, {
              text: piece.text,
              start: span.start + piece.start,
              end: span.start + piece.end,
            }),
          );
          evidence.push(...pieces);
          candidates.push({
            id: decisionFingerprint([job.id, continuation.blockIndex, span.start, span.end]),
            evidenceIds: pieces.map((piece) => piece.id),
          });
        }
        continuation = { ...continuation, candidates, matched: true };
        stage = { ...stage, evidence };
        yield* checkpoint("writing");
      }
      const existing = yield* related(job, stage.evidence);
      const input: Omit<DecisionWriterInput, "modelSelection"> = {
        description: job.description,
        descriptionRevision: job.configRevision,
        sourceFingerprint: job.fingerprint,
        candidates: continuation.candidates.filter(
          (candidate) => !stage.resolvedCandidateIds.includes(candidate.id),
        ),
        evidence: stage.evidence,
        context: contextText(
          stage.evidence.filter((anchor) => anchor.messageId !== primary.messageId),
        ),
        existingDecisions: existing.map((note) => ({
          id: note.id,
          revision: note.revision,
          title: note.title,
          body: note.body,
          reviewState: note.reviewState,
          userEdited: note.userEdited,
        })),
        resolvedCandidateIds: stage.resolvedCandidateIds,
      };
      if (input.candidates.length === 0) {
        continuation = {
          ...initialContinuation,
          matched: continuation.matched,
          blockIndex: continuation.blockIndex + 1,
        };
        stage = { ...emptyDecisionJobStage, continuation };
        yield* checkpoint("detecting");
        continue;
      }
      let output = stage.writerOutput;
      let validated: ReadonlyArray<ValidatedAction>;
      if (output === null) {
        const currentFunding = yield* requiredFunding;
        if (currentFunding.generation !== funding.generation)
          return yield* fail("forbidden", "Decision funding changed.");
        if (yield* admission.hasForeground(binding.modelSelection.instanceId))
          return yield* fail("unavailable", "provider-foreground");
        yield* checkpoint("writing");
        const attempt = (feedback?: string) =>
          writer.write(binding, input, feedback).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                if (
                  cause.code === "unavailable" &&
                  (yield* admission.hasForeground(binding.modelSelection.instanceId))
                )
                  return yield* fail("unavailable", "provider-foreground");
                return yield* cause;
              }),
            ),
            Effect.flatMap((raw) => decodeOutput(raw)),
            Effect.flatMap((result) =>
              validateActions(result, input, primary.messageId).pipe(
                Effect.map((actions) => ({ result, actions })),
              ),
            ),
          );
        const first = yield* attempt().pipe(Effect.result);
        if (first._tag === "Success") {
          output = first.success.result;
          validated = first.success.actions;
        } else {
          // Schema and evidence failures get one same-provider repair; auth/availability never loop.
          if ("code" in first.failure && first.failure.code !== "invalid")
            return yield* first.failure;
          const repaired = yield* attempt(
            "Return valid structured output. Cite only supplied IDs and exact unambiguous quotes; account for every candidate and use the required speaker evidence.",
          );
          output = repaired.result;
          validated = repaired.actions;
        }
        stage = { ...stage, writerOutput: output };
        yield* checkpoint("writing");
      } else validated = yield* validateActions(output, input, primary.messageId);
      const hasNeedsContext = output.actions.some((action) => action.action === "needs_context");
      const newKeys = validated
        .map((action) => action.key)
        .filter((key) => !continuation.actionKeys.includes(key));
      const resolvedIds = output.actions
        .filter(
          (action) =>
            action.action !== "needs_context" &&
            !output!.unresolvedCandidateIds.includes(action.candidateId),
        )
        .map((action) => action.candidateId);
      const nextResolved = [...new Set([...stage.resolvedCandidateIds, ...resolvedIds])];
      const progressed =
        newKeys.length > 0 || nextResolved.length > stage.resolvedCandidateIds.length;
      const currentFunding = yield* cloud.fundingStatus;
      if (currentFunding.state !== "active" || currentFunding.generation !== funding.generation)
        return yield* fail("forbidden", "Decision funding was revoked or replaced.");
      const committed = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* writer.validate(binding);
          // Fence before writes and again at commit; nested repository transactions use savepoints.
          yield* jobs.checkpoint({
            ...fence,
            state: "writing",
            stage,
            providerBinding: binding,
            leaseMs: 300000,
          });
          const currentNotes = new Map<string, ThreadDecision>();
          for (const item of validated) {
            if (continuation.actionKeys.includes(item.key)) continue;
            const action = item.action;
            if (action.action === "create" || action.action === "propose_replacement") {
              const id = DecisionId.make(decisionFingerprint([job.id, item.key]));
              const note = yield* repository.createFromWriter({
                id,
                projectId: job.projectId,
                threadId: job.threadId,
                actionKey: `${job.id}:${item.key}`,
                title: action.title,
                body: action.body,
                rationale: action.rationale,
                attribution: action.attribution,
                occurredAt: primary.createdAt,
                occurrence: primary.sourceSequence,
                evidence: item.evidence,
                provenance: {
                  descriptionRevision: job.configRevision,
                  sourceFingerprint: job.fingerprint,
                  canonicalVersion: "1",
                  templateVersion: TEMPLATE,
                  detectorModel: MODEL,
                  writerSelection: binding.modelSelection,
                  writerConfigurationGeneration: binding.fingerprint,
                  identityConfidence: "configuration-only",
                },
              });
              if (note && action.action === "propose_replacement") {
                const predecessor =
                  currentNotes.get(action.predecessorId) ??
                  (yield* repository.get({ projectId: job.projectId, id: action.predecessorId }));
                if (
                  !currentNotes.has(action.predecessorId) &&
                  predecessor.revision !== action.expectedRevision
                )
                  return yield* fail(
                    "conflict",
                    "A related decision changed while the writer ran.",
                  );
                yield* repository.mutate({
                  operation: "propose-replacement",
                  projectId: job.projectId,
                  predecessorId: predecessor.id,
                  successorId: note.id,
                  expectedPredecessorRevision: predecessor.revision,
                  expectedSuccessorRevision: note.revision,
                });
                currentNotes.set(
                  predecessor.id,
                  yield* repository.get({ projectId: job.projectId, id: predecessor.id }),
                );
              }
            } else if (action.action === "duplicate") {
              const prior =
                currentNotes.get(action.existingId) ??
                (yield* repository.get({ projectId: job.projectId, id: action.existingId }));
              if (
                !currentNotes.has(action.existingId) &&
                prior.revision !== action.expectedRevision
              )
                return yield* fail("conflict", "A related decision changed while the writer ran.");
              currentNotes.set(
                prior.id,
                yield* repository.addEvidence({
                  projectId: job.projectId,
                  id: prior.id,
                  expectedRevision: prior.revision,
                  evidence: item.evidence,
                }),
              );
            }
          }
          const nextContinuation: Continuation = {
            ...continuation,
            actionKeys: [...new Set([...continuation.actionKeys, ...newKeys])],
            stalled: progressed ? 0 : continuation.stalled + 1,
          };
          const nextStage: DecisionJobStage = {
            ...stage,
            writerOutput: null,
            resolvedCandidateIds: nextResolved,
            continuationCount: stage.continuationCount + 1,
            continuation: nextContinuation,
          };
          yield* jobs.checkpoint({
            ...fence,
            state: "writing",
            stage: nextStage,
            providerBinding: binding,
            leaseMs: 300000,
          });
          return { stage: nextStage, continuation: nextContinuation };
        }),
      );
      stage = committed.stage;
      continuation = committed.continuation;
      if (hasNeedsContext) {
        if (stage.contextExpansionCount >= 1) {
          yield* jobs.finish({ ...fence, state: "incomplete", stage, reason: "needs-context" });
          return;
        }
        stage = { ...stage, evidence: [], writerOutput: null, contextExpansionCount: 1 };
        yield* checkpoint("localizing");
      } else if (continuation.stalled >= 2 || stage.continuationCount >= 24) {
        yield* jobs.finish({ ...fence, state: "incomplete", stage, reason: "writer-progress" });
        return;
      }
    }
  });
  const drive = mutex.withPermits(1)(
    Effect.gen(function* () {
      const reconciled = yield* Effect.gen(function* () {
        const funding = yield* cloud.fundingStatus;
        const projects = yield* sql<{
          project_id: string;
        }>`SELECT settings.project_id FROM decision_project_settings settings JOIN projection_projects project ON project.project_id = settings.project_id AND project.deleted_at IS NULL`;
        for (const project of projects)
          yield* settings.setFunding(
            ProjectId.make(project.project_id),
            funding.state,
            funding.accountLabel,
            funding.generation,
          );
      }).pipe(Effect.result);
      if (reconciled._tag === "Failure") return;
      while (yield* policy.shouldRunDurableWork) {
        const job = yield* jobs
          .claim({ owner, leaseMs: 300000 })
          .pipe(Effect.orElseSucceed(() => null));
        if (!job) return;
        yield* process(job).pipe(
          Effect.catch((cause) => {
            const code = "code" in cause ? cause.code : "invalid";
            const special =
              "message" in cause &&
              (cause.message === "provider-foreground" ||
                cause.message === "host-policy" ||
                cause.message === "detector-unavailable")
                ? cause.message
                : null;
            const reason =
              special ??
              (code === "unsupported"
                ? "provider-unsupported"
                : code === "forbidden"
                  ? "unfunded"
                  : code === "allowance-exhausted"
                    ? "allowance-exhausted"
                    : code === "run-budget-exhausted"
                      ? "budget"
                      : code === "conflict"
                        ? "provider-changed"
                        : code === "stale-source"
                          ? "source-changed"
                          : code === "invalid"
                            ? "error"
                            : "provider-unavailable");
            return jobs
              .finish({
                jobId: job.id,
                owner,
                fence: job.fence,
                state:
                  reason === "budget" ? "incomplete" : reason === "error" ? "failed" : "waiting",
                reason,
              })
              .pipe(Effect.ignore);
          }),
        );
      }
    }),
  );
  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    yield* Effect.addFinalizer(() => Ref.set(started, false));
    const wakes = yield* jobs.subscribeWake;
    const leaseChanges = yield* jobs.subscribeWake;
    const host = yield* policy.subscribe;
    const fundingChanges = yield* cloud.subscribeFundingChanges;
    const providerChanges = yield* providers.subscribeChanges;
    const instanceChanges = yield* instances.subscribeChanges;
    const recoverProvider = jobs
      .wakeWaiting("provider-unsupported")
      .pipe(
        Effect.andThen(jobs.wakeWaiting("provider-unavailable")),
        Effect.andThen(drive),
        Effect.ignore,
      );
    const recoverFunding = jobs
      .wakeWaiting("unfunded")
      .pipe(
        Effect.andThen(jobs.wakeWaiting("allowance-exhausted")),
        Effect.andThen(drive),
        Effect.ignore,
      );
    yield* Effect.forkScoped(Stream.runForEach(wakes, () => drive));
    yield* Effect.forkScoped(
      leaseChanges.pipe(
        Stream.switchMap(() =>
          Stream.fromEffect(
            jobs.nextLeaseDelay.pipe(
              Effect.orElseSucceed(() => null),
              Effect.flatMap((delay) => (delay === null ? Effect.never : Effect.sleep(delay))),
              Effect.andThen(jobs.notify),
            ),
          ),
        ),
        Stream.runDrain,
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(host.changes, () =>
        jobs.wakeWaiting("host-policy").pipe(Effect.andThen(drive), Effect.ignore),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(admission.changes, () =>
        jobs.wakeWaiting("provider-foreground").pipe(Effect.andThen(drive), Effect.ignore),
      ),
    );
    yield* Effect.forkScoped(Stream.runForEach(fundingChanges, () => recoverFunding));
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromSubscription(instanceChanges), () => recoverProvider),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.concat(Stream.fromEffect(providers.getProviders), providerChanges).pipe(
          Stream.map((snapshots) =>
            decisionFingerprint(
              snapshots.map((snapshot) => [
                snapshot.instanceId,
                snapshot.enabled,
                snapshot.installed,
                snapshot.version,
                snapshot.status,
                snapshot.auth,
              ]),
            ),
          ),
          Stream.changes,
        ),
        () => recoverProvider,
      ),
    );
    // Startup reconciles access once; subsequent recovery follows authoritative
    // changes from the bounded cloud maintenance refresh, not job polling.
    const funding = yield* cloud.fundingStatus;
    if (funding.state === "active" && funding.eligible) yield* recoverFunding;
    yield* jobs.notify;
  });
  return DecisionWorker.of({ drive, start, notify: jobs.notify });
});
export const layer = Layer.effect(DecisionWorker, make);
