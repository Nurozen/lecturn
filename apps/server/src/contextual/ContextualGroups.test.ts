import { assert, it } from "@effect/vitest";
import * as C from "@lecturn/contracts";
import { Effect, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { DecisionRepository } from "../threadDecisions/DecisionRepository.ts";
import { ExtensionsRuntime } from "../extensions/ExtensionsRuntime.ts";
import { make } from "./ContextualGroups.ts";

const projectId = C.ProjectId.make("group-project");
const now = "2026-09-25T00:00:00.000Z";
const note = (
  id: string,
  attribution: C.DecisionAttribution = "user-directed",
): C.ThreadDecision => ({
  id: C.DecisionId.make(id),
  projectId,
  threadId: C.ThreadId.make(`thread-${id}`),
  threadTitle: null,
  occurredAt: now,
  title: "Use SQLite",
  body: "Use SQLite for local storage",
  rationale: null,
  comment: null,
  attribution,
  reviewState: "unreviewed",
  lifecycle: "current",
  userEdited: false,
  revision: 0,
  occurrence: 1,
  createdAt: now,
  updatedAt: now,
  evidence: [
    {
      id: C.DecisionEvidenceId.make(`e-${id}`),
      threadId: C.ThreadId.make(`thread-${id}`),
      messageId: C.MessageId.make(`message-${id}`),
      messageRole: attribution === "agent-chosen" ? "assistant" : "user",
      sourceHash: id,
      sourceGeneration: 0,
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
  relationships: [],
  provenance: {
    descriptionRevision: 0,
    sourceFingerprint: id,
    canonicalVersion: "1",
    templateVersion: "1",
    detectorModel: "synthetic",
    writerSelection: { instanceId: C.ProviderInstanceId.make("synthetic"), model: "synthetic" },
    writerConfigurationGeneration: "1",
    identityConfidence: "configuration-only",
  },
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "contextual_decision_groups",
    "contextual_group_members",
    "contextual_actions",
    "contextual_outbox",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  const notes = new Map<string, C.ThreadDecision>([
    ["a", note("a")],
    ["b", note("b", "agent-chosen")],
  ]);
  const unavailable = new C.ThreadDecisionError({
    code: "not-found",
    message: "Synthetic missing",
  });
  const repository: DecisionRepository["Service"] = {
    get: (input) =>
      notes.has(input.id) && input.projectId === projectId
        ? Effect.succeed(notes.get(input.id)!)
        : Effect.fail(unavailable),
    list: () => Effect.fail(unavailable),
    mutate: () => Effect.fail(unavailable),
    export: () => Effect.fail(unavailable),
    createFromWriter: () => Effect.fail(unavailable),
    addEvidence: () => Effect.fail(unavailable),
    projectRevision: () => Effect.succeed(0),
    bumpRevision: () => Effect.succeed(0),
  };
  const runtime: ExtensionsRuntime["Service"] = {
    environmentId: C.EnvironmentId.make("synthetic-env"),
    hostName: "Synthetic",
    describe: Effect.succeed(null),
    request: () => Effect.fail(new C.ContextualError({ code: "unavailable", message: "offline" })),
    readExport: () =>
      Effect.fail(new C.ContextualError({ code: "unavailable", message: "offline" })),
  };
  const service = yield* make.pipe(
    Effect.provideService(DecisionRepository, repository),
    Effect.provideService(ExtensionsRuntime, runtime),
  );
  yield* service.ensure(notes.get("a")!);
  return { sql, notes, service };
});
it.layer(SqlitePersistenceMemory)("Contextual occurrence groups", (it) => {
  it.effect("replays only current group data and cannot expose deleted note bodies", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const request: C.ContextualGroupMutationRequest = {
        actionId: "delete-replay",
        groupId: "a",
        expectedRevision: 0,
        canonicalDecisionId: C.DecisionId.make("a"),
        occurrenceId: C.DecisionId.make("b"),
        expectedOccurrenceRevision: 0,
        action: "merge",
      };
      yield* f.service.mutateGroup(request);
      const rows = yield* f.sql<{
        result_json: string;
      }>`SELECT result_json FROM contextual_actions WHERE action_id='delete-replay'`;
      assert.isFalse(rows[0]!.result_json.includes("SQLite"));
      f.notes.delete("b");
      assert.isTrue(Result.isFailure(yield* f.service.mutateGroup(request).pipe(Effect.result)));
    }),
  );
  it.effect("rejects suggestion acceptance when the canonical note changed", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`INSERT OR REPLACE INTO decision_relation_suggestions VALUES('suggestion',${projectId},'a','b',0,0,'a','equivalent','suggested','synthetic','v1',${now})`;
      f.notes.set("a", { ...f.notes.get("a")!, revision: 1, body: "Different choice" });
      assert.isTrue(
        Result.isFailure(
          yield* f.service
            .mutateGroup({
              actionId: "stale-suggestion",
              suggestionId: "suggestion",
              groupId: "a",
              expectedRevision: 0,
              canonicalDecisionId: C.DecisionId.make("a"),
              occurrenceId: C.DecisionId.make("b"),
              expectedOccurrenceRevision: 0,
              action: "merge",
            })
            .pipe(Effect.result),
        ),
      );
    }),
  );
  it.effect(
    "merge and undo preserve independent occurrence authority and make repeated actions idempotent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const request: C.ContextualGroupMutationRequest = {
          actionId: "merge",
          groupId: "a",
          expectedRevision: 0,
          canonicalDecisionId: C.DecisionId.make("a"),
          occurrenceId: C.DecisionId.make("b"),
          expectedOccurrenceRevision: 0,
          action: "merge",
        };
        const merged = yield* f.service.mutateGroup(request);
        assert.equal(merged.occurrenceCount, 2);
        assert.equal(
          merged.occurrences.find((o) => o.decisionId === "b")?.attribution,
          "agent-chosen",
        );
        assert.deepEqual(yield* f.service.mutateGroup(request), merged);
        const undo = yield* f.service.undoGroup({
          actionId: "undo",
          mergeId: "merge",
          groupId: "a",
          expectedRevision: 1,
          expectedOccurrenceRevision: 0,
        });
        assert.equal(undo.occurrenceCount, 1);
        assert.equal(f.notes.get("b")?.attribution, "agent-chosen");
      }),
  );
  it.effect("requires current occurrence revisions and prevents transitive group chains", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.mutateGroup({
        actionId: "merge",
        groupId: "a",
        expectedRevision: 0,
        canonicalDecisionId: C.DecisionId.make("a"),
        occurrenceId: C.DecisionId.make("b"),
        expectedOccurrenceRevision: 0,
        action: "merge",
      });
      f.notes.set("b", { ...f.notes.get("b")!, revision: 1, userEdited: true });
      assert.isTrue(
        Result.isFailure(
          yield* f.service
            .undoGroup({
              actionId: "undo",
              mergeId: "merge",
              groupId: "a",
              expectedRevision: 1,
              expectedOccurrenceRevision: 1,
            })
            .pipe(Effect.result),
        ),
      );
      f.notes.set("c", note("c"));
      yield* f.service.ensure(f.notes.get("c")!);
      assert.isTrue(
        Result.isFailure(
          yield* f.service
            .mutateGroup({
              actionId: "chain",
              groupId: "c",
              expectedRevision: 0,
              canonicalDecisionId: C.DecisionId.make("c"),
              occurrenceId: C.DecisionId.make("a"),
              expectedOccurrenceRevision: 0,
              action: "merge",
            })
            .pipe(Effect.result),
        ),
      );
    }),
  );
  it.effect("pages more than 32 independent occurrences without flattening their provenance", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 35; index++) {
        const id = `member-${String(index).padStart(2, "0")}`;
        f.notes.set(id, note(id, index % 2 ? "agent-chosen" : "user-directed"));
        yield* f.sql`INSERT INTO contextual_group_members(decision_id,group_id,occurrence_revision,merge_id) VALUES(${id},'a',0,'fixture')`;
      }
      const first = yield* f.service.group({ projectId, groupId: "a", limit: 32 });
      assert.equal(first.occurrences.length, 32);
      assert.equal(first.occurrenceCount, 36);
      assert.isNotNull(first.nextCursor);
      const second = yield* f.service.group({
        projectId,
        groupId: "a",
        limit: 32,
        cursor: first.nextCursor!,
      });
      assert.equal(second.occurrences.length, 4);
      assert.isNull(second.nextCursor);
      assert.equal(
        new Set([...first.occurrences, ...second.occurrences].map((o) => o.decisionId)).size,
        36,
      );
    }),
  );
});
