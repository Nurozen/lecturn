import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { StaveWorkspaceReader } from "../../stave/StaveWorkspaceReader.ts";

const now = "2026-01-01T00:00:00.000Z";
const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provide(
    Layer.succeed(StaveWorkspaceReader, {
      load: () => Effect.succeed(Option.none()),
      invalidate: () => Effect.void,
      invalidateAll: () => Effect.void,
    }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer)("Stave lifecycle snapshot queries", (it) => {
  it.effect("returns every thread lifecycle anchor, including deleted and archived rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      for (const id of ["active", "archived", "deleted"]) {
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, settled_at, archived_at, deleted_at)
        VALUES (${id}, 'anchor-project', ${id}, '{}', ${now}, ${now}, ${now}, ${id === "archived" ? now : null}, ${id === "deleted" ? now : null})`;
      }
      const rows = yield* query.listThreadLifecycleAnchorsByProjectId(
        ProjectId.make("anchor-project"),
      );
      assert.deepEqual(
        rows.map((row) => row.threadId),
        ["active", "archived", "deleted"],
      );
      assert.equal(rows[1]?.archivedAt, now);
      assert.equal(rows[2]?.deletedAt, now);
    }),
  );
  it.effect(
    "finds realpath descendants through aliases while excluding siblings and deleted projects",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fs.makeTempDirectoryScoped();
        const root = path.join(temp, "space");
        yield* fs.makeDirectory(path.join(root, "nested"), { recursive: true });
        yield* fs.makeDirectory(path.join(temp, "space-other"));
        const alias = path.join(temp, "alias");
        yield* fs.symlink(path.join(root, "nested"), alias);
        for (const [id, workspaceRoot, deletedAt] of [
          ["root", root, null],
          ["nested", alias, null],
          ["sibling", path.join(temp, "space-other"), null],
          ["deleted-root", path.join(root, "gone"), now],
        ] as const) {
          yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at) VALUES (${id},${id},${workspaceRoot},'[]',${now},${now},${deletedAt})`;
        }
        assert.deepEqual(
          (yield* query.listActiveProjectRootsUnder(root)).map((row) => row.projectId),
          ["nested"],
        );
      }),
  );
  it.effect("derives the same lifecycle notice on detail and shell project reads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('notice','Notice','/notice','[]',${now},${now})`;
      yield* sql`INSERT INTO stave_project_lifecycle (project_id,workspace_root,disposition,archive_deadline_at,updated_at) VALUES ('notice','/notice','pending_archive','2026-01-02T00:00:00.000Z',${now})`;
      const shell = Option.getOrThrow(yield* query.getProjectShellById(ProjectId.make("notice")));
      const detail = Option.getOrThrow(yield* query.getActiveProjectByWorkspaceRoot("/notice"));
      assert.deepEqual(shell.notice, { kind: "archive_scheduled", at: "2026-01-02T00:00:00.000Z" });
      assert.deepEqual(detail.notice, shell.notice);
      yield* sql`UPDATE stave_project_lifecycle SET disposition = 'refused', refusal_code = 'nested_project', refusal_message = 'Nested project' WHERE project_id = 'notice'`;
      assert.deepEqual(
        Option.getOrThrow(yield* query.getProjectShellById(ProjectId.make("notice"))).notice,
        { kind: "refused", at: now, code: "nested_project", message: "Nested project" },
      );
    }),
  );
});
