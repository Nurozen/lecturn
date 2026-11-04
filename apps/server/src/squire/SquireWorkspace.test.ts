// @effect-diagnostics nodeBuiltinImport:off - Fixture repos are built and inspected with synchronous git, outside the code under test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  SquireId,
  type StorageCleanupReport,
  ThreadId,
} from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import { makeScriptedAdapterV2 } from "../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import { isCheckpointRestoreIsolated } from "../orchestration-v2/CheckpointRestoreSafety.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SquireWorkspace from "./SquireWorkspace.ts";

const squireId = SquireId.make("squire-s0c");
const projectId = ProjectId.make("project:home");
const threadId = ThreadId.make("thread:squire-home");
const instanceId = ProviderInstanceId.make("scripted");

// Test repos commit with -c identity so no global Git config is read or written.
const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=S0c",
      "-c",
      "user.email=s0c@example.test",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const initRepo = (dir: string) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet"]);
  NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "home\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "--quiet", "-m", "initial"]);
  return dir;
};
const refs = (cwd: string) => git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]);

const workspaceLayer = (baseDir: string) =>
  SquireWorkspace.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const scriptedRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
  Effect.gen(function* () {
    return [yield* makeScriptedAdapterV2({ instanceId, environment: {} })];
  }),
).pipe(
  Layer.provide(Layer.mergeAll(IdAllocator.layer, TestProviderHost.layer())),
  Layer.provide(NodeServices.layer),
);

/** One server over the Lecturn home's database; a second call is a restart. */
const serverLayer = (dbPath: string, options: { readonly restart: boolean }) => {
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    database,
    ProjectionStore.layer.pipe(Layer.provide(database)),
    ProjectStore.layer.pipe(Layer.provide(database)),
    ProviderReplayHarness.layerWithRegistry({ name: "squire-workspace" }, scriptedRegistry, {
      databaseLayer: database,
      ...(options.restart ? { recoverOnStartup: true } : { runEffectWorker: false }),
    }),
  );
};

// Worst case for generic cleanup: the managed worktree folder is the Lecturn
// home itself, so the scratch path sits inside it, and every rule is on.
const sweepStorage = (baseDir: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          worktreesDirectory: baseDir,
          storageCleanup: {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeAfterDays: 1,
            worktreeOnDelete: true,
          },
        }),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: () => Effect.succeed(() => {}),
      } as unknown as TerminalManager.TerminalManager["Service"]),
    );
    return yield* Context.get(context, StorageCleanup.StorageCleanup).runNow;
  });

const layouts = [
  {
    name: "a Lecturn home in a plain temp folder",
    make: (root: string) => ({ baseDir: NodePath.join(root, "home"), enclosing: null }),
  },
  {
    name: "a Lecturn home inside a Git checkout",
    make: (root: string) => {
      const enclosing = initRepo(NodePath.join(root, "enclosing"));
      return { baseDir: NodePath.join(enclosing, ".lecturn"), enclosing };
    },
  },
] as const;

