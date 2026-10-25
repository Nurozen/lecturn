// @effect-diagnostics nodeBuiltinImport:off - The fixture under test is a host-side script that owns temp directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { runSqliteState } from "../apps/server/scripts/lecturn-sqlite-state.ts";
import * as EventStore from "../apps/server/src/orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../apps/server/src/orchestration-v2/ProjectionMaintenance.ts";
import {
  assertIsolatedBaseDir,
  BAR_FIXTURE,
  type BarFixtureProject,
  barProjectId,
  barServerStartTimeoutMs,
  barStoreLayer,
  barThreadCreatedAt,
  barThreadId,
  barThreadUpdatedAt,
  barWorkspaceRoot,
  buildBarProjectCommit,
  buildBarThreadEvents,
  expectedBarShell,
  fetchBarShellSnapshot,
  issueBarReadToken,
  seedBarFixture,
  shellVisibilityProblems,
  startBarServer,
} from "./seed-bar-fixture.ts";

const SERVER_TEST_TIMEOUT_MS = 300_000;

const query = (baseDir: string, sql: string) =>
  runSqliteState({ operation: "query", baseDir, sql }).pipe(
    Effect.map((result) => (result.operation === "query" ? result.rows : [])),
  );

const withTempDir = async <A>(run: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-bar-seed-"));
  try {
    return await run(dir);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const fixtureThreads = BAR_FIXTURE.flatMap((project) =>
  project.threads.map((thread) => ({ project, thread })),
);

it("pins every seeded event to the fixture's own timestamps", () => {
  for (const { project, thread } of fixtureThreads) {
    const events = buildBarThreadEvents(project, thread);
    const first = events[0];
    const last = events.at(-1);
    assert.equal(first?.type, "thread.created");
    assert.equal(
      last?.type,
      thread.state === "pinned"
        ? "thread.pinned"
        : thread.state === "settled"
          ? "thread.settled"
          : "thread.unsettled",
    );
    assert.equal(first && DateTime.formatIso(first.occurredAt), barThreadCreatedAt(thread));
    assert.equal(last && DateTime.formatIso(last.occurredAt), barThreadUpdatedAt(thread));
    assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  }
  const toolItems = fixtureThreads.flatMap(({ project, thread }) =>
    buildBarThreadEvents(project, thread).filter(
      (event) => event.type === "turn-item.updated" && event.payload.type === "dynamic_tool",
    ),
  );
  assert.isAbove(toolItems.length, 0);
});

it("refuses the shared Lecturn home", () =>
  withTempDir(async (dir) => {
    const sharedHome = NodePath.join(dir, "shared-home");
    await NodeFSP.mkdir(sharedHome);
    assert.throws(() => assertIsolatedBaseDir(sharedHome, sharedHome), /shared ~\/\.lecturn/u);
    assert.throws(
      () => assertIsolatedBaseDir(NodePath.join(sharedHome, "nested"), sharedHome),
      /shared ~\/\.lecturn/u,
    );
    assert.doesNotThrow(() => assertIsolatedBaseDir(NodePath.join(dir, "isolated"), sharedHome));
  }));

const tempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-bar-seed-"))),
  (dir) =>
    Effect.promise(() =>
      NodeFSP.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
);

const runningServer = (baseDir: string) =>
  Effect.acquireRelease(
    Effect.promise(() => startBarServer({ baseDir })),
    (server) => Effect.promise(() => server.stop()),
  );

const shellOf = (baseDir: string) =>
  Effect.gen(function* () {
    const server = yield* runningServer(baseDir);
    return yield* Effect.promise(async () =>
      fetchBarShellSnapshot(server.origin, await issueBarReadToken(baseDir)),
    );
  }).pipe(Effect.scoped);

it.effect(
  "serves every seeded project and thread after a rebuild and a restart",
  () =>
    Effect.gen(function* () {
      const baseDir = NodePath.join(yield* tempDir, "home");
      yield* Effect.promise(() => seedBarFixture({ baseDir, restart: false }));

      const projects = yield* query(
        baseDir,
        "SELECT project_id, title, workspace_root, created_at FROM projection_projects ORDER BY project_id",
      );
      assert.deepEqual(
        projects,
        [...BAR_FIXTURE]
          .sort((left, right) => barProjectId(left).localeCompare(barProjectId(right)))
          .map((project) => ({
            project_id: barProjectId(project),
            title: project.title,
            workspace_root: barWorkspaceRoot(baseDir, project),
            created_at: project.createdAt,
          })),
      );
      const threads = yield* query(
        baseDir,
        "SELECT thread_id, created_at, updated_at FROM orchestration_v2_projection_threads ORDER BY thread_id",
      );
      assert.deepEqual(
        threads,
        [...fixtureThreads]
          .sort((left, right) => barThreadId(left.thread).localeCompare(barThreadId(right.thread)))
          .map(({ thread }) => ({
            thread_id: barThreadId(thread),
            created_at: barThreadCreatedAt(thread),
            updated_at: barThreadUpdatedAt(thread),
          })),
      );
      const turns = fixtureThreads.flatMap(({ thread }) => thread.turns);
      const [messageCount] = yield* query(
        baseDir,
        "SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages",
      );
      assert.equal(messageCount?.count, turns.length * 2);
      const [toolCount] = yield* query(
        baseDir,
        "SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items",
      );
      assert.equal(
        toolCount?.count,
        turns.reduce((sum, turn) => sum + turn.tools.length, 0),
      );

      const rebuilt = yield* Effect.flatMap(
        ProjectionMaintenance.ProjectionMaintenanceV2,
        (maintenance) => maintenance.rebuild,
      ).pipe(Effect.provide(barStoreLayer(baseDir)));
      assert.isTrue(rebuilt.valid);

      const snapshot = yield* shellOf(baseDir);
      assert.deepEqual(shellVisibilityProblems(snapshot, expectedBarShell()), []);
      for (const { thread } of fixtureThreads) {
        const shell = snapshot.threads.find((candidate) => candidate.id === barThreadId(thread));
        assert.equal(shell?.pinnedAt != null, thread.state === "pinned", thread.key);
        assert.equal(shell?.settledOverride === "settled", thread.state === "settled", thread.key);
      }

      // A project event that skips ProjectStore.apply never becomes a project,
      // and the shell check must say so rather than pass on the event alone.
      const ghost: BarFixtureProject = {
        key: "ghost",
        title: "ghost",
        createdAt: "2026-10-14T09:00:00.000Z",
        threads: [],
      };
      yield* Effect.flatMap(EventStore.EventStoreV2, (store) =>
        store.appendProjectEvent(
          buildBarProjectCommit(ghost, barWorkspaceRoot(baseDir, ghost)).event,
        ),
      ).pipe(Effect.provide(barStoreLayer(baseDir)));
      const restarted = yield* shellOf(baseDir);
      assert.deepEqual(
        shellVisibilityProblems(restarted, expectedBarShell([...BAR_FIXTURE, ghost])),
        ["project bar-ghost is missing"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  SERVER_TEST_TIMEOUT_MS,
);

it("waits 90 s for the server by default, longer when the flag or env asks", () => {
  assert.equal(barServerStartTimeoutMs(undefined, {}), 90_000);
  assert.equal(barServerStartTimeoutMs(undefined, { BAR_SERVER_START_TIMEOUT_MS: "" }), 90_000);
  assert.equal(
    barServerStartTimeoutMs(undefined, { BAR_SERVER_START_TIMEOUT_MS: "240000" }),
    240_000,
  );
  assert.equal(
    barServerStartTimeoutMs("300000", { BAR_SERVER_START_TIMEOUT_MS: "240000" }),
    300_000,
  );
  assert.throws(() => barServerStartTimeoutMs("90s", {}), /--start-timeout/);
  assert.throws(
    () => barServerStartTimeoutMs(undefined, { BAR_SERVER_START_TIMEOUT_MS: "0" }),
    /BAR_SERVER_START_TIMEOUT_MS/,
  );
});
