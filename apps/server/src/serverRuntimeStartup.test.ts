import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
} from "@lecturn/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { symlinksSupported } from "@lecturn/shared/testing/symlinks";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

const autoPullOverrides = (entries: Record<string, boolean>) => ({
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsOverrides: Object.fromEntries(
    Object.entries(entries).map(([root, defaultAutoPull]) => [
      ProjectId.make(root),
      { defaultAutoPull },
    ]),
  ),
});

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const statusChecked: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.sync(() => {
          statusChecked.push(cwd);
          return {
            isRepo: true,
            isDefaultBranch: cwd !== "/feature",
            hasUpstream: true,
            hasWorkingTreeChanges: cwd === "/dirty",
            aheadCount: cwd === "/ahead" ? 1 : 0,
            behindCount: cwd === "/current" ? 0 : 1,
          } as never;
        }),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string, stave: unknown = undefined) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot, stave }) as never;

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
        // A Stave space root is not a repo; it is refused before any git call.
        project("/stave", { spaceId: "s", isSaga: false, repos: [], memories: [] }),
      ],
      autoPullOverrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
        "/stave": true,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);
    assert.isFalse(statusChecked.includes("/stave"));
    assert.isFalse(statusChecked.includes("/disabled"));

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/inherited"),
        project("/opted-out"),
        project("/dirty"),
        project("/stave-inherited", { spaceId: "s", isSaga: false, repos: [], memories: [] }),
      ],
      { ...autoPullOverrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
    assert.isFalse(statusChecked.includes("/stave-inherited"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const [projectCount, enabledCount] of [
  [10, 10],
  [10, 1],
  [20, 10],
  [10, 0],
] as const) {
  it.effect(
    `startup ownership filesystem reads stay bounded (${enabledCount}/${projectCount} enabled)`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
        const projects = Array.from({ length: projectCount }, (_, index) => {
          const workspaceRoot = path.join(root, `project-${index}`);
          return {
            id: ProjectId.make(workspaceRoot),
            title: workspaceRoot,
            workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            autoPull: index < enabledCount,
            stave: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          } satisfies OrchestrationProjectShell;
        });
        yield* Effect.forEach(projects, (project) => fs.makeDirectory(project.workspaceRoot));
        const manifestReads: string[] = [];
        let canonicalReads = 0;
        let ceilingReads = 0;
        const checked: string[] = [];
        yield* ServerRuntimeStartup.autoPullProjects(
          projects,
          autoPullOverrides(
            Object.fromEntries(
              projects.map((project) => [project.workspaceRoot, project.autoPull]),
            ),
          ),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, encoding) =>
              Effect.sync(() => manifestReads.push(file)).pipe(
                Effect.andThen(fs.readFileString(file, encoding)),
              ),
            realPath: (file) =>
              Effect.sync(() => canonicalReads++).pipe(Effect.andThen(fs.realPath(file))),
            exists: (file) =>
              Effect.sync(() => ceilingReads++).pipe(Effect.andThen(fs.exists(file))),
          }),
          Effect.provide(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              statusDetails: (cwd) =>
                Effect.sync(() => {
                  checked.push(cwd);
                  return {
                    isRepo: true,
                    hasOriginRemote: true,
                    isDefaultBranch: true,
                    branch: "main",
                    upstreamRef: "origin/main",
                    hasUpstream: true,
                    hasWorkingTreeChanges: false,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                    aheadCount: 0,
                    behindCount: 0,
                    aheadOfDefaultCount: 0,
                  };
                }),
            }),
          ),
        );
        assert.deepStrictEqual(
          manifestReads,
          enabledCount === 0
            ? []
            : projects.map((project) => path.join(project.workspaceRoot, ".stave.yaml")),
        );
        assert.strictEqual(canonicalReads, enabledCount === 0 ? 0 : projectCount + enabledCount);
        assert.strictEqual(checked.length, enabledCount);
        assert.isAtMost(ceilingReads, enabledCount * (root.split(path.sep).length + 1));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("startup automatic pulls fail closed when the manifest ceiling cannot be checked", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const checked: string[] = [];
    yield* ServerRuntimeStartup.autoPullProjects(
      [
        {
          id: ProjectId.make(root),
          title: root,
          workspaceRoot: root,
          defaultModelSelection: null,
          scripts: [],
          autoPull: true,
          stave: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      autoPullOverrides({ [root]: true }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        exists: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "exists",
              description: "Ownership lookup unavailable",
            }),
          ),
      }),
      Effect.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetails: (cwd) =>
            Effect.sync(() => checked.push(cwd)).pipe(
              Effect.andThen(Effect.die("Ownership failure must prevent Git status lookup")),
            ),
        }),
      ),
    );
    assert.deepStrictEqual(checked, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const ownerMetadata of [true, false, null]) {
  it.effect(
    `inherited startup pulls respect separately registered Stave ownership (metadata: ${ownerMetadata})`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const space = path.join(root, "space");
        const ownerAlias = path.join(root, "aliases", "space");
        const repo = path.join(space, "repo");
        const alias = path.join(root, "alias");
        const ordinary = path.join(root, "space-other");
        const external = path.join(root, "external");
        const externalAlias = path.join(root, "external-alias");
        const unrelated = path.join(root, "aliases", "external");
        yield* fs.makeDirectory(unrelated, { recursive: true });
        yield* fs.makeDirectory(external);
        yield* fs.makeDirectory(path.join(repo, "src"), { recursive: true });
        yield* fs.makeDirectory(ordinary);
        if (symlinksSupported) {
          yield* fs.makeDirectory(path.dirname(ownerAlias), { recursive: true });
          yield* fs.symlink(space, ownerAlias);
          yield* fs.symlink(repo, alias);
          yield* fs.symlink(external, externalAlias);
        }
        if (!ownerMetadata) {
          yield* fs.writeFileString(
            path.join(space, ".stave.yaml"),
            "version: 2\nid: space\nrepos:\n  - name: repo\n    path: repo\n    mode: edit\n  - name: external\n    path: ../external\n    mode: edit\nmemories: []\n",
          );
        }
        const project = (workspaceRoot: string): OrchestrationProjectShell => ({
          id: ProjectId.make(workspaceRoot),
          title: workspaceRoot,
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          autoPull: false,
          stave: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const checked: string[] = [];
        const pulled: string[] = [];
        yield* ServerRuntimeStartup.autoPullProjects(
          [
            project(repo),
            project(path.join(repo, "src")),
            ...(ownerMetadata === null ? [] : [project(external)]),
            ...(symlinksSupported
              ? [
                  project(alias),
                  project(path.join(alias, "missing")),
                  ...(ownerMetadata === null ? [] : [project(externalAlias)]),
                ]
              : []),
            ...(ownerMetadata === null
              ? []
              : [
                  {
                    ...project(symlinksSupported ? ownerAlias : space),
                    stave: ownerMetadata
                      ? {
                          spaceId: "space",
                          isSaga: false,
                          repos: [
                            { name: "external", path: "../external", mode: "edit" },
                            { name: "repo", path: "repo", mode: "edit" },
                          ],
                          memories: [],
                          primaryRepoPath: symlinksSupported ? unrelated : external,
                        }
                      : null,
                  } satisfies OrchestrationProjectShell,
                ]),
            project(ordinary),
            project(unrelated),
          ],
          { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true },
        ).pipe(
          Effect.provide(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              statusDetails: (cwd) =>
                Effect.sync(() => {
                  checked.push(cwd);
                  return {
                    isRepo: true,
                    hasOriginRemote: true,
                    isDefaultBranch: true,
                    branch: "main",
                    upstreamRef: "origin/main",
                    hasUpstream: true,
                    hasWorkingTreeChanges: false,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                    aheadCount: 0,
                    behindCount: 1,
                    aheadOfDefaultCount: 0,
                  };
                }),
              pullCurrentBranch: (cwd) =>
                Effect.sync(() => {
                  pulled.push(cwd);
                  return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
                }),
            }),
          ),
        );
        assert.deepStrictEqual(checked, [ordinary, unrelated]);
        assert.deepStrictEqual(pulled, [ordinary, unrelated]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        listThreadLifecycleAnchorsByProjectId: () => Effect.succeed([]),
        listActiveProjectRootsUnder: () => Effect.succeed([]),
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: DEFAULT_MODEL,
              },
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        listThreadActivitiesById: () => Effect.die("unused"),
        getInferenceTurnPairs: () => Effect.succeed([]),
        listThreadTurnsById: () => Effect.die("unused"),
        getThreadForkContextById: () => Effect.die("unused"),
        getThreadImportSourceById: () => Effect.die("unused"),
        listThreadImportSources: () => Effect.die("unused"),
        listThreadIdsByWorktreePath: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
      bootstrapProjectCreated: false,
      bootstrapThreadCreated: false,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect.each([
  {
    existing: false,
    machineModel: null,
    projectModel: null,
    machineMode: "full-access",
    projectMode: null,
  },
  {
    existing: false,
    machineModel: "claude-sonnet-4-6",
    projectModel: null,
    machineMode: "approval-required",
    projectMode: null,
  },
  {
    existing: true,
    machineModel: "claude-sonnet-4-6",
    projectModel: null,
    machineMode: "auto",
    projectMode: null,
  },
  {
    existing: true,
    machineModel: "claude-sonnet-4-6",
    projectModel: "gpt-5.4",
    machineMode: "full-access",
    projectMode: "auto-accept-edits",
  },
] as const)("auto-bootstrap model and permissions precedence: %j", (options) =>
  Effect.gen(function* () {
    const { existing, machineModel, projectModel, machineMode, projectMode } = options;
    const machineSelection = machineModel
      ? { instanceId: ProviderInstanceId.make("claude-code"), model: machineModel }
      : null;
    const projectSelection = projectModel
      ? { instanceId: ProviderInstanceId.make("codex"), model: projectModel }
      : null;
    const dispatchCalls = yield* Ref.make<
      ReadonlyArray<{
        readonly type: string;
        readonly defaultModelSelection?: unknown;
        readonly modelSelection?: unknown;
        readonly runtimeMode?: unknown;
      }>
    >([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(
        ServerSettings.layerTest({
          defaultModelSelection: machineSelection,
          defaultRuntimeMode: machineMode,
          projectSettingsOverrides:
            existing && projectSelection
              ? {
                  [ProjectId.make("existing-project")]: {
                    defaultModelSelection: projectSelection,
                    ...(projectMode ? { defaultRuntimeMode: projectMode } : {}),
                  },
                }
              : {},
        }),
      ),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        listThreadLifecycleAnchorsByProjectId: () => Effect.succeed([]),
        listActiveProjectRootsUnder: () => Effect.succeed([]),
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            existing
              ? Option.some({
                  id: ProjectId.make("existing-project"),
                  title: "Startup Project",
                  workspaceRoot: "/tmp/startup-project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  deletedAt: null,
                })
              : Option.none(),
          ),
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        listThreadActivitiesById: () => Effect.die("unused"),
        getInferenceTurnPairs: () => Effect.succeed([]),
        listThreadTurnsById: () => Effect.die("unused"),
        getThreadForkContextById: () => Effect.die("unused"),
        getThreadImportSourceById: () => Effect.die("unused"),
        listThreadImportSources: () => Effect.die("unused"),
        listThreadIdsByWorktreePath: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.equal(targets.bootstrapProjectCreated, !existing);
    assert.equal(targets.bootstrapThreadCreated, true);
    const commands = yield* Ref.get(dispatchCalls);
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      existing ? ["thread.create"] : ["project.create", "thread.create"],
    );
    if (!existing) assert.equal("defaultModelSelection" in commands[0]!, false);
    assert.equal(commands.at(-1)?.runtimeMode, projectMode ?? machineMode);
    assert.deepStrictEqual(
      commands.at(-1)?.modelSelection,
      projectSelection ??
        machineSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
    );
  }),
);

it.effect(
  "resolveAutoBootstrapWelcomeTargets preserves a project created before thread failure",
  () =>
    Effect.gen(function* () {
      const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
        Effect.provide(ServerSettings.layerTest()),
        Effect.provideService(ServerConfig.ServerConfig, {
          cwd: "/tmp/startup-project",
          autoBootstrapProjectFromCwd: true,
        } as never),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getUserInputActivity: () => Effect.die("unused"),
          listActivitiesByKind: () => Effect.succeed([]),
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getEventReplayStats: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShells: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("thread lookup failed"),
          getImportedAgentSessionSources: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadRuntimeContext: () => Effect.die("unused"),
          getTurnStartMessage: () => Effect.die("unused"),
          getThreadShellById: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
          searchThreads: () => Effect.succeed({ matches: [] }),
          listThreadLifecycleAnchorsByProjectId: () => Effect.die("unused"),
          listActiveProjectRootsUnder: () => Effect.die("unused"),
          listThreadActivitiesById: () => Effect.die("unused"),
          getInferenceTurnPairs: () => Effect.die("unused"),
          listThreadTurnsById: () => Effect.die("unused"),
          getThreadForkContextById: () => Effect.die("unused"),
          getThreadImportSourceById: () => Effect.die("unused"),
          listThreadImportSources: () => Effect.die("unused"),
          listThreadIdsByWorktreePath: () => Effect.die("unused"),
        }),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused thread replay stats"),
          dispatch: (command) =>
            Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
              Effect.as({ sequence: 1 }),
            ),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
        Effect.provide(NodeServices.layer),
      );

      assert.equal(typeof targets.bootstrapProjectId, "string");
      assert.equal(targets.bootstrapProjectCreated, true);
      assert.equal(targets.bootstrapThreadId, undefined);
      assert.equal(targets.bootstrapThreadCreated, undefined);
      assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create"]);
    }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        listThreadLifecycleAnchorsByProjectId: () => Effect.succeed([]),
        listActiveProjectRootsUnder: () => Effect.succeed([]),
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        listThreadActivitiesById: () => Effect.die("unused"),
        getInferenceTurnPairs: () => Effect.succeed([]),
        listThreadTurnsById: () => Effect.die("unused"),
        getThreadForkContextById: () => Effect.die("unused"),
        getThreadImportSourceById: () => Effect.die("unused"),
        listThreadImportSources: () => Effect.die("unused"),
        listThreadIdsByWorktreePath: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("completeAutoBootstrapWelcome settles failures without bootstrap targets", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.fail("bootstrap failed"),
    );

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome settles unexpected defects", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.die("bootstrap defect"),
    );

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome settles an empty bootstrap result", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(Effect.succeed({}));

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);
