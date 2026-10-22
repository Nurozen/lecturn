import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Duration, Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import {
  SourceControlProviderKind,
  ProjectId,
  type OrchestrationProjectShell,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
} from "@lecturn/contracts";
import { symlinksSupported } from "@lecturn/shared/testing/symlinks";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { StaveProjectShells } from "../stave/StaveProjectShells.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";

const PROJECT_COUNT = 100;
const timestamp = "2026-01-01T00:00:00.000Z";
/** A project shell plus its deletion stamp (the V1 `OrchestrationProject` read shape). */
type OrchestrationProject = OrchestrationProjectShell & { readonly deletedAt: string | null };
const toShell = ({ deletedAt: _deletedAt, ...project }: OrchestrationProject) =>
  project satisfies OrchestrationProjectShell;
const toRow = (project: OrchestrationProject): ProjectStore.ProjectRow => ({
  projectId: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  defaultModelSelection: project.defaultModelSelection,
  defaultThreadEnvMode: null,
  autoPull: project.autoPull ?? false,
  faviconPath: null,
  projectIcon: null,
  scripts: project.scripts,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  deletedAt: project.deletedAt,
});

const makeFixture = Effect.fn("VcsAutoPullPolicy.test.makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-auto-pull-budget-" });
  const root = yield* fs.realPath(temporaryRoot);
  const projects: OrchestrationProject[] = Array.from({ length: PROJECT_COUNT }, (_, index) => ({
    id: ProjectId.make(`project-${index}`),
    title: `Project ${index}`,
    workspaceRoot: path.join(root, "repos", `checkout-${index}`),
    autoPull: true,
    stave: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  }));
  yield* Effect.forEach(
    projects,
    (project) =>
      fs.makeDirectory(project.workspaceRoot, {
        recursive: true,
      }),
    { concurrency: 4 },
  );

  const state = { projects, snapshotSequence: 1 };
  const calls = {
    realPath: new Map<string, number>(),
    readFileString: new Map<string, number>(),
    exists: new Map<string, number>(),
  };
  const failures = new Set<string>();
  const record = (operation: keyof typeof calls, filePath: string) => {
    const counter = calls[operation];
    counter.set(filePath, (counter.get(filePath) ?? 0) + 1);
    return failures.has(`${operation}:${filePath}`)
      ? Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: operation,
            pathOrDescriptor: filePath,
          }),
        )
      : Effect.void;
  };
  const countedFs = FileSystem.FileSystem.of({
    ...fs,
    realPath: (filePath) =>
      record("realPath", filePath).pipe(Effect.andThen(fs.realPath(filePath))),
    readFileString: (filePath, encoding) =>
      record("readFileString", filePath).pipe(
        Effect.andThen(fs.readFileString(filePath, encoding)),
      ),
    exists: (filePath) => record("exists", filePath).pipe(Effect.andThen(fs.exists(filePath))),
  });
  const policyLayer = VcsStatusBroadcaster.layerAutoPullPolicy.pipe(
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        findActiveByWorkspaceRoot: (cwd) =>
          Effect.sync(() =>
            Option.fromUndefinedOr(
              state.projects.find((project) => project.workspaceRoot === cwd),
            ).pipe(Option.map(toRow)),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(StaveProjectShells)({
        // A projection query rehydrates rows; cache reuse cannot rely on object identity.
        list: Effect.sync(() => state.projects.map(toShell)),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.succeed(FileSystem.FileSystem, countedFs)),
    Layer.provide(Layer.succeed(Path.Path, path)),
  );
  const manifest = (project: OrchestrationProject) =>
    path.join(project.workspaceRoot, ".stave.yaml");
  const manifestReads = () =>
    state.projects.reduce(
      (total, project) => total + (calls.readFileString.get(manifest(project)) ?? 0),
      0,
    );
  return { fs, path, root, state, calls, failures, policyLayer, manifest, manifestReads };
});

