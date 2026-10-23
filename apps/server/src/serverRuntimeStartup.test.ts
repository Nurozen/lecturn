import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
} from "@lecturn/contracts";
import { symlinksSupported } from "@lecturn/shared/testing/symlinks";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { PullRequestWatchDiscovery } from "./pullRequest/PullRequestWatchDiscovery.ts";
import { PullRequestWatchService } from "./pullRequest/PullRequestWatchService.ts";
import { StaveLifecycleService } from "./stave/lifecycle/StaveLifecycleService.ts";
import { SagaInferenceReactor } from "./stave/SagaInferenceReactor.ts";
import { DecisionIngestion } from "./threadDecisions/DecisionIngestion.ts";
import { DecisionWorker } from "./threadDecisions/DecisionWorker.ts";

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
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

it.effect.each([
  { projectCount: 10, enabledCount: 10 },
  { projectCount: 10, enabledCount: 1 },
  { projectCount: 20, enabledCount: 10 },
  { projectCount: 10, enabledCount: 0 },
] as const)(
  "startup ownership filesystem reads stay bounded ($enabledCount/$projectCount enabled)",
  ({ projectCount, enabledCount }) =>
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
          Object.fromEntries(projects.map((project) => [project.workspaceRoot, project.autoPull])),
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
          exists: (file) => Effect.sync(() => ceilingReads++).pipe(Effect.andThen(fs.exists(file))),
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

it.effect.each([{ ownerMetadata: true }, { ownerMetadata: false }, { ownerMetadata: null }])(
  "inherited startup pulls respect separately registered Stave ownership (metadata: $ownerMetadata)",
  ({ ownerMetadata }) =>
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

it.effect("starts the Lecturn background roots that are wired, in dependency order", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const record = (name: string) => Effect.sync(() => void calls.push(name));
    const workerStarted = yield* Deferred.make<void>();
    yield* ServerRuntimeStartup.startLecturnReactors.pipe(
      Effect.provideService(StaveLifecycleService, {
        start: () => record("stave.lifecycle"),
      } as unknown as StaveLifecycleService["Service"]),
      Effect.provideService(SagaInferenceReactor, {
        start: () => record("saga.inference"),
      } as unknown as SagaInferenceReactor["Service"]),
      Effect.provideService(DecisionIngestion, {
        start: record("decisions.ingestion"),
      } as unknown as DecisionIngestion["Service"]),
      Effect.provideService(DecisionWorker, {
        start: record("decisions.worker").pipe(
          Effect.andThen(Deferred.succeed(workerStarted, undefined)),
        ),
      } as unknown as DecisionWorker["Service"]),
      Effect.provideService(PullRequestWatchService, {
        start: record("pr.watches"),
      } as unknown as PullRequestWatchService["Service"]),
      Effect.provideService(PullRequestWatchDiscovery, {
        start: record("pr.discovery"),
      } as unknown as PullRequestWatchDiscovery["Service"]),
    );
    yield* Deferred.await(workerStarted);
    assert.deepStrictEqual(calls, [
      "stave.lifecycle",
      "saga.inference",
      "pr.watches",
      "pr.discovery",
      "decisions.ingestion",
      "decisions.worker",
    ]);
  }).pipe(Effect.scoped),
);
