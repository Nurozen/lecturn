import { assert, it } from "@effect/vitest";
import { DEFAULT_DECISION_TRACKING_DESCRIPTION, ProjectId, ThreadId } from "@lecturn/contracts";
import { Effect, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./DecisionSettingsRepository.ts";

const projectId = ProjectId.make("decisions-settings-project");
const threadId = ThreadId.make("decisions-settings-thread");
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "decision_project_settings",
    "decision_outbox",
    "decision_thread_state",
    "decision_jobs",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT OR REPLACE INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'QA', '/tmp/decisions-settings', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT OR REPLACE INTO projection_threads(thread_id, project_id, title, model_selection_json, created_at, updated_at, runtime_mode, interaction_mode) VALUES (${threadId}, ${projectId}, 'QA', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'full-access', 'default')`;
  return { sql, repo: yield* make };
});
it.layer(SqlitePersistenceMemory)("Decision settings", (it) => {
  it.effect(
    "activates at the committed boundary and description changes preserve admitted work epochs",
    () =>
      Effect.gen(function* () {
        const { repo } = yield* fixture;
        const initial = yield* repo.get(projectId);
        assert.isFalse(initial.enabled);
        assert.equal(initial.description, DEFAULT_DECISION_TRACKING_DESCRIPTION);
        assert.equal(initial.activationSequence, null);
        const enabled = yield* repo.update(
          {
            operation: "update",
            projectId,
            expectedRevision: 0,
            enabled: true,
            description: "Architecture",
          },
          42,
        );
        assert.equal(enabled.activationSequence, 42);
        assert.equal(enabled.cancellationEpoch, 1);
        const changed = yield* repo.update(
          {
            operation: "update",
            projectId,
            expectedRevision: 1,
            enabled: true,
            description: "Product choices",
          },
          99,
        );
        assert.equal(changed.activationSequence, 42);
        assert.equal(changed.cancellationEpoch, enabled.cancellationEpoch);
        assert.equal(changed.revision, 2);
        const stale = yield* repo
          .update(
            {
              operation: "update",
              projectId,
              expectedRevision: 1,
              enabled: false,
              description: "",
            },
            100,
          )
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(stale));
        assert.isTrue((yield* repo.get(projectId)).enabled);
        const disabled = yield* repo.update(
          {
            operation: "update",
            projectId,
            expectedRevision: 2,
            enabled: false,
            description: "Product choices",
          },
          100,
        );
        assert.equal(disabled.cancellationEpoch, 2);
      }),
  );
  it.effect("pauses only the chosen thread and fences stale resume actions", () =>
    Effect.gen(function* () {
      const { repo } = yield* fixture;
      yield* repo.update(
        { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
        10,
      );
      yield* repo.pause(
        { operation: "pause-thread", projectId, threadId, paused: true, expectedPauseEpoch: 0 },
        20,
      );
      const paused = yield* repo.threadState(projectId, threadId);
      assert.isTrue(paused.paused);
      assert.equal(paused.pauseEpoch, 1);
      assert.isTrue((yield* repo.get(projectId)).enabled);
      const stale = yield* repo
        .pause(
          { operation: "pause-thread", projectId, threadId, paused: false, expectedPauseEpoch: 0 },
          30,
        )
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(stale));
      yield* repo.pause(
        { operation: "pause-thread", projectId, threadId, paused: false, expectedPauseEpoch: 1 },
        30,
      );
      assert.isFalse((yield* repo.threadState(projectId, threadId)).paused);
      assert.equal((yield* repo.get(projectId)).revision, 1);
    }),
  );
  it.effect(
    "pending approvals, cloud outages and payer labels preserve admitted authorization",
    () =>
      Effect.gen(function* () {
        const { repo } = yield* fixture;
        yield* repo.setFunding(projectId, "active", "Member", 4);
        yield* repo.update(
          { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
          10,
        );
        const before = yield* repo.get(projectId);
        yield* repo.setFunding(projectId, "pending", "Member", 5);
        yield* repo.setFunding(projectId, "unavailable", "Member", 4);
        assert.deepEqual(yield* repo.get(projectId), before);
        yield* repo.setFunding(projectId, "active", "Renamed member", 4);
        const renamed = yield* repo.get(projectId);
        assert.equal(renamed.cancellationEpoch, before.cancellationEpoch);
        assert.equal(renamed.fundingAccountLabel, "Renamed member");
      }),
  );
  it.effect("denies another project's thread and hides deleted project settings", () =>
    Effect.gen(function* () {
      const { sql, repo } = yield* fixture;
      assert.isTrue(
        Result.isFailure(
          yield* repo.threadState(ProjectId.make("other"), threadId).pipe(Effect.result),
        ),
      );
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE project_id = ${projectId}`;
      assert.isTrue(Result.isFailure(yield* repo.get(projectId).pipe(Effect.result)));
      yield* repo.purge(projectId, undefined, true);
    }),
  );
  it.effect(
    "purge disables tracking, removes suppression, and retains the newer cancellation epoch",
    () =>
      Effect.gen(function* () {
        const { sql, repo } = yield* fixture;
        yield* repo.update(
          { operation: "update", projectId, expectedRevision: 0, enabled: true, description: "" },
          10,
        );
        yield* sql`INSERT INTO decision_suppression(project_id, fingerprint, created_at) VALUES (${projectId}, 'fingerprint', '2026-01-01T00:00:00.000Z')`;
        yield* repo.purge(projectId, 1);
        const settings = yield* repo.get(projectId);
        assert.isFalse(settings.enabled);
        assert.equal(settings.cancellationEpoch, 2);
        assert.equal(
          (yield* sql`SELECT * FROM decision_suppression WHERE project_id = ${projectId}`).length,
          0,
        );
      }),
  );
});
