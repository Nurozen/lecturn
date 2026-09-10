import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import Migration049, {
  STAVE_LIFECYCLE_PROJECTOR,
} from "../../persistence/Migrations/049_StaveProjectLifecycle.ts";

const now = "2026-01-01T00:00:00.000Z";
const deleted = (id: string, withRoot = true) => ({
  type: "project.deleted" as const,
  eventId: EventId.make(`event-${id}`),
  aggregateKind: "project" as const,
  aggregateId: ProjectId.make(id),
  occurredAt: now,
  commandId: CommandId.make(`cmd-${id}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-${id}`),
  metadata: {},
  payload: {
    projectId: ProjectId.make(id),
    deletedAt: now,
    ...(withRoot
      ? {
          workspaceRoot: `/space/${id}`,
          staveSpaceId: id,
          staveCreatedAt: now,
          staveSagaRemoveConfirmed: true,
        }
      : {}),
  },
});
const layer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "stave-projector-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer)("Stave delete intent projector", (it) => {
  it.effect(
    "commits intents transactionally, preserves terminal rows, and skips historical payloads",
    () =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO stave_project_lifecycle (project_id,workspace_root,disposition,updated_at) VALUES ('terminal','/space/terminal','destroyed',${now})`;
        for (const [id, withRoot] of [
          ["fresh", true],
          ["terminal", true],
          ["historical", false],
        ] as const) {
          const event = yield* store.append(deleted(id, withRoot));
          yield* pipeline.projectEvent(event);
        }
        const rows = yield* sql<{
          project_id: string;
          disposition: string;
          space_id: string | null;
          saga_remove_confirmed: number;
          delete_intent_sequence: number | null;
        }>`SELECT * FROM stave_project_lifecycle ORDER BY project_id`;
        assert.deepEqual(
          rows.map((row) => [row.project_id, row.disposition]),
          [
            ["fresh", "pending_evaluation"],
            ["terminal", "destroyed"],
          ],
        );
        assert.equal(rows[0]?.space_id, "fresh");
        assert.equal(rows[0]?.saga_remove_confirmed, 1);
        assert.isNumber(rows[1]?.delete_intent_sequence);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const event = yield* store.append(deleted("rolled-back"));
              yield* pipeline.projectEventDeferred(event).pipe(Effect.asVoid);
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.ignore);
        const rolledBack =
          yield* sql`SELECT * FROM stave_project_lifecycle WHERE project_id = 'rolled-back'`;
        assert.equal(rolledBack.length, 0);
        const rolledBackEvents =
          yield* sql`SELECT * FROM orchestration_events WHERE stream_id = 'rolled-back'`;
        assert.equal(rolledBackEvents.length, 0);
      }),
  );
  it.effect(
    "a new delete rearms Keep and refused archive episodes without losing durable incarnation",
    () =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        for (const disposition of [
          "kept",
          "refused",
          "live",
          "pending_archive",
          "destroying",
          "archived",
        ] as const) {
          yield* sql`INSERT INTO stave_project_lifecycle (project_id,workspace_root,space_id,manifest_created_at,disposition,refusal_code,updated_at)
          VALUES (${disposition}, ${`/space/${disposition}`}, ${disposition}, ${now}, ${disposition}, 'dirty_worktrees', ${now})`;
          const event = yield* store.append({
            ...deleted(disposition),
            payload: {
              projectId: ProjectId.make(disposition),
              deletedAt: now,
              workspaceRoot: `/space/${disposition}`,
            },
          });
          yield* pipeline.projectEvent(event);
          const rows = yield* sql<{
            disposition: string;
            space_id: string;
            manifest_created_at: string;
            refusal_code: string | null;
          }>`SELECT * FROM stave_project_lifecycle WHERE project_id = ${disposition}`;
          assert.equal(
            rows[0]?.disposition,
            disposition === "destroying" || disposition === "archived"
              ? disposition
              : "pending_evaluation",
          );
          assert.equal(rows[0]?.space_id, disposition);
          assert.equal(rows[0]?.manifest_created_at, now);
          if (disposition !== "destroying" && disposition !== "archived")
            assert.isNull(rows[0]?.refusal_code);
          yield* sql`UPDATE stave_project_lifecycle SET disposition = 'kept' WHERE project_id = ${disposition}`;
          yield* pipeline.projectEvent(event);
          assert.equal(
            (yield* sql<{
              disposition: string;
            }>`SELECT disposition FROM stave_project_lifecycle WHERE project_id = ${disposition}`)[0]
              ?.disposition,
            "kept",
          );
        }
      }),
  );
  it.effect("migration skips existing deletes and projection reset does not backfill them", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* store.append(deleted("before-migration"));
      yield* sql`DROP TABLE stave_project_lifecycle`;
      yield* sql`DROP TABLE stave_lifecycle_cursor`;
      yield* sql`DELETE FROM projection_state WHERE projector = ${STAVE_LIFECYCLE_PROJECTOR}`;
      yield* Migration049;
      yield* pipeline.bootstrap;
      assert.equal((yield* sql`SELECT * FROM stave_project_lifecycle`).length, 0);
      // Resetting projections must preserve the operational cursor and rows.
      yield* sql`DELETE FROM projection_state`;
      yield* pipeline.bootstrap;
      assert.equal((yield* sql`SELECT * FROM stave_project_lifecycle`).length, 0);
      const event = yield* store.append(deleted("after-migration"));
      yield* pipeline.projectEvent(event);
      const rows = yield* sql<{
        project_id: string;
      }>`SELECT project_id FROM stave_project_lifecycle`;
      assert.deepEqual(
        rows.map((row) => row.project_id),
        ["after-migration"],
      );
    }),
  );
});
