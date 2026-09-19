import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@lecturn/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "lecturn-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/lecturn-index",
      },
      appendTruncationMarker: true,
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/lecturn-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

// `restoreCheckpoint` runs `git clean -fd` after restoring the target tree, so
// anything untracked the target does not bring back is deleted with no git
// object behind it. These cases pin the exact set the preview must report.
it.effect(
  "listRestoreDeletions separates untracked files the checkpoint restores from those it deletes",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "lecturn-restore-deletions-",
      });

      yield* runGit(cwd, ["init"]);
      yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "ignored.txt\n");
      yield* fileSystem.writeFileString(path.join(cwd, "tracked.txt"), "v1\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "base"]);

      const driver = yield* VcsDriver.VcsDriver;
      const checkpoints = driver.checkpoints;
      assert.ok(checkpoints, "git driver must expose checkpoint operations");

      const earlyRef = CheckpointRef.make("refs/lecturn/checkpoints/test/turn/1");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: earlyRef });

      // Untracked in the worktree, but captured into the later checkpoint because
      // capture stages everything non-ignored into an isolated index.
      yield* fileSystem.writeFileString(path.join(cwd, "will-return.txt"), "kept\n");
      const laterRef = CheckpointRef.make("refs/lecturn/checkpoints/test/turn/2");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: laterRef });

      yield* fileSystem.writeFileString(path.join(cwd, "hand-made.txt"), "at risk\n");
      yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "safe\n");

      const againstLater = yield* checkpoints.listRestoreDeletions({
        cwd,
        checkpointRef: laterRef,
      });
      // `will-return.txt` is in the target commit, so the restore recreates it.
      assert.deepStrictEqual([...againstLater.paths], ["hand-made.txt"]);
      assert.strictEqual(againstLater.truncated, false);

      const againstEarly = yield* checkpoints.listRestoreDeletions({
        cwd,
        checkpointRef: earlyRef,
      });
      // The earlier checkpoint predates `will-return.txt`, so it is lost too.
      assert.deepStrictEqual([...againstEarly.paths].toSorted(), [
        "hand-made.txt",
        "will-return.txt",
      ]);

      // Ignored files survive because the clean omits `-x`; they must never be
      // named in a warning that claims files will be deleted.
      assert.ok(!againstEarly.paths.includes("ignored.txt"));
    }).pipe(Effect.provide(GitContractLayer), Effect.scoped),
);

it.effect("listRestoreDeletions reports nothing when the checkpoint ref does not resolve", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "lecturn-restore-deletions-missing-",
    });

    yield* runGit(cwd, ["init"]);
    yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(cwd, "hand-made.txt"), "at risk\n");

    const driver = yield* VcsDriver.VcsDriver;
    const checkpoints = driver.checkpoints;
    assert.ok(checkpoints, "git driver must expose checkpoint operations");

    // A revert against a missing ref fails before it deletes anything, so the
    // preview must not claim files are at risk.
    const deletions = yield* checkpoints.listRestoreDeletions({
      cwd,
      checkpointRef: CheckpointRef.make("refs/lecturn/checkpoints/test/turn/9"),
    });
    assert.deepStrictEqual([...deletions.paths], []);
  }).pipe(Effect.provide(GitContractLayer), Effect.scoped),
);
