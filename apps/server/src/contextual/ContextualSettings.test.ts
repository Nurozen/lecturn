import { assert, it } from "@effect/vitest";
import { ContextualSourcePolicy, ProjectId, ThreadId } from "@lecturn/contracts";
import { Effect, Result, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { initializeContextualThread, make } from "./ContextualSettings.ts";

const projectId = ProjectId.make("contextual-project");
const threadId = ThreadId.make("contextual-thread");
const source = `decisions:${projectId}`;
const decodeIds = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodePolicy = Schema.encodeSync(Schema.fromJsonString(ContextualSourcePolicy));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM contextual_project_settings`;
  yield* sql`DELETE FROM contextual_thread_settings`;
  yield* sql`DELETE FROM contextual_host_state`;
  yield* sql`DELETE FROM contextual_outbox`;
  yield* sql`INSERT OR REPLACE INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'QA', '/tmp/contextual', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT OR REPLACE INTO projection_threads(thread_id, project_id, title, model_selection_json, created_at, updated_at, runtime_mode, interaction_mode) VALUES (${threadId}, ${projectId}, 'QA', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'full-access', 'default')`;
  return { sql, repo: yield* make };
});

it.layer(SqlitePersistenceMemory)("Contextual settings", (it) => {
  it.effect(
    "copies project defaults only at creation and preserves explicit toggles on replay",
    () =>
      Effect.gen(function* () {
        const { sql, repo } = yield* fixture;
        yield* repo.updateProject({
          projectId,
          expectedRevision: 0,
          defaultEnabled: true,
          sourceIds: [source],
        });
        assert.isFalse((yield* repo.thread(threadId)).enabled);
        yield* initializeContextualThread(sql, { projectId, threadId });
        assert.isTrue((yield* repo.thread(threadId)).enabled);
        yield* repo.updateProject({
          projectId,
          expectedRevision: 1,
          defaultEnabled: false,
          sourceIds: [source],
        });
        assert.isTrue((yield* repo.thread(threadId)).enabled);
        yield* repo.updateThread({ threadId, expectedRevision: 0, enabled: false, sourceIds: [] });
        yield* initializeContextualThread(sql, { projectId, threadId });
        assert.isFalse((yield* repo.thread(threadId)).enabled);
        assert.equal((yield* repo.thread(threadId)).revision, 1);
      }),
  );
  it.effect("rejects stale writes and source widening without changing requested state", () =>
    Effect.gen(function* () {
      const { repo } = yield* fixture;
      yield* repo.updateProject({
        projectId,
        expectedRevision: 0,
        defaultEnabled: false,
        sourceIds: [source],
      });
      yield* repo.updateThread({
        threadId,
        expectedRevision: 0,
        enabled: true,
        sourceIds: [source],
      });
      const stale = yield* repo
        .updateThread({ threadId, expectedRevision: 0, enabled: false, sourceIds: [] })
        .pipe(Effect.result);
      const wider = yield* repo
        .updateThread({ threadId, expectedRevision: 1, enabled: true, sourceIds: ["slack:other"] })
        .pipe(Effect.result);
      const hostWider = yield* repo
        .updateProject({
          projectId,
          expectedRevision: 1,
          defaultEnabled: true,
          sourceIds: ["slack:other"],
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(stale));
      assert.isTrue(Result.isFailure(wider));
      assert.isTrue(Result.isFailure(hostWider));
      assert.isTrue((yield* repo.thread(threadId)).enabled);
      assert.deepEqual((yield* repo.thread(threadId)).sourceIds, [source]);
    }),
  );
  it.effect(
    "unknown imports start off and forks intersect parent intent with destination sources",
    () =>
      Effect.gen(function* () {
        const { sql, repo } = yield* fixture;
        yield* repo.updateProject({
          projectId,
          expectedRevision: 0,
          defaultEnabled: true,
          sourceIds: [source],
        });
        yield* initializeContextualThread(sql, { projectId, threadId, origin: "unknown-import" });
        assert.isFalse((yield* repo.thread(threadId)).enabled);
        const child = ThreadId.make("contextual-child");
        yield* initializeContextualThread(sql, {
          projectId,
          threadId: child,
          parentThreadId: threadId,
        });
        const rows = yield* sql<{
          enabled: number;
          source_ids_json: string;
        }>`SELECT * FROM contextual_thread_settings WHERE thread_id=${child}`;
        assert.equal(rows[0]?.enabled, 0);
        assert.deepEqual(decodeIds(rows[0]!.source_ids_json), [source]);
      }),
  );
  it.effect("hides deleted threads and keeps outbox records free of source text", () =>
    Effect.gen(function* () {
      const { sql, repo } = yield* fixture;
      yield* repo.updateThread({ threadId, expectedRevision: 0, enabled: true, sourceIds: [] });
      const events = yield* sql`SELECT * FROM contextual_outbox`;
      assert.equal(events.length, 1);
      assert.notProperty(events[0], "quote");
      yield* sql`UPDATE projection_threads SET deleted_at='2026-01-02T00:00:00.000Z' WHERE thread_id=${threadId}`;
      assert.isTrue(Result.isFailure(yield* repo.thread(threadId).pipe(Effect.result)));
    }),
  );
});

it.layer(SqlitePersistenceMemory)("Contextual removed project sources", (it) => {
  for (const operation of ["disable", "change-sources"] as const) {
    it.effect(`normalizes a removed selection when the client requests ${operation}`, () =>
      Effect.gen(function* () {
        const { sql, repo } = yield* fixture;
        const removed = "slack:removed";
        const policy = encodePolicy({
          allowedSourceIds: [removed],
          allowDirectMessages: false,
          allowGroupDirectMessages: false,
          unknownConversationPolicy: "exclude",
          draftsPolicy: "exclude",
          revision: 1,
        });
        yield* sql`INSERT INTO contextual_host_state(singleton,source_policy_json,updated_at) VALUES (1,${policy},'2026-01-01T00:00:00Z')`;
        yield* repo.updateProject({
          projectId,
          expectedRevision: 0,
          defaultEnabled: true,
          sourceIds: [removed, source],
        });
        yield* repo.updateThread({
          threadId,
          expectedRevision: 0,
          enabled: true,
          sourceIds: [removed, source],
        });
        yield* repo.updateProject({
          projectId,
          expectedRevision: 1,
          defaultEnabled: true,
          sourceIds: [source],
        });
        const current = yield* repo.thread(threadId);
        // Both clients send their persisted list; web checkbox edits retain hidden removed IDs.
        const next = yield* repo.updateThread({
          threadId,
          expectedRevision: current.revision,
          enabled: operation !== "disable",
          sourceIds:
            operation === "disable"
              ? current.sourceIds
              : current.sourceIds.filter((id) => id !== source),
        });
        assert.equal(next.enabled, operation !== "disable");
        assert.deepEqual(next.sourceIds, operation === "disable" ? [source] : []);
        assert.equal(next.revision, current.revision + 1);
        assert.deepEqual(yield* repo.thread(threadId), next);
        const widened = yield* repo
          .updateThread({
            threadId,
            expectedRevision: next.revision,
            enabled: true,
            sourceIds: [removed],
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(widened));
        assert.deepEqual(yield* repo.thread(threadId), next);
      }),
    );
  }
});

it.layer(SqlitePersistenceMemory)("Contextual removed host sources", (it) => {
  for (const client of ["web", "mobile"] as const) {
    it.effect(`keeps ${client} project controls usable after host source removal`, () =>
      Effect.gen(function* () {
        const { sql, repo } = yield* fixture;
        const removed =
          client === "web" ? ["slack:removed-a", "slack:removed-b"] : ["slack:removed-a"];
        const retained = "slack:retained";
        const policy = {
          allowedSourceIds: [...removed, retained],
          allowDirectMessages: false,
          allowGroupDirectMessages: false,
          unknownConversationPolicy: "exclude" as const,
          draftsPolicy: "exclude" as const,
          revision: 1,
        };
        yield* sql`INSERT INTO contextual_host_state(singleton,source_policy_json,updated_at)
          VALUES (1,${encodePolicy(policy)},'2026-01-01T00:00:00Z')`;
        const original = yield* repo.updateProject({
          projectId,
          expectedRevision: 0,
          defaultEnabled: true,
          sourceIds: [...removed, retained, source],
        });
        yield* sql`UPDATE contextual_host_state SET source_policy_json=${encodePolicy({ ...policy, allowedSourceIds: [retained], revision: 2 })} WHERE singleton=1`;
        const current = yield* repo.project(projectId);
        assert.deepEqual(current, original);
        // An old removed selection must not let a client introduce an unrelated forbidden source.
        const widened = yield* repo
          .updateProject({
            ...current,
            expectedRevision: current.revision,
            sourceIds: [...current.sourceIds, "slack:unauthorized"],
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(widened));
        assert.deepEqual(yield* repo.project(projectId), current);
        const next = yield* repo.updateProject({
          projectId,
          expectedRevision: current.revision,
          defaultEnabled: client === "mobile" ? false : current.defaultEnabled,
          // Web removes one row while the other removed ID remains; mobile toggles the default.
          sourceIds:
            client === "web"
              ? current.sourceIds.filter((id) => id !== removed[0])
              : current.sourceIds,
        });
        assert.deepEqual(next.sourceIds, [retained, source]);
        assert.equal(next.defaultEnabled, client !== "mobile");
        assert.equal(next.revision, current.revision + 1);
        assert.deepEqual(yield* repo.project(projectId), next);
        const restoredWithoutPermission = yield* repo
          .updateProject({
            ...next,
            expectedRevision: next.revision,
            sourceIds: [...next.sourceIds, removed[0]!],
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(restoredWithoutPermission));
        assert.deepEqual(yield* repo.project(projectId), next);
      }),
    );
  }
});
