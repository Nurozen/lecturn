import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  EnvironmentId,
  DecisionId,
  DecisionEvidenceId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type ContextualTaskSnapshot,
  type ContextualDecisionCandidate,
  type ContextualSlackCandidate,
  type ContextualPacketGroup,
} from "@lecturn/contracts";
import { decisionSourceHash } from "@lecturn/shared/decisionEvidence";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  make as makeRepository,
  DecisionRepository,
  type CreateDecisionFromWriter,
} from "../threadDecisions/DecisionRepository.ts";
import {
  make,
  decisionCandidate,
  deduplicateCandidates,
  completeCoverage,
} from "./DecisionCandidates.ts";
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
  const adapter = yield* make.pipe(
    Effect.provideService(DecisionRepository, service),
    Effect.provideService(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-environment")),
    }),
  );
  return { sql, service, adapter };
});

const task: ContextualTaskSnapshot = {
  environmentId: EnvironmentId.make("fixture-environment"),
  projectId,
  threadId: ThreadId.make("active"),
  submissionId: "submission",
  messageId: MessageId.make("new"),
  turnId: null,
  providerInstanceId: "provider",
  providerContextEpoch: "epoch",
  taskFingerprint: "task",
  knownContextFingerprint: "known",
  threadSettingsRevision: 0,
  projectSettingsRevision: 0,
  sourceScopeRevision: 0,
  threadExclusionRevision: 0,
  fundingGeneration: 0,
  purgeGeneration: 0,
  newestMessage: "Build storage with Postgres",
  projectDescription: "",
  explicitReferences: [],
  recentContext: "",
  trigger: "submission",
};
const group = (value: ContextualDecisionCandidate): ContextualPacketGroup => ({
  candidateId: value.id,
  occurrenceId: value.occurrenceId,
  guidanceId: value.guidanceId,
  contentFingerprint: value.contentFingerprint,
  recordRevision: value.recordRevision,
  evidence: value.evidence,
  attribution: value.attribution,
  derivedSummary: value.derivedSummary.body,
  reasons: ["decision"],
});