describe("SquireWorkspace", () => {
  it.effect("ensure is idempotent, refuses path ids, and remove deletes", () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "squire-ws-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const enclosing = initRepo(NodePath.join(root, "enclosing"));
      yield* Effect.gen(function* () {
        const workspaces = yield* SquireWorkspace.SquireWorkspace;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* workspaces.ensure(squireId);
        assert.equal(
          workspace,
          path.join(enclosing, ".lecturn", "userdata", "squires", squireId, "workspace"),
        );
        // Its own top level, not the enclosing checkout.
        assert.equal(git(workspace, ["rev-parse", "--show-toplevel"]), workspace);
        NodeFS.writeFileSync(NodePath.join(workspace, "note.md"), "kept\n");
        const gitDir = git(workspace, ["rev-parse", "--absolute-git-dir"]);
        assert.equal(yield* workspaces.ensure(squireId), workspace);
        assert.equal(git(workspace, ["rev-parse", "--absolute-git-dir"]), gitDir);
        assert.isTrue(yield* fs.exists(NodePath.join(workspace, "note.md")));
        // A crash between mkdir and init leaves a plain folder; ensure repairs it.
        NodeFS.rmSync(NodePath.join(workspace, ".git"), { recursive: true });
        yield* workspaces.ensure(squireId);
        assert.equal(git(workspace, ["rev-parse", "--show-toplevel"]), workspace);

        for (const bad of ["..", "a/b", "."]) {
          const error = yield* workspaces.ensure(SquireId.make(bad)).pipe(Effect.flip);
          assert.equal(error._tag, "SquireWorkspaceError");
        }
        yield* workspaces.remove(squireId);
        assert.isFalse(yield* fs.exists(workspace));
        yield* workspaces.remove(squireId);
      }).pipe(Effect.provide(workspaceLayer(NodePath.join(enclosing, ".lecturn"))));
    }).pipe(Effect.scoped),
  );

  it.live.each(layouts)("a home run checkpoints only into the scratch repo: $name", (layout) =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "squire-s0c-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const { baseDir, enclosing } = layout.make(root);
      const homeProject = initRepo(NodePath.join(root, "home-project"));
      const outsideRefs = () => ({
        home: refs(homeProject),
        enclosing: enclosing === null ? null : refs(enclosing),
      });
      const before = outsideRefs();

      yield* Effect.gen(function* () {
        const workspaces = yield* SquireWorkspace.SquireWorkspace;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scratch = yield* workspaces.ensure(squireId);
        NodeFS.writeFileSync(NodePath.join(scratch, "notes.md"), "squire notes\n");

        // First server: project, home thread in the scratch repo, one run.
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          const created = planProjectCommand({
            command: {
              type: "project.create",
              commandId: CommandId.make("project:create"),
              projectId,
              title: "Home",
              workspaceRoot: homeProject,
            },
            state: {
              project: undefined,
              workspaceOwner: undefined,
              appWorkspaceOwner: undefined,
            },
            eventId: EventId.make("event:project-created"),
            now,
          });
          assert.isTrue(Result.isSuccess(created));
          yield* eventSink.commitProjectCommand({
            commandId: CommandId.make("project:create"),
            projectId,
            commandType: "project.create",
            acceptedAt: now,
            event: Result.getOrThrow(created),
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("thread:create"),
            threadId,
            projectId,
            title: "Squire · S0c",
            modelSelection: { instanceId, model: "scripted" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: scratch,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("message:send"),
            threadId,
            messageId: MessageId.make("message:one"),
            text: 'Go.\n\n```scripted\n[{ "assistantText": "Noted." }]\n```\n',
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          // The provider turn finishes on its own fiber. Finalization commits the
          // run as `waiting` with the checkpoint capture, the only way to `completed`.
          const persisted = (predicate: (stored: OrchestrationV2StoredEvent) => boolean) =>
            orchestrator.streamStoredEvents.pipe(Stream.filter(predicate), Stream.runHead);
          yield* persisted(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "waiting",
          );
          yield* worker.drain();
          yield* persisted(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "completed",
          );

          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.at(-1)!;
          assert.equal(run.status, "completed");
          assert.isNotNull(run.checkpointId);
          const checkpoint = projection.checkpoints.find((c) => c.id === run.checkpointId)!;
          assert.equal(checkpoint.status, "ready");
          const scope = projection.checkpointScopes.find((s) => s.id === checkpoint.scopeId)!;
          assert.equal(NodeFS.realpathSync(scope.cwd), scratch);
          assert.include(refs(scratch), checkpoint.ref);
          assert.equal(git(scratch, ["ls-tree", "-r", "--name-only", checkpoint.ref]), "notes.md");
          assert.include(refs(scratch), "refs/lecturn/");

          assert.isTrue(
            yield* isCheckpointRestoreIsolated(projection.thread, scope, {
              fileSystem: fs,
              path,
              projections: yield* ProjectionStore.ProjectionStoreV2,
              projects: yield* ProjectStore.ProjectStoreV2,
            }),
          );
        }).pipe(Effect.provide(serverLayer(config.dbPath, { restart: false })));
        assert.deepEqual(outsideRefs(), before);

        // Restart: a fresh server with startup recovery over the same home.
        const scratchRefs = refs(scratch);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          assert.equal(yield* workspaces.ensure(squireId), scratch);
          assert.equal(refs(scratch), scratchRefs);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).thread.worktreePath,
            scratch,
          );

          const keptBy = (report: StorageCleanupReport) =>
            report.entries
              .filter((entry) => entry.path === scratch)
              .map((entry) => `${entry.outcome}:${entry.reason}`);
          const sweeps = [keptBy(yield* sweepStorage(config.baseDir))];
          yield* orchestrator.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("thread:archive"),
            threadId,
          });
          yield* worker.drain();
          sweeps.push(keptBy(yield* sweepStorage(config.baseDir)));
          assert.isTrue(yield* fs.exists(scratch));
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("thread:delete"),
            threadId,
          });
          yield* worker.drain();
          sweeps.push(keptBy(yield* sweepStorage(config.baseDir)));
          // Cleanup sees the live and archived thread and keeps the path (a
          // branchless thread is never a cleanup candidate); deleted threads
          // without a branch are not even read.
          assert.deepEqual(sweeps, [
            ["kept:Thread is running or has pending work"],
            ["kept:Thread is running or has pending work"],
            [],
          ]);
          assert.isTrue(yield* fs.exists(NodePath.join(scratch, "notes.md")));

          // An old client's delete dialog removes the "worktree" from the home project.
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const removal = yield* gitDriver
            .removeWorktree({ cwd: homeProject, path: scratch, force: true })
            .pipe(Effect.flip);
          assert.equal(removal._tag, "GitCommandError");
          assert.isTrue(yield* fs.exists(NodePath.join(scratch, "notes.md")));
          assert.equal(refs(scratch), scratchRefs);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              serverLayer(config.dbPath, { restart: true }),
              GitVcsDriver.layer.pipe(
                Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
                Layer.provide(NodeServices.layer),
              ),
            ).pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
          ),
        );
        assert.deepEqual(outsideRefs(), before);

        yield* workspaces.remove(squireId);
        assert.isFalse(yield* fs.exists(scratch));
        assert.deepEqual(outsideRefs(), before);
      }).pipe(Effect.provide(workspaceLayer(baseDir)));
    }).pipe(Effect.scoped),
  );

  it.effect("worktree removal refuses paths at or under the Squires folder", () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "squire-guard-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const stateDir = NodePath.join(root, "userdata");
      const workspace = NodePath.join(stateDir, "squires", squireId, "workspace");
      NodeFS.mkdirSync(NodePath.join(workspace, "sub"), { recursive: true });
      const project = NodePath.join(root, "project");
      NodeFS.mkdirSync(project);
      // `link/..` is the workspace to the OS, though lexically it is `root`.
      NodeFS.symlinkSync(NodePath.join(workspace, "sub"), NodePath.join(root, "link"));
      NodeFS.symlinkSync(stateDir, NodePath.join(project, "state"));

      const owned = (target: string) => SquireWorkspace.isSquireWorkspacePath(stateDir, target);
      assert.isTrue(yield* owned(workspace));
      assert.isTrue(yield* owned(NodePath.join(stateDir, "squires")));
      assert.isTrue(yield* owned(`${project}/../userdata/squires/${squireId}/workspace`));
      assert.isTrue(yield* owned(NodePath.join(project, "state", "squires", "gone", "workspace")));
      assert.isTrue(yield* owned(`${root}/link/..`));
      assert.isFalse(yield* owned(project));
      assert.isFalse(yield* owned(stateDir));
      assert.isFalse(yield* owned(NodePath.join(stateDir, "squires-old")));

      const refused = yield* SquireWorkspace.refuseSquireWorkspacePath(stateDir, workspace).pipe(
        Effect.flip,
      );
      assert.equal(refused.message, "This folder belongs to a Squire.");
      yield* SquireWorkspace.refuseSquireWorkspacePath(stateDir, project);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