const ownerInfo = (repoPath: string) => ({
  spaceId: "owner",
  isSaga: false,
  repos: [{ name: "owned", path: repoPath, mode: "edit" as const }],
  memories: [],
});

it.layer(NodeServices.layer)("VcsAutoPullPolicy ownership cache", (it) => {
  it.effect(
    "shares one filesystem scan across 100 concurrent candidates and repeated thread updates",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Effect.gen(function* () {
          const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
          const checkAll = Effect.forEach(
            fixture.state.projects,
            (project) => policy.isEnabled(project.workspaceRoot),
            { concurrency: "unbounded" },
          );
          assert.deepStrictEqual(yield* checkAll, Array(PROJECT_COUNT).fill(true));
          assert.equal(fixture.manifestReads(), PROJECT_COUNT);

          fixture.state.snapshotSequence += 100;
          assert.deepStrictEqual(yield* checkAll, Array(PROJECT_COUNT).fill(true));
          assert.equal(fixture.manifestReads(), PROJECT_COUNT);
          for (const project of fixture.state.projects) {
            assert.equal(fixture.calls.readFileString.get(fixture.manifest(project)), 1);
            assert.isAtLeast(fixture.calls.realPath.get(project.workspaceRoot) ?? 0, 2);
            assert.isAtLeast(fixture.calls.exists.get(fixture.manifest(project)) ?? 0, 2);
          }
          const realPaths = [...fixture.calls.realPath.values()].reduce(
            (sum, count) => sum + count,
            0,
          );
          assert.isAtMost(realPaths, PROJECT_COUNT * 4);
        }).pipe(Effect.provide(fixture.policyLayer));
      }),
  );

  it.effect(
    "expires at 30 seconds and shares the refreshed scan across concurrent candidates",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Effect.gen(function* () {
          const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
          const cwd = fixture.state.projects[0]!.workspaceRoot;
          assert.isTrue(yield* policy.isEnabled(cwd));
          assert.equal(fixture.manifestReads(), PROJECT_COUNT);
          yield* TestClock.adjust(Duration.seconds(29));
          assert.isTrue(yield* policy.isEnabled(cwd));
          assert.equal(fixture.manifestReads(), PROJECT_COUNT);
          yield* TestClock.adjust(Duration.seconds(1));
          const results = yield* Effect.forEach(
            fixture.state.projects,
            (project) => policy.isEnabled(project.workspaceRoot),
            { concurrency: "unbounded" },
          );
          assert.deepStrictEqual(results, Array(PROJECT_COUNT).fill(true));
          assert.equal(fixture.manifestReads(), PROJECT_COUNT * 2);
        }).pipe(Effect.provide(fixture.policyLayer));
      }),
  );

  it.effect("invalidates immediately when Stave metadata is added, changed, or removed", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = fixture.state.projects[0]!;
      const second = fixture.state.projects[1]!;
      const owner = fixture.state.projects[PROJECT_COUNT - 1]!;
      yield* Effect.gen(function* () {
        const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
        assert.isTrue(yield* policy.isEnabled(first.workspaceRoot));
        fixture.state.projects[PROJECT_COUNT - 1] = { ...owner, stave: ownerInfo("../checkout-0") };
        assert.isFalse(yield* policy.isEnabled(first.workspaceRoot));
        fixture.state.projects[PROJECT_COUNT - 1] = { ...owner, stave: ownerInfo("../checkout-1") };
        assert.isTrue(yield* policy.isEnabled(first.workspaceRoot));
        assert.isFalse(yield* policy.isEnabled(second.workspaceRoot));
        fixture.state.projects[PROJECT_COUNT - 1] = owner;
        assert.isTrue(yield* policy.isEnabled(second.workspaceRoot));
        assert.equal(fixture.state.snapshotSequence, 1);
      }).pipe(Effect.provide(fixture.policyLayer));
    }),
  );

  it.effect("invalidates immediately when a registered ownership root moves", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const target = fixture.state.projects[0]!;
      const owner = fixture.state.projects[PROJECT_COUNT - 1]!;
      fixture.state.projects[PROJECT_COUNT - 1] = { ...owner, stave: ownerInfo(".") };
      yield* Effect.gen(function* () {
        const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
        assert.isTrue(yield* policy.isEnabled(target.workspaceRoot));
        fixture.state.projects[PROJECT_COUNT - 1] = {
          ...owner,
          workspaceRoot: fixture.path.dirname(target.workspaceRoot),
          stave: ownerInfo("."),
        };
        assert.isFalse(yield* policy.isEnabled(target.workspaceRoot));
        fixture.state.projects[PROJECT_COUNT - 1] = { ...owner, stave: ownerInfo(".") };
        assert.isTrue(yield* policy.isEnabled(target.workspaceRoot));
        assert.equal(fixture.state.snapshotSequence, 1);
      }).pipe(Effect.provide(fixture.policyLayer));
    }),
  );

  it.effect("checks ancestor manifests afresh even when the prepared scan is still cached", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const cwd = fixture.state.projects[0]!.workspaceRoot;
      const ceiling = fixture.path.join(fixture.path.dirname(cwd), ".stave.yaml");
      yield* Effect.gen(function* () {
        const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
        assert.isTrue(yield* policy.isEnabled(cwd));
        yield* fixture.fs.writeFileString(ceiling, "version: 2\nid: ceiling\nrepos: []\n");
        assert.isFalse(yield* policy.isEnabled(cwd));
        yield* fixture.fs.remove(ceiling);
        assert.isTrue(yield* policy.isEnabled(cwd));
        assert.equal(fixture.manifestReads(), PROJECT_COUNT);
      }).pipe(Effect.provide(fixture.policyLayer));
    }),
  );

  it.effect.each(["realPath", "exists"] as const)(
    "fails closed on a fresh candidate %s error after warming the cache",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const cwd = fixture.state.projects[0]!.workspaceRoot;
        const failedPath = operation === "realPath" ? cwd : fixture.path.join(cwd, ".stave.yaml");
        yield* Effect.gen(function* () {
          const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
          assert.isTrue(yield* policy.isEnabled(cwd));
          fixture.failures.add(`${operation}:${failedPath}`);
          assert.isFalse(yield* policy.isEnabled(cwd));
          fixture.failures.clear();
          assert.isTrue(yield* policy.isEnabled(cwd));
        }).pipe(Effect.provide(fixture.policyLayer));
      }),
  );

  it.effect("fails closed when a TTL refresh cannot read a registered ownership manifest", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const cwd = fixture.state.projects[0]!.workspaceRoot;
      const ownerManifest = fixture.manifest(fixture.state.projects[PROJECT_COUNT - 1]!);
      yield* Effect.gen(function* () {
        const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
        assert.isTrue(yield* policy.isEnabled(cwd));
        fixture.failures.add(`readFileString:${ownerManifest}`);
        yield* TestClock.adjust(Duration.seconds(30));
        assert.isFalse(yield* policy.isEnabled(cwd));
        fixture.failures.clear();
        yield* TestClock.adjust(Duration.seconds(30));
        assert.isTrue(yield* policy.isEnabled(cwd));
      }).pipe(Effect.provide(fixture.policyLayer));
    }),
  );

  it.effect.each([
    "version: [invalid",
    "version: 2\nid: owner\nrepos: wrong\n",
    "version: 2\nid: \nrepos: []\n",
  ])("fails closed when a registered ownership manifest cannot be decoded: %s", (content) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const cwd = fixture.state.projects[0]!.workspaceRoot;
      const ownerManifest = fixture.manifest(fixture.state.projects[PROJECT_COUNT - 1]!);
      yield* Effect.gen(function* () {
        const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
        assert.isTrue(yield* policy.isEnabled(cwd));
        yield* fixture.fs.writeFileString(ownerManifest, content);
        yield* TestClock.adjust(Duration.seconds(30));
        assert.isFalse(yield* policy.isEnabled(cwd));
        yield* fixture.fs.remove(ownerManifest);
        yield* TestClock.adjust(Duration.seconds(30));
        assert.isTrue(yield* policy.isEnabled(cwd));
      }).pipe(Effect.provide(fixture.policyLayer));
    }),
  );

  it.effect("recognizes external membership manifest creation, edits, and removal by the TTL", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const cwd = fixture.state.projects[0]!.workspaceRoot;
      const secondCwd = fixture.state.projects[1]!.workspaceRoot;
      const ownerManifest = fixture.manifest(fixture.state.projects[PROJECT_COUNT - 1]!);
      yield* Effect.gen(function* () {
        const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
        assert.isTrue(yield* policy.isEnabled(cwd));
        yield* fixture.fs.writeFileString(
          ownerManifest,
          "version: 2\nid: owner\nrepos:\n  - name: owned\n    path: ../checkout-0\n    mode: edit\nmemories: []\n",
        );
        yield* TestClock.adjust(Duration.seconds(29));
        assert.isTrue(yield* policy.isEnabled(cwd));
        yield* TestClock.adjust(Duration.seconds(1));
        assert.isFalse(yield* policy.isEnabled(cwd));
        yield* fixture.fs.writeFileString(
          ownerManifest,
          "version: 2\nid: owner\nrepos:\n  - name: owned\n    path: ../checkout-1\n    mode: edit\nmemories: []\n",
        );
        assert.isFalse(yield* policy.isEnabled(cwd));
        assert.isTrue(yield* policy.isEnabled(secondCwd));
        yield* TestClock.adjust(Duration.seconds(30));
        assert.isTrue(yield* policy.isEnabled(cwd));
        assert.isFalse(yield* policy.isEnabled(secondCwd));
        yield* fixture.fs.remove(ownerManifest);
        assert.isFalse(yield* policy.isEnabled(secondCwd));
        yield* TestClock.adjust(Duration.seconds(30));
        assert.isTrue(yield* policy.isEnabled(secondCwd));
      }).pipe(Effect.provide(fixture.policyLayer));
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "recognizes an ownership repo symlink retarget by the TTL",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = fixture.state.projects[0]!;
        const second = fixture.state.projects[1]!;
        const owner = fixture.state.projects[PROJECT_COUNT - 1]!;
        const alias = fixture.path.join(fixture.root, "owned-alias");
        yield* fixture.fs.symlink(first.workspaceRoot, alias);
        fixture.state.projects[PROJECT_COUNT - 1] = { ...owner, stave: ownerInfo(alias) };
        yield* Effect.gen(function* () {
          const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
          assert.isFalse(yield* policy.isEnabled(first.workspaceRoot));
          assert.isTrue(yield* policy.isEnabled(second.workspaceRoot));
          yield* fixture.fs.remove(alias);
          yield* fixture.fs.symlink(second.workspaceRoot, alias);
          yield* TestClock.adjust(Duration.seconds(30));
          assert.isTrue(yield* policy.isEnabled(first.workspaceRoot));
          assert.isFalse(yield* policy.isEnabled(second.workspaceRoot));
        }).pipe(Effect.provide(fixture.policyLayer));
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rechecks the candidate symlink immediately without rescanning projects",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const target = fixture.state.projects[0]!;
        const owner = fixture.state.projects[PROJECT_COUNT - 1]!;
        const alias = fixture.path.join(fixture.root, "candidate-alias");
        yield* fixture.fs.symlink(target.workspaceRoot, alias);
        fixture.state.projects[0] = { ...target, workspaceRoot: alias };
        fixture.state.projects[PROJECT_COUNT - 1] = { ...owner, stave: ownerInfo(".") };
        yield* Effect.gen(function* () {
          const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
          assert.isTrue(yield* policy.isEnabled(alias));
          const reads = fixture.manifestReads();
          yield* fixture.fs.remove(alias);
          yield* fixture.fs.symlink(owner.workspaceRoot, alias);
          assert.isFalse(yield* policy.isEnabled(alias));
          assert.equal(fixture.manifestReads(), reads);
        }).pipe(Effect.provide(fixture.policyLayer));
      }),
  );
});

const localStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};
const currentRemote: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function makeBroadcasterFixture(remote: VcsStatusRemoteResult | null) {
  const state = { remote, remoteCalls: 0, policyCalls: 0, pulls: 0 };
  const testLayer = VcsStatusBroadcaster.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(true),
      }),
    ),
    Layer.provide(
      Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
        isEnabled: () =>
          Effect.sync(() => {
            state.policyCalls += 1;
            return true;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () => Effect.succeed(localStatus),
        remoteStatus: () =>
          Effect.sync(() => {
            state.remoteCalls += 1;
            return state.remote;
          }),
        invalidateLocalStatus: () => Effect.void,
        invalidateRemoteStatus: () => Effect.void,
        invalidateStatus: () => Effect.void,
        pullCurrentBranch: () =>
          Effect.sync(() => {
            state.pulls += 1;
            state.remote = currentRemote;
            return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
          }),
      }),
    ),
  );
  return { state, testLayer };
}

describe("VcsStatusBroadcaster automatic pull eligibility", () => {
  it.effect.each([
    ["null remote", null],
    ["no upstream", { ...currentRemote, hasUpstream: false, behindCount: 2 }],
    ["ahead branch", { ...currentRemote, aheadCount: 1, behindCount: 2 }],
    ["already-current branch", currentRemote],
  ] as const)(
    "skips ownership policy on repeated explicit and recurring %s passes",
    ([, remote]) => {
      const { state, testLayer } = makeBroadcasterFixture(remote);
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/repo" });
        yield* broadcaster.refreshStatus("/repo");
        yield* broadcaster.refreshStatus("/repo");
        assert.equal(state.remoteCalls, 3);
        assert.equal(state.policyCalls, 0);

        const snapshot = yield* Deferred.make<void>();
        yield* broadcaster
          .streamStatus(
            { cwd: "/repo" },
            {
              automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(30)),
            },
          )
          .pipe(
            Stream.runForEach((event) =>
              event._tag === "snapshot"
                ? Deferred.succeed(snapshot, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
        yield* Deferred.await(snapshot);
        for (let pass = 0; pass < 2; pass += 1) {
          yield* TestClock.adjust(Duration.seconds(30));
          yield* Effect.yieldNow;
          assert.equal(state.remoteCalls, 4 + pass);
          assert.equal(state.policyCalls, 0);
          assert.equal(state.pulls, 0);
        }
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect("consults policy and pulls an eligible default branch during a recurring pass", () => {
    const { state, testLayer } = makeBroadcasterFixture({ ...currentRemote, behindCount: 2 });
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const snapshot = yield* Deferred.make<void>();
      const pulled = yield* Deferred.make<void>();
      yield* broadcaster
        .streamStatus(
          { cwd: "/repo" },
          {
            automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(30)),
          },
        )
        .pipe(
          Stream.runForEach((event) =>
            event._tag === "snapshot"
              ? Deferred.succeed(
                  event.remote?.behindCount === 0 ? pulled : snapshot,
                  undefined,
                ).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
      yield* Deferred.await(snapshot);
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Deferred.await(pulled);
      assert.equal(state.policyCalls, 1);
      assert.equal(state.pulls, 1);
      assert.deepStrictEqual(state.remote, currentRemote);
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Effect.yieldNow;
      assert.equal(state.remoteCalls, 4);
      assert.equal(state.policyCalls, 1);
      assert.equal(state.pulls, 1);
    }).pipe(Effect.provide(testLayer));
  });
});