it.layer(SqlitePersistenceMemory)("Contextual Decision candidates", (it) => {
  it.effect("reads authoritative scope, exclusions, lifecycle and replacement changes", () =>
    Effect.gen(function* () {
      const { service, adapter } = yield* fixture;
      yield* service.createFromWriter(input);
      const values = yield* adapter.retrieve(task);
      assert.equal(values.length, 1);
      assert.isTrue(yield* adapter.revalidateGroup(group(values[0]!), task));
      assert.equal(
        (yield* adapter.retrieve({ ...task, environmentId: EnvironmentId.make("foreign") })).length,
        0,
      );
      assert.equal(
        (yield* adapter.retrieve({ ...task, projectId: ProjectId.make("other") })).length,
        0,
      );
      assert.equal((yield* adapter.retrieve({ ...task, threadId })).length, 0);
      assert.equal((yield* adapter.retrieve({ ...task, threadId, trigger: "refresh" })).length, 1);
      const next = DecisionId.make("next");
      yield* service.createFromWriter({ ...input, id: next, actionKey: "next" });
      yield* service.mutate({
        operation: "propose-replacement",
        projectId,
        predecessorId: input.id,
        successorId: next,
        expectedPredecessorRevision: 1,
        expectedSuccessorRevision: 1,
      });
      assert.isFalse(yield* adapter.revalidateGroup(group(values[0]!), task));
      assert.deepEqual(
        (yield* adapter.retrieve(task)).map((v) => v.decisionId),
        [next],
      );
      assert.equal((yield* adapter.retrieve(task, true)).length, 2);
      yield* service.mutate({
        operation: "review",
        projectId,
        id: next,
        expectedRevision: 2,
        reviewState: "dismissed",
      });
      assert.equal((yield* adapter.retrieve(task)).length, 0);
    }),
  );
  it.effect(
    "keeps exact UTF16 source spans and invalidates missing-message generation changes",
    () =>
      Effect.gen(function* () {
        const { sql, service, adapter } = yield* fixture;
        const text = "🦀 Use Postgres";
        yield* sql`UPDATE projection_thread_messages SET text=${text}`;
        yield* sql`UPDATE decision_sources SET source_hash=${decisionSourceHash(text)}`;
        yield* service.createFromWriter({
          ...input,
          evidence: [
            {
              ...input.evidence[0]!,
              sourceHash: decisionSourceHash(text),
              quote: "Use Postgres",
              start: 3,
              end: 15,
              prefix: "🦀 ",
              suffix: "",
            },
          ],
        });
        const value = (yield* adapter.retrieve(task))[0]!;
        assert.equal(value.evidence[0]!.start, 3);
        assert.equal(value.evidence[0]!.end, 15);
        assert.isTrue(yield* adapter.revalidateGroup(group(value), task));
        yield* sql`DELETE FROM projection_thread_messages`;
        const stored = (yield* adapter.retrieve(task))[0]!;
        assert.equal(stored.evidence[0]!.availability, "stored-only");
        assert.isTrue(yield* adapter.revalidateGroup(group(stored), task));
        yield* sql`UPDATE decision_thread_state SET source_generation=1`;
        assert.equal((yield* adapter.retrieve(task)).length, 0);
        assert.isFalse(yield* adapter.revalidateGroup(group(stored), task));
      }),
  );
  it.effect(
    "requires proposal then acceptance and revalidates the complete original exchange",
    () =>
      Effect.gen(function* () {
        const { sql, service, adapter } = yield* fixture;
        yield* sql`UPDATE projection_thread_messages SET role='assistant'`;
        yield* sql`UPDATE decision_sources SET role='assistant'`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('accept','thread','user','Yes, use Postgres.',0,'now','now')`;
        yield* sql`INSERT INTO decision_sources(thread_id,message_id,source_generation,project_id,source_hash,source_sequence,role,created_at) VALUES ('thread','accept',0,'project',${decisionSourceHash("Yes, use Postgres.")},2,'user','now')`;
        const proposal = { ...input.evidence[0]!, messageRole: "assistant" as const };
        const acceptance = {
          ...input.evidence[0]!,
          id: DecisionEvidenceId.make("accept-e"),
          messageId: MessageId.make("accept"),
          sourceHash: decisionSourceHash("Yes, use Postgres."),
          quote: "Yes, use Postgres.",
          start: 0,
          end: 18,
          prefix: "",
          suffix: "",
          occurrence: 2,
        };
        const note = yield* service.createFromWriter({
          ...input,
          attribution: "user-accepted",
          evidence: [proposal, acceptance],
        });
        const value = (yield* adapter.retrieve(task))[0]!;
        assert.isTrue(value.coverage.complete);
        assert.isTrue(yield* adapter.revalidateGroup(group(value), task));
        assert.isFalse(
          yield* adapter.revalidateGroup({ ...group(value), evidence: [value.evidence[1]!] }, task),
        );
        assert.isFalse(
          decisionCandidate({ ...note!, evidence: [acceptance] }, task)!.coverage.complete,
        );
        assert.isFalse(
          decisionCandidate(
            { ...note!, evidence: [proposal, { ...acceptance, occurrence: 0 }] },
            task,
          )!.coverage.complete,
        );
      }),
  );
  it.effect(
    "propagates source and original-evidence suppression without deleting saved notes",
    () =>
      Effect.gen(function* () {
        const { sql, service, adapter } = yield* fixture;
        yield* service.createFromWriter(input);
        yield* sql`INSERT INTO contextual_lineage VALUES ('slack-source','original','decision','decision')`;
        const value = (yield* adapter.retrieve(task))[0]!;
        assert.deepEqual(value.lineageIds, ["original"]);
        yield* sql`INSERT INTO contextual_suppression VALUES ('source','slack-source',1)`;
        assert.equal((yield* adapter.retrieve(task)).length, 0);
        assert.isFalse(yield* adapter.revalidateGroup(group(value), task));
        assert.equal((yield* service.get({ projectId, id: input.id })).body, input.body);
        yield* sql`DELETE FROM contextual_suppression`;
        yield* sql`INSERT INTO contextual_suppression VALUES ('evidence','original',2)`;
        assert.equal((yield* adapter.retrieve(task)).length, 0);
        yield* sql`DELETE FROM contextual_suppression`;
        yield* sql`INSERT INTO contextual_suppression VALUES ('evidence',${value.evidence[0]!.id},3)`;
        assert.equal((yield* adapter.retrieve(task)).length, 0);
      }),
  );
  it.effect(
    "resolves exact old IDs beyond recent results and uses only revision-current group identities",
    () =>
      Effect.gen(function* () {
        const { sql, service, adapter } = yield* fixture;
        yield* service.createFromWriter(input);
        yield* sql`UPDATE thread_decisions SET title='Archive choice', body='Original commitment', rationale=NULL, occurred_at='2020-01-01'`;
        for (let i = 0; i < 8; i++)
          yield* service.createFromWriter({
            ...input,
            id: DecisionId.make("recent-" + i),
            actionKey: "recent-" + i,
            occurredAt: "2026-09-23",
            title: "Unrelated",
            body: "Nothing related",
            rationale: null,
          });
        const values = yield* adapter.retrieve({
          ...task,
          newestMessage: "hello",
          explicitReferences: ["decision:decision"],
        });
        assert.isTrue(values.some((v) => v.decisionId === input.id));
        assert.isAtMost(values.length, 24);
        yield* sql`INSERT INTO contextual_group_members VALUES ('decision','group',1,'merge')`;
        const value = yield* adapter.candidate(
          yield* service.get({ projectId, id: input.id }),
          task,
        );
        assert.equal(value!.guidanceId, "group:group");
        yield* service.mutate({
          operation: "edit",
          projectId,
          id: input.id,
          expectedRevision: 1,
          title: "Changed",
          body: "Changed commitment",
          rationale: null,
        });
        const changed = yield* adapter.candidate(
          yield* service.get({ projectId, id: input.id }),
          task,
        );
        assert.equal(changed!.guidanceId, "decision:decision");
        assert.isFalse(yield* adapter.revalidateGroup(group(value!), task));
      }),
  );
  it.effect(
    "deduplicates exact original evidence without treating lineage as equivalent quotation",
    () =>
      Effect.gen(function* () {
        const { service, adapter } = yield* fixture;
        yield* service.createFromWriter(input);
        const first = (yield* adapter.retrieve(task))[0]!;
        const copy = {
          ...first,
          id: "copy",
          guidanceId: "copy",
          lineageIds: [first.evidence[0]!.id],
          evidence: first.evidence.map((e) => ({ ...e, id: "copy-e", sourceHash: "different" })),
        };
        assert.equal(
          deduplicateCandidates([first, { ...first, id: "exact", guidanceId: "exact" }]).length,
          1,
        );
        assert.equal(deduplicateCandidates([first, copy]).length, 2);
        assert.equal(deduplicateCandidates([copy, first]).length, 2);
        const independent = {
          ...first,
          id: "independent",
          guidanceId: "independent",
          evidence: first.evidence.map((e) => ({
            ...e,
            id: "independent-e",
            locator: { ...e.locator, messageId: MessageId.make("independent") },
          })),
        };
        assert.equal(deduplicateCandidates([first, independent]).length, 2);
        const linkedDifferentQuote = {
          ...copy,
          evidence: copy.evidence.map((e) => ({ ...e, quote: "Yes, do that", end: 12 })),
        };
        assert.equal(deduplicateCandidates([first, linkedDifferentQuote]).length, 2);
        assert.equal(deduplicateCandidates([linkedDifferentQuote, first]).length, 2);
        const partialOverlap = { ...copy, evidence: [...copy.evidence, ...independent.evidence] };
        assert.equal(deduplicateCandidates([first, partialOverlap]).length, 2);
        const incomplete = {
          ...linkedDifferentQuote,
          coverage: { ...completeCoverage, complete: false, missingAntecedents: true },
        };
        assert.deepEqual(deduplicateCandidates([incomplete, first]), [first]);
        const slack: ContextualSlackCandidate = {
          ...first,
          id: "slack-exchange",
          guidanceId: "slack-exchange",
          sourceKind: "slack",
          sourceId: "slack-source",
          workspaceId: "workspace",
          channelId: "channel",
          messageTs: "1.1",
          threadTs: null,
          coverage: { ...completeCoverage, complete: false },
          evidence: first.evidence.map((e) => ({
            ...e,
            sourceKind: "slack",
            sourceId: "slack-source",
            locator: {
              sourceKind: "slack",
              workspaceId: "workspace",
              channelId: "channel",
              messageTs: "1.1",
              threadTs: null,
            },
          })),
        };
        assert.deepEqual(deduplicateCandidates([incomplete, slack]), [slack]);
      }),
  );
  it.effect("caps the union of separate task-term pages at 24 complete candidates", () =>
    Effect.gen(function* () {
      const { service, adapter } = yield* fixture;
      for (const term of ["alpha", "bravo", "charlie"]) {
        for (let i = 0; i < 13; i++)
          yield* service.createFromWriter({
            ...input,
            id: DecisionId.make(`${term}-${i}`),
            actionKey: `${term}-${i}`,
            title: term,
            body: term,
            rationale: null,
          });
      }
      const values = yield* adapter.retrieve({ ...task, newestMessage: "alpha bravo charlie" });
      assert.equal(values.length, 24);
      assert.equal(new Set(values.map((value) => value.id)).size, 24);
      assert.isTrue(
        values.every((value) => value.coverage.complete && value.evidence.length === 1),
      );
    }),
  );
});
