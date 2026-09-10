// @effect-diagnostics nodeBuiltinImport:off -- filesystem alias boundary test
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isPathUnder, layer, StaveSpaceLock } from "./StaveSpaceLock.ts";

const testLayer = layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("Stave nonblocking space lock", () => {
  it.effect("refuses aliases of a held root without running work and admits unrelated roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const space = path.join(root, "space");
      const alias = path.join(root, "alias");
      yield* fs.makeDirectory(space);
      yield* fs.symlink(space, alias);
      const lock = yield* StaveSpaceLock;
      yield* lock.withSpaceLock(
        space,
        Effect.gen(function* () {
          const refused = yield* lock.tryWithSpaceLock(alias, Effect.die("must not run"));
          expect(Option.isNone(refused)).toBe(true);
          expect(
            yield* lock.tryWithSpaceLock(path.join(root, "other"), Effect.succeed("ok")),
          ).toEqual(Option.some("ok"));
        }),
      );
      expect(yield* lock.tryWithSpaceLock(alias, Effect.succeed("released"))).toEqual(
        Option.some("released"),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shares the canonical parent lock before a root exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, "parent"));
      yield* fs.symlink(path.join(root, "parent"), path.join(root, "alias"));
      const lock = yield* StaveSpaceLock;
      yield* lock.withSpaceLock(
        path.join(root, "parent", "future"),
        Effect.gen(function* () {
          expect(
            Option.isNone(
              yield* lock.tryWithSpaceLock(
                path.join(root, "alias", "future"),
                Effect.die("must not run"),
              ),
            ),
          ).toBe(true);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("releases a nonblocking permit after failure and interruption", () =>
    Effect.gen(function* () {
      const lock = yield* StaveSpaceLock;
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      expect(yield* lock.tryWithSpaceLock(root, Effect.fail("failed")).pipe(Effect.flip)).toBe(
        "failed",
      );
      const acquired = yield* Deferred.make<void>();
      const running = yield* lock
        .tryWithSpaceLock(
          root,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      expect(Option.isNone(yield* lock.tryWithSpaceLock(root, Effect.void))).toBe(true);
      yield* Fiber.interrupt(running);
      expect(yield* lock.tryWithSpaceLock(root, Effect.succeed("released"))).toEqual(
        Option.some("released"),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("Stave session root matching", () => {
  it.effect("matches descendants and aliases but excludes sibling prefixes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stave-path-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const space = NodePath.join(root, "demo");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(space, "repo"), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.symlink(space, NodePath.join(root, "alias")));
      expect(yield* isPathUnder(space, NodePath.join(space, "repo"))).toBe(true);
      expect(yield* isPathUnder(space, NodePath.join(root, "alias", "repo"))).toBe(true);
      expect(yield* isPathUnder(space, NodePath.join(root, "demo-two"))).toBe(false);
      expect(yield* isPathUnder(space, root)).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect(
  "workspace admission holds ancestor permits and recognizes missing descendants through aliases",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped();
      const root = path.join(parent, "space");
      const alias = path.join(parent, "alias");
      yield* fs.makeDirectory(root);
      yield* fs.symlink(parent, alias);
      const lock = yield* StaveSpaceLock;
      yield* lock.withSpaceLock(
        root,
        Effect.gen(function* () {
          yield* fs.remove(root, { recursive: true });
          expect(
            Option.isNone(
              yield* lock.tryWithWorkspaceLocks(
                [path.join(alias, "space", "repo", "missing")],
                Effect.die("must not commit"),
              ),
            ),
          ).toBe(true);
        }),
      );
      expect(
        yield* lock.tryWithWorkspaceLocks(
          [root, path.join(root, "repo")],
          Effect.gen(function* () {
            expect(Option.isNone(yield* lock.tryWithSpaceLock(root, Effect.void))).toBe(true);
            return "committed";
          }),
        ),
      ).toEqual(Option.some("committed"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
