import { assert, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import * as C from "@lecturn/contracts";
import {
  EnvironmentId,
  DecisionId,
  DecisionEvidenceId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@lecturn/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { decisionSourceHash } from "@lecturn/shared/decisionEvidence";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  DecisionRepository,
  make as makeRepository,
  type CreateDecisionFromWriter,
} from "./DecisionRepository.ts";
import { ExtensionsCloudClient } from "../extensions/ExtensionsCloudClient.ts";
import { completeCoverage } from "../contextual/DecisionCandidates.ts";
import { make } from "./DecisionRelations.ts";
import { ContextualGroups, make as makeGroups } from "../contextual/ContextualGroups.ts";
import { ExtensionsRuntime } from "../extensions/ExtensionsRuntime.ts";
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const input: CreateDecisionFromWriter = {
  id: DecisionId.make("decision"),
  projectId,
  threadId,
  actionKey: "action",
  title: "Use Postgres",
  body: "Use Postgres for storage.",
  rationale: "Transactions",
  attribution: "user-directed",
  occurredAt: "2026-09-23",
  occurrence: 1,
  evidence: [
    {
      id: DecisionEvidenceId.make("evidence"),
      threadId,
      messageId: MessageId.make("message"),
      messageRole: "user",
      sourceHash: decisionSourceHash("Use Postgres for storage."),
      sourceGeneration: 0,
      canonicalVersion: "1",
      quote: "Use Postgres",
      start: 0,
      end: 12,
      prefix: "",
      suffix: " for storage.",
      occurrence: 1,
      availability: "available",
    },
  ],
  provenance: {
    descriptionRevision: 1,
    sourceFingerprint: "fingerprint",
    canonicalVersion: "1",
    templateVersion: "1",
    detectorModel: "extensions-v1",
    writerSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" },
    writerConfigurationGeneration: "1",
    identityConfidence: "configuration-only",
  },
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "contextual_actions",
    "decision_relation_queue",
    "decision_relation_suggestions",
    "contextual_lineage",
    "contextual_suppression",
    "contextual_group_members",
    "contextual_decision_groups",
    "decision_suppression",
    "decision_relationships",
    "decision_evidence",
    "thread_decisions",
    "decision_sources",
    "decision_thread_state",
    "decision_outbox",
    "decision_project_settings",
    "projection_thread_messages",
    "projection_threads",
    "projection_projects",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/tmp/decisions','[]','now','now'), ('other','Other','/tmp/other','[]','now','now')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,runtime_mode,interaction_mode) VALUES ('thread','project','Saved thread title','{}','now','now','full-access','default')`;
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('message','thread','user','Use Postgres for storage.',0,'now','now')`;
  yield* sql`INSERT INTO decision_thread_state(thread_id,project_id,source_generation,updated_at) VALUES ('thread','project',0,'now')`;
  yield* sql`INSERT INTO decision_sources(thread_id,message_id,source_generation,project_id,source_hash,source_sequence,role,created_at) VALUES ('thread','message',0,'project',${input.evidence[0]!.sourceHash},1,'user','now')`;
  const service = yield* makeRepository.pipe(
    Effect.provideService(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-environment")),
    }),
  );
  return { sql, service };
});

const allowance: C.ExtensionAllowance = {
  poolId: "pool",
  basis: "grant",
  windowStart: "2026-09-01T00:00:00Z",
  windowEnd: "2026-10-01T00:00:00Z",
  limitInputTokens: 1000,
  usedInputTokens: 0,
  reservedInputTokens: 0,
  remainingInputTokens: 1000,
  byFeature: [],
};
const relationsFixture = Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.service.createFromWriter(input);
  yield* f.sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('other-message','thread','assistant','Use Postgres for storage.',0,'now','now')`;
  yield* f.sql`INSERT INTO decision_sources(thread_id,message_id,source_generation,project_id,source_hash,source_sequence,role,created_at) VALUES ('thread','other-message',0,'project',${input.evidence[0]!.sourceHash},2,'assistant','now')`;
  yield* f.service.createFromWriter({
    ...input,
    id: DecisionId.make("other-decision"),
    actionKey: "other-action",
    attribution: "agent-chosen",
    evidence: input.evidence.map((e) => ({
      ...e,
      id: DecisionEvidenceId.make("other-evidence"),
      messageId: MessageId.make("other-message"),
      messageRole: "assistant" as const,
    })),
  });
  yield* f.sql`INSERT INTO decision_project_settings(project_id,enabled,description,revision,cancellation_epoch,updated_at) VALUES(${projectId},1,'Track commitments',1,0,'now')`;
  let calls = 0;
  let eligible = true;
  let conflict = true;
  let fail = false;
  let qualified = false;
  let model = "extensions-v1";
  let equal = (_: C.ContextualEquivalenceTarget) => true;
  let afterEvaluation = Effect.void;
  const groups = yield* makeGroups.pipe(
    Effect.provideService(DecisionRepository, f.service),
    Effect.provide(
      Layer.mock(ExtensionsRuntime)({
        environmentId: EnvironmentId.make("fixture-environment"),
        hostName: "Synthetic",
      }),
    ),
  );
  const relations = yield* make.pipe(
    Effect.provideService(DecisionRepository, f.service),
    Effect.provideService(ContextualGroups, groups),
    Effect.provideService(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-environment")),
    }),
    Effect.provide(
      Layer.mock(ExtensionsCloudClient)({
        status: () =>
          Effect.sync(() => ({
            featureId: "decisions" as const,
            environmentId: EnvironmentId.make("fixture-environment"),
            state: "active" as const,
            generation: 1,
            accountLabel: "Synthetic",
            eligible,
            reason: "eligible" as const,
            allowance,
            remoteRevocationPending: false,
          })),
        conflicts: (request) =>
          Effect.suspend(() => {
            calls++;
            if (fail)
              return Effect.fail(
                new C.ContextualError({ code: "unavailable", message: "offline" }),
              );
            return Effect.succeed({
              requestId: request.requestId,
              runId: request.runId,
              policyVersion: "contextual-v1" as const,
              model: "extensions-v1",
              judgments: request.pairs.map((p) => ({
                pairId: p.id,
                relation: conflict ? ("incompatible" as const) : ("compatible" as const),
                materialToTask: 0,
                leftEvidenceIds: p.left.evidence.map((e) => e.id),
                rightEvidenceIds: p.right.evidence.map((e) => e.id),
                reasons: ["conflict" as const],
              })),
              coverage: completeCoverage,
              inputTokens: 1,
              allowance,
              replayed: false,
            });
          }),
        equivalence: (request) =>
          Effect.gen(function* () {
            calls++;
            yield* afterEvaluation;
            return {
              requestId: request.requestId,
              runId: request.runId,
              policyVersion: "decisions-equivalence-v1" as const,
              model,
              ...(qualified ? { qualificationId: "synthetic-qualified-fixture" } : {}),
              judgments: request.targets.map((t) => ({
                targetId: t.id,
                equivalentCommitment: equal(t) ? 1 : 0,
                sameApplicability: 1,
                sufficientEvidence: 1,
                relation: equal(t) ? ("equivalent" as const) : ("different-commitment" as const),
              })),
              inputTokens: 1,
              allowance,
              replayed: false,
            };
          }),
      }),
    ),
  );
  return {
    ...f,
    relations,
    groups,
    qualify: () => {
      qualified = true;
    },
    setModel: (value: string) => {
      model = value;
    },
    setEquivalent: (value: typeof equal) => {
      equal = value;
    },
    afterEvaluation: (effect: typeof Effect.void) => {
      afterEvaluation = effect;
    },
    calls: () => calls,
    setEligible: (v: boolean) => {
      eligible = v;
    },
    setConflict: (v: boolean) => {
      conflict = v;
    },
    setFailure: () => {
      fail = true;
    },
  };
});
it.layer(SqlitePersistenceMemory)("Decision intake relationships", (it) => {
  it.effect(
    "saves a revision-bound suggestion without changing note authority and invalidates it after an edit",
    () =>
      Effect.gen(function* () {
        const f = yield* relationsFixture;
        yield* f.relations.drive;
        const note = yield* f.service.get({ projectId, id: input.id });
        assert.equal(note.body, input.body);
        assert.equal(note.lifecycle, "current");
        assert.equal(note.relationSuggestions?.[0]?.kind, "conflict");
        assert.equal(f.calls(), 2);
        const suggestion = note.relationSuggestions![0]!;
        yield* f.service.mutate({
          operation: "resolve-suggestion",
          projectId,
          id: note.id,
          expectedRevision: note.revision,
          suggestionId: suggestion.id,
          expectedOtherRevision: suggestion.otherRevision,
          action: "ignore",
        });
        assert.equal(
          (yield* f.service.get({ projectId, id: note.id })).relationSuggestions?.[0]?.state,
          "ignored",
        );
        yield* f.service.mutate({
          operation: "edit",
          projectId,
          id: note.id,
          expectedRevision: note.revision,
          title: note.title,
          body: "Revised choice",
          rationale: null,
        });
        assert.equal(
          (yield* f.service.get({ projectId, id: note.id })).relationSuggestions?.length,
          0,
        );
        assert.isTrue(
          Result.isFailure(
            yield* f.service
              .mutate({
                operation: "resolve-suggestion",
                projectId,
                id: note.id,
                expectedRevision: note.revision,
                suggestionId: suggestion.id,
                expectedOtherRevision: suggestion.otherRevision,
                action: "propose-replacement",
              })
              .pipe(Effect.result),
          ),
        );
      }),
  );
  it.effect(
    "requires Decisions eligibility and does not automatically merge equivalent notes",
    () =>
      Effect.gen(function* () {
        const f = yield* relationsFixture;
        f.setEligible(false);
        yield* f.relations.drive;
        assert.equal(f.calls(), 0);
        f.setEligible(true);
        f.setConflict(false);
        yield* f.relations.drive;
        const note = yield* f.service.get({ projectId, id: input.id });
        assert.equal(note.relationSuggestions?.[0]?.kind, "equivalent");
        assert.isUndefined(note.consolidation);
        assert.equal((yield* f.service.list({ projectId })).decisions.length, 2);
      }),
  );
  it.effect("does not redispatch a durable unknown admission", () =>
    Effect.gen(function* () {
      const f = yield* relationsFixture;
      yield* f.sql`UPDATE decision_relation_queue SET state='dispatching'`;
      yield* f.relations.drive;
      assert.equal(f.calls(), 0);
    }),
  );
  it.effect(
    "qualified exact pairs consolidate reversibly without promoting occurrence metadata",
    () =>
      Effect.gen(function* () {
        const f = yield* relationsFixture;
        f.qualify();
        f.setConflict(false);
        const before = yield* f.service.get({ projectId, id: DecisionId.make("other-decision") });
        yield* f.relations.drive;
        const group = yield* f.groups.group({ projectId, groupId: input.id, limit: 50 });
        assert.equal(group.occurrenceCount, 2);
        assert.equal(group.canonicalDecisionId, input.id);
        const linked = group.occurrences.find((o) => o.decisionId === before.id)!;
        assert.equal(linked.attribution, "agent-chosen");
        assert.equal(linked.reviewState, before.reviewState);
        assert.equal(linked.body, before.body);
        assert.deepEqual(linked.provenance, before.provenance);
        assert.deepEqual(
          linked.evidenceIds,
          before.evidence.map((e) => e.id),
        );
        const merges = yield* f.sql<{
          merge_id: string;
        }>`SELECT merge_id FROM contextual_group_members WHERE decision_id=${before.id}`;
        assert.isTrue(merges[0]!.merge_id.startsWith("automatic:"));
        yield* f.groups.undoGroup({
          actionId: "undo-automatic",
          groupId: group.id,
          mergeId: merges[0]!.merge_id,
          expectedRevision: group.revision,
          expectedOccurrenceRevision: before.revision,
        });
        assert.equal(
          (yield* f.groups.group({ projectId, groupId: input.id, limit: 50 })).occurrenceCount,
          1,
        );
        const restored = yield* f.service.get({ projectId, id: before.id });
        assert.equal(restored.attribution, before.attribution);
        assert.deepEqual(restored.evidence, before.evidence);
        assert.equal(restored.revision, before.revision);
      }),
  );
  for (const reason of [
    "conflict",
    "unknown-conflict",
    "model",
    "edited",
    "revision",
    "dismissed",
    "shared-origin",
    "alias",
  ] as const) {
    it.effect(`qualified consolidation refuses ${reason}`, () =>
      Effect.gen(function* () {
        const f = yield* relationsFixture;
        f.qualify();
        f.setConflict(reason === "conflict");
        if (reason === "unknown-conflict") f.setFailure();
        if (reason === "model") f.setModel("changed-model");
        if (reason === "edited")
          yield* f.sql`UPDATE thread_decisions SET user_edited=1 WHERE id='other-decision'`;
        if (reason === "revision" || reason === "dismissed")
          f.afterEvaluation(
            (reason === "revision"
              ? f.sql`UPDATE thread_decisions SET revision=revision+1 WHERE id='other-decision'`
              : f.sql`UPDATE thread_decisions SET review_state='dismissed' WHERE id='decision'`
            ).pipe(Effect.asVoid, Effect.orDie),
          );
        if (reason === "shared-origin")
          yield* f.sql`UPDATE decision_evidence SET message_id='message' WHERE decision_id='other-decision'`;
        if (reason === "alias") {
          yield* f.sql`INSERT INTO contextual_decision_groups(id,project_id,canonical_decision_id,revision,updated_at) VALUES('existing',${projectId},'uncompared-canonical',0,'now')`;
          yield* f.sql`INSERT INTO contextual_group_members(decision_id,group_id,occurrence_revision,merge_id) VALUES('decision','existing',0,'original')`;
        }
        yield* f.relations.drive;
        assert.equal(
          (yield* f.sql`SELECT 1 FROM contextual_group_members WHERE merge_id LIKE 'automatic:%'`)
            .length,
          0,
        );
      }),
    );
  }
  it.effect(
    "A-B and B-C equivalence never implies A-C, but a direct canonical comparison can join C",
    () =>
      Effect.gen(function* () {
        const f = yield* relationsFixture;
        f.qualify();
        f.setConflict(false);
        yield* f.relations.drive;
        yield* f.sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('third-message','thread','user','Use Postgres for storage.',0,'now','now')`;
        yield* f.sql`INSERT INTO decision_sources(thread_id,message_id,source_generation,project_id,source_hash,source_sequence,role,created_at) VALUES ('thread','third-message',0,'project',${input.evidence[0]!.sourceHash},3,'user','now')`;
        const third = DecisionId.make("third-decision");
        yield* f.service.createFromWriter({
          ...input,
          id: third,
          actionKey: "third-action",
          evidence: input.evidence.map((e) => ({
            ...e,
            id: DecisionEvidenceId.make("third-evidence"),
            messageId: MessageId.make("third-message"),
          })),
        });
        f.setEquivalent(
          (target) => ![target.left.decisionId, target.right.decisionId].includes(input.id),
        );
        yield* f.relations.drive;
        yield* f.relations.drive;
        assert.equal(
          (yield* f.groups.group({ projectId, groupId: input.id, limit: 50 })).occurrenceCount,
          2,
        );
        assert.equal(
          (yield* f.sql`SELECT 1 FROM contextual_group_members WHERE decision_id=${third}`).length,
          0,
        );
        const thirdNote = yield* f.service.get({ projectId, id: third });
        yield* f.service.mutate({
          operation: "review",
          projectId,
          id: third,
          expectedRevision: thirdNote.revision,
          reviewState: "confirmed",
        });
        f.setEquivalent(() => true);
        yield* f.relations.drive;
        assert.equal(
          (yield* f.groups.group({ projectId, groupId: input.id, limit: 50 })).occurrenceCount,
          3,
        );
      }),
  );
});
