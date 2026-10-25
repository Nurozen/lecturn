import { assert, it } from "@effect/vitest";
import {
  AppId,
  type ApplicationProjectEvent,
  EventId,
  ProjectId,
  ProviderInstanceId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0080 from "../persistence/Migrations/080_ProjectionProjectsAppBinding.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

// Migration 80 is registered by A12's Migrations.ts entry; it is idempotent,
// so applying it here as well is harmless once that lands.
const layerSqlite = Layer.effectDiscard(Migration0080).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const at = "2026-10-25T00:00:00.000Z";
let sequence = 100;
const created = (
  projectId: ProjectId,
  workspaceRoot: string,
  appBinding?: { readonly appId: AppId; readonly workspaceRoot: string },
): ApplicationProjectEvent => ({
  sequence: ++sequence,
  eventId: EventId.make(`event-created-${projectId}`),
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: at,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.created",
  payload: {
    projectId,
    title: "Project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: at,
    updatedAt: at,
    ...(appBinding === undefined ? {} : { appBinding }),
  },
});

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(layerSqlite)))("ProjectStoreV2", (it) => {
  it.effect("stores a model selection without options as JSON without an options key", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-null-options");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("event-null-options"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-03-24T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Null options project",
          workspaceRoot: "/tmp/project-null-options",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: "2026-03-24T00:00:00.000Z",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      });

      const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
      assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
      assert.deepStrictEqual(
        Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
        modelSelection,
      );
    }),
  );

  it.effect("keeps app projects out of workspace-root lookups and in their own", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const app = AppId.make("dev.rocketwright");
      const normalId = ProjectId.make("project-normal-shared");
      const appId = ProjectId.make("project-app-shared");
      const binding = { appId: app, workspaceRoot: "/tmp/shared/" };
      // The app project is created first so a lookup cannot win by row order.
      yield* projects.apply(created(appId, "/tmp/shared", binding));
      yield* projects.apply(created(normalId, "/tmp/shared"));

      const owner = yield* projects.findActiveByWorkspaceRoot("/tmp/shared");
      assert.strictEqual(Option.getOrThrow(owner).projectId, normalId);
      const appProject = yield* projects.findActiveByAppWorkspace(app, "/tmp/shared/");
      assert.strictEqual(Option.getOrThrow(appProject).projectId, appId);
      assert.isTrue(Option.isNone(yield* projects.findActiveByAppWorkspace(app, "/tmp/shared")));
      assert.isTrue(
        Option.isNone(
          yield* projects.findActiveByAppWorkspace(AppId.make("dev.other"), "/tmp/shared/"),
        ),
      );

      assert.deepStrictEqual(
        Option.getOrThrow(yield* projects.getShell(appId)).appBinding,
        binding,
      );
      assert.isFalse("appBinding" in Option.getOrThrow(yield* projects.getShell(normalId)));
    }),
  );

  it.effect("keeps appBinding through updates, deletion and a replay", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const app = AppId.make("dev.rocketwright");
      const projectId = ProjectId.make("project-app-updated");
      const binding = { appId: app, workspaceRoot: "/tmp/updated" };
      const creation = created(projectId, "/tmp/updated", binding);
      const update: ApplicationProjectEvent = {
        ...creation,
        sequence: ++sequence,
        eventId: EventId.make("event-app-updated"),
        type: "project.meta-updated",
        payload: { projectId, title: "Renamed", autoPull: true, updatedAt: at },
      };
      yield* projects.apply(creation);
      yield* projects.apply(update);
      assert.deepStrictEqual(Option.getOrThrow(yield* projects.get(projectId)).appBinding, binding);

      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* projects.apply(creation);
      yield* projects.apply(update);
      const replayed = Option.getOrThrow(yield* projects.get(projectId));
      assert.strictEqual(replayed.title, "Renamed");
      assert.deepStrictEqual(replayed.appBinding, binding);

      yield* projects.apply({
        ...creation,
        sequence: ++sequence,
        eventId: EventId.make("event-app-deleted"),
        type: "project.deleted",
        payload: { projectId, workspaceRoot: "/tmp/updated", deletedAt: at },
      });
      assert.isTrue(Option.isNone(yield* projects.findActiveByAppWorkspace(app, "/tmp/updated")));
      assert.deepStrictEqual(
        Option.getOrThrow(yield* projects.get(projectId, { includeDeleted: true })).appBinding,
        binding,
      );
    }),
  );
});
