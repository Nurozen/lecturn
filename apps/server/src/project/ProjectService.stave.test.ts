/**
 * Lecturn Stave on the V2 ProjectService: project shells carry `stave` /
 * `notice` from StaveProjectShells, and a deletion binds the space identity
 * from a fresh manifest read (V1 ProjectionSnapshotQuery + Normalizer).
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { StaveProjectShells } from "../stave/StaveProjectShells.ts";
import { StaveWorkspaceReader } from "../stave/StaveWorkspaceReader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

// Every root under /work/space* carries a manifest (one per test: the layer is shared).
const isSpaceRoot = (workspaceRoot: string) => workspaceRoot.startsWith("/work/space");
const CREATED_AT = "2026-10-01T00:00:00.000Z";
const invalidated: Array<string> = [];

const staveLayer = Layer.mergeAll(
  Layer.succeed(StaveWorkspaceReader, {
    load: (workspaceRoot) =>
      Effect.succeed(
        isSpaceRoot(workspaceRoot)
          ? Option.some({ spaceId: "space-1", createdAt: CREATED_AT } as never)
          : Option.none(),
      ),
    invalidate: (workspaceRoot) => Effect.sync(() => void invalidated.push(workspaceRoot)),
    invalidateAll: () => Effect.void,
  }),
  Layer.mock(StaveProjectShells)({
    decorate: (shells) =>
      Effect.succeed(
        shells.map((shell) => ({
          ...shell,
          stave: isSpaceRoot(shell.workspaceRoot) ? ({ spaceId: "space-1" } as never) : null,
          notice: null,
        })),
      ),
  }),
);

const TestLayer = ProjectServiceLayerLive.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(
    Layer.succeed(WorkspacePaths.WorkspacePaths, {
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
        Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
    }),
  ),
  Layer.provideMerge(
    Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-stave-" })),
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(staveLayer),
);

it.layer(TestLayer)("ProjectService (Lecturn Stave)", (it) => {
  it.effect("decorates shells sent to clients with Stave space info", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const spaceId = ProjectId.make("project:stave-shell");
      const plainId = ProjectId.make("project:plain-shell");
      yield* service.create({
        commandId: CommandId.make("command:stave-shell:create"),
        projectId: spaceId,
        title: "Space",
        workspaceRoot: "/work/space-shell",
      });
      yield* service.create({
        commandId: CommandId.make("command:plain-shell:create"),
        projectId: plainId,
        title: "Plain",
        workspaceRoot: "/work/plain",
      });

      const shell = Option.getOrThrow(yield* service.getShell(spaceId));
      assert.deepEqual(shell.stave, { spaceId: "space-1" } as never);
      assert.isNull(shell.notice);
      const listed = yield* service.listShells();
      const staveById = new Map(listed.map((entry) => [entry.id, entry.stave]));
      assert.deepEqual(staveById.get(spaceId), { spaceId: "space-1" } as never);
      assert.isNull(staveById.get(plainId));
    }),
  );

  it.effect("binds the space identity on delete and keeps the client's saga consent", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const spaceId = ProjectId.make("project:stave-delete");
      const plainId = ProjectId.make("project:plain-delete");
      yield* service.create({
        commandId: CommandId.make("command:stave-delete:create"),
        projectId: spaceId,
        title: "Space",
        workspaceRoot: "/work/space-delete",
      });
      yield* service.create({
        commandId: CommandId.make("command:plain-delete:create"),
        projectId: plainId,
        title: "Plain",
        workspaceRoot: "/work/plain-delete",
      });
      invalidated.length = 0;

      yield* service.delete({
        commandId: CommandId.make("command:stave-delete:delete"),
        projectId: spaceId,
        // A forged client id never reaches the event: the server binds it.
        stave: { staveSagaRemoveConfirmed: true, staveSpaceId: "forged" },
      });
      yield* service.delete({
        commandId: CommandId.make("command:plain-delete:delete"),
        projectId: plainId,
        stave: { staveSpaceId: "forged" },
      });
      assert.deepEqual(invalidated, ["/work/space-delete", "/work/plain-delete"]);

      const payloads = yield* sql<{ readonly stream_id: string; readonly payload_json: string }>`
        SELECT stream_id, payload_json FROM orchestration_events
        WHERE event_type = 'project.deleted' AND stream_id IN (${spaceId}, ${plainId})
        ORDER BY sequence ASC
      `;
      const deleted = payloads.map((row) => JSON.parse(row.payload_json));
      assert.equal(deleted[0].workspaceRoot, "/work/space-delete");
      assert.equal(deleted[0].staveSpaceId, "space-1");
      assert.equal(deleted[0].staveCreatedAt, CREATED_AT);
      assert.equal(deleted[0].staveSagaRemoveConfirmed, true);
      assert.isUndefined(deleted[1].staveSpaceId);
      assert.isUndefined(deleted[1].staveCreatedAt);
    }),
  );
});
