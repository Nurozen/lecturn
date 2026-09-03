// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStore.layer", (it) => {
  describe("isGitRepository", () => {
    it.effect("returns false when no Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false);
      }),
    );

    it.effect("returns true when a Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true);
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = NodePath.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");
      }),
    );
  });

  describe("aliasCheckpointRefs", () => {
    it.effect("creates aliases resolving to the source commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const sourceThreadId = ThreadId.make("thread-alias-source");
        const childThreadId = ThreadId.make("thread-alias-child");
        const sourceRef0 = checkpointRefForThreadTurn(sourceThreadId, 0);
        const sourceRef1 = checkpointRefForThreadTurn(sourceThreadId, 1);
        const childRef0 = checkpointRefForThreadTurn(childThreadId, 0);
        const childRef1 = checkpointRefForThreadTurn(childThreadId, 1);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: sourceRef0 });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# test again\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: sourceRef1 });

        const created = yield* checkpointStore.aliasCheckpointRefs({
          cwd: tmp,
          refs: [
            { from: sourceRef0, to: childRef0 },
            { from: sourceRef1, to: childRef1 },
          ],
        });

        expect(created).toEqual([childRef0, childRef1]);
        expect(yield* git(tmp, ["rev-parse", childRef0])).toBe(
          yield* git(tmp, ["rev-parse", sourceRef0]),
        );
        expect(yield* git(tmp, ["rev-parse", childRef1])).toBe(
          yield* git(tmp, ["rev-parse", sourceRef1]),
        );
      }),
    );

    it.effect("skips pairs whose source ref does not resolve", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const sourceThreadId = ThreadId.make("thread-alias-missing-source");
        const childThreadId = ThreadId.make("thread-alias-missing-child");
        const presentRef = checkpointRefForThreadTurn(sourceThreadId, 0);
        const missingRef = checkpointRefForThreadTurn(sourceThreadId, 1);
        const childRef0 = checkpointRefForThreadTurn(childThreadId, 0);
        const childRef1 = checkpointRefForThreadTurn(childThreadId, 1);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: presentRef });

        const created = yield* checkpointStore.aliasCheckpointRefs({
          cwd: tmp,
          refs: [
            { from: presentRef, to: childRef0 },
            { from: missingRef, to: childRef1 },
          ],
        });

        expect(created).toEqual([childRef0]);
        expect(
          yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef: childRef0 }),
        ).toBe(true);
        expect(
          yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef: childRef1 }),
        ).toBe(false);
      }),
    );

    it.effect("is idempotent across repeated calls", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const sourceThreadId = ThreadId.make("thread-alias-idempotent-source");
        const childThreadId = ThreadId.make("thread-alias-idempotent-child");
        const sourceRef = checkpointRefForThreadTurn(sourceThreadId, 0);
        const childRef = checkpointRefForThreadTurn(childThreadId, 0);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: sourceRef });
        const sourceOid = yield* git(tmp, ["rev-parse", sourceRef]);

        const first = yield* checkpointStore.aliasCheckpointRefs({
          cwd: tmp,
          refs: [{ from: sourceRef, to: childRef }],
        });
        const second = yield* checkpointStore.aliasCheckpointRefs({
          cwd: tmp,
          refs: [{ from: sourceRef, to: childRef }],
        });

        expect(first).toEqual([childRef]);
        expect(second).toEqual([childRef]);
        expect(yield* git(tmp, ["rev-parse", childRef])).toBe(sourceOid);
      }),
    );

    it.effect("keeps aliases when the source refs are deleted", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const sourceThreadId = ThreadId.make("thread-alias-delete-source");
        const childThreadId = ThreadId.make("thread-alias-delete-child");
        const sourceRef = checkpointRefForThreadTurn(sourceThreadId, 0);
        const childRef = checkpointRefForThreadTurn(childThreadId, 0);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: sourceRef });
        const sourceOid = yield* git(tmp, ["rev-parse", sourceRef]);
        yield* checkpointStore.aliasCheckpointRefs({
          cwd: tmp,
          refs: [{ from: sourceRef, to: childRef }],
        });

        yield* checkpointStore.deleteCheckpointRefs({ cwd: tmp, checkpointRefs: [sourceRef] });

        expect(
          yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef: sourceRef }),
        ).toBe(false);
        expect(yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef: childRef })).toBe(
          true,
        );
        expect(yield* git(tmp, ["rev-parse", childRef])).toBe(sourceOid);
      }),
    );
  });
});
