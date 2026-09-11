import { CommandId, EventId, ProjectId, StaveSagaTeardownAuthorization } from "@lecturn/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

const decodeSagaTeardown = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StaveSagaTeardownAuthorization),
);

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
          staveSagaTeardown: {
            expectedSagaReview: "review-fingerprint",
            target: "destroy" as const,
            force: false,
            memory: "keep" as const,
          },
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
    "root edits invalidate old lifecycle identity and schedules while operation-owned moves preserve their lease",
    () =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        for (const disposition of ["pending_archive", "archiving"] as const) {
          const id = `rebind-${disposition}`;
          yield* sql`INSERT INTO stave_project_lifecycle (project_id,workspace_root,space_id,manifest_created_at,disposition,scheduled_at,anchor_at,archive_deadline_at,owner_token,lease_epoch,lease_until,updated_at)
          VALUES (${id}, '/old', 'old', ${now}, ${disposition}, ${now}, ${now}, ${now}, ${disposition === "archiving" ? "operation" : null}, 3, ${disposition === "archiving" ? "2026-01-02T00:00:00.000Z" : null}, ${now})`;
          const event = yield* store.append({
            ...deleted(id),
            type: "project.meta-updated",
            payload: { projectId: ProjectId.make(id), workspaceRoot: "/new", updatedAt: now },
          });
          yield* pipeline.projectEvent(event);
          const [row] = yield* sql<{
            workspace_root: string;
            space_id: string | null;
            scheduled_at: string | null;
            disposition: string;
            owner_token: string | null;
            lease_epoch: number;
          }>`SELECT * FROM stave_project_lifecycle WHERE project_id = ${id}`;
          if (disposition === "archiving") {
            assert.equal(row?.workspace_root, "/old");
            assert.equal(row?.owner_token, "operation");
            assert.equal(row?.lease_epoch, 3);
          } else {
            assert.equal(row?.workspace_root, "/new");
            assert.isNull(row?.space_id);
            assert.isNull(row?.scheduled_at);
            assert.equal(row?.disposition, "pending_evaluation");
            assert.equal(row?.lease_epoch, 4);
          }
          yield* sql`DELETE FROM stave_project_lifecycle WHERE project_id = ${id}`;
        }
      }),
  );

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
          saga_teardown_json: string;
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
        assert.deepEqual(yield* decodeSagaTeardown(rows[0]!.saga_teardown_json), {
          expectedSagaReview: "review-fingerprint",
          target: "destroy",
          force: false,
          memory: "keep",
        });
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
      yield* sql`ALTER TABLE stave_project_lifecycle ADD COLUMN saga_teardown_json TEXT`;
      yield* pipeline.bootstrap;
      assert.equal((yield* sql`SELECT * FROM stave_project_lifecycle`).length, 0);
      yield* sql`INSERT INTO stave_lifecycle_schedule_resets (project_id) VALUES ('reset-retained')`;
      yield* sql`INSERT INTO stave_lifecycle_policy (singleton, enabled, archive_mode) VALUES (1, 0, 'archive-after-grace')`;
      // Resetting projections must preserve operational identity and unapplied settings changes.
      yield* sql`DELETE FROM projection_state`;
      yield* pipeline.bootstrap;
      assert.equal((yield* sql`SELECT * FROM stave_project_lifecycle`).length, 0);
      assert.equal(
        (yield* sql`SELECT project_id FROM stave_lifecycle_schedule_resets WHERE project_id = 'reset-retained'`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql<{
          enabled: number;
        }>`SELECT enabled FROM stave_lifecycle_policy WHERE singleton = 1`)[0]?.enabled,
        0,
      );
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
