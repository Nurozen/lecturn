// @effect-diagnostics nodeBuiltinImport:off -- filesystem alias boundary test
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path } from "effect";
import * as Duration from "effect/Duration";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isPathUnder, layer, StaveSpaceLock } from "./StaveSpaceLock.ts";

const testLayer = layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("Stave space lock roots", () => {
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
          const refused = yield* lock.withSharedSpaceLock(
            alias,
            Effect.die("must not run"),
            Duration.zero,
          );
          expect(Option.isNone(refused)).toBe(true);
          expect(
            yield* lock.withSharedSpaceLock(
              path.join(root, "other"),
              Effect.succeed("ok"),
              Duration.zero,
            ),
          ).toEqual(Option.some("ok"));
        }),
      );
      expect(
        yield* lock.withSharedSpaceLock(alias, Effect.succeed("released"), Duration.zero),
      ).toEqual(Option.some("released"));
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
              yield* lock.withSharedSpaceLock(
                path.join(root, "alias", "future"),
                Effect.die("must not run"),
                Duration.zero,
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
      expect(
        yield* lock
          .withSharedSpaceLock(root, Effect.fail("failed"), Duration.zero)
          .pipe(Effect.flip),
      ).toBe("failed");
      const acquired = yield* Deferred.make<void>();
      const running = yield* lock
        .withSharedSpaceLock(
          root,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)),
          Duration.zero,
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      expect(Option.isNone(yield* lock.tryWithWorkspaceLocks([root], Effect.void))).toBe(true);
      yield* Fiber.interrupt(running);
      expect(yield* lock.tryWithWorkspaceLocks([root], Effect.succeed("released"))).toEqual(
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
            expect(
              Option.isNone(yield* lock.withSharedSpaceLock(root, Effect.void, Duration.zero)),
            ).toBe(true);
            return "committed";
          }),
        ),
      ).toEqual(Option.some("committed"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

// Canonicalization falls back to `path.resolve` synchronously, so a fiber
// forked with `startImmediately` is already queued when the fork returns.
const syncLayer = layer.pipe(Layer.provide(Layer.mergeAll(FileSystem.layerNoop({}), Path.layer)));

const holder = (
  lock: StaveSpaceLock["Service"],
  root: string,
  mode: "shared" | "exclusive",
  log: Array<string>,
  name: string,
  wait?: Duration.Input,
) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const body = Effect.sync(() => log.push(name)).pipe(
      Effect.andThen(Deferred.succeed(entered, undefined)),
      Effect.andThen(Deferred.await(release)),
    );
    const fiber = yield* (
      mode === "exclusive"
        ? Effect.asSome(lock.withSpaceLock(root, body))
        : lock.withSharedSpaceLock(root, body, wait)
    ).pipe(Effect.forkChild({ startImmediately: true }));
    return { entered, release: Deferred.succeed(release, undefined), fiber };
  });

describe("Stave space read/write lock", () => {
  it.effect("lets shared holders overlap and keeps writers out until all leave", () =>
    Effect.gen(function* () {
      const lock = yield* StaveSpaceLock;
      const log: Array<string> = [];
      const first = yield* holder(lock, "/spaces/a", "shared", log, "first");
      const second = yield* holder(lock, "/spaces/a", "shared", log, "second");
      yield* Deferred.await(first.entered);
      yield* Deferred.await(second.entered);
      expect(Option.isNone(yield* lock.tryWithWorkspaceLocks(["/spaces/a"], Effect.void))).toBe(
        true,
      );
      expect(yield* lock.tryWithWorkspaceLocks(["/spaces/b"], Effect.succeed("other"))).toEqual(
        Option.some("other"),
      );
      yield* first.release;
      yield* Fiber.join(first.fiber);
      expect(Option.isNone(yield* lock.tryWithWorkspaceLocks(["/spaces/a"], Effect.void))).toBe(
        true,
      );
      yield* second.release;
      yield* Fiber.join(second.fiber);
      expect(yield* lock.tryWithWorkspaceLocks(["/spaces/a"], Effect.succeed("free"))).toEqual(
        Option.some("free"),
      );
    }).pipe(Effect.provide(syncLayer)),
  );

  it.effect("queues readers behind a waiting writer so the writer is not starved", () =>
    Effect.gen(function* () {
      const lock = yield* StaveSpaceLock;
      const log: Array<string> = [];
      const reader = yield* holder(lock, "/spaces/a", "shared", log, "reader");
      const writer = yield* holder(lock, "/spaces/a", "exclusive", log, "writer");
      const late = yield* holder(lock, "/spaces/a", "shared", log, "late reader", "5 seconds");
      expect(log).toEqual(["reader"]);
      // A newcomer that will not wait is turned away rather than overtaking the writer.
      expect(
        Option.isNone(yield* lock.withSharedSpaceLock("/spaces/a", Effect.void, Duration.zero)),
      ).toBe(true);
      yield* reader.release;
      yield* Deferred.await(writer.entered);
      expect(log).toEqual(["reader", "writer"]);
      yield* writer.release;
      yield* Deferred.await(late.entered);
      yield* late.release;
      expect(yield* Fiber.join(late.fiber)).toEqual(Option.some(undefined));
      expect(log).toEqual(["reader", "writer", "late reader"]);
    }).pipe(Effect.provide(syncLayer)),
  );

  it.effect("gives up a timed-out shared wait without leaking a place in the queue", () =>
    Effect.gen(function* () {
      const lock = yield* StaveSpaceLock;
      const log: Array<string> = [];
      const writer = yield* holder(lock, "/spaces/a", "exclusive", log, "writer");
      const reader = yield* holder(lock, "/spaces/a", "shared", log, "reader", "5 seconds");
      yield* TestClock.adjust("4999 millis");
      expect(log).toEqual(["writer"]);
      yield* TestClock.adjust("1 millis");
      expect(Option.isNone(yield* Fiber.join(reader.fiber))).toBe(true);
      yield* writer.release;
      yield* Fiber.join(writer.fiber);
      expect(log).toEqual(["writer"]);
      expect(
        yield* lock.withSharedSpaceLock("/spaces/a", Effect.succeed("free"), Duration.zero),
      ).toEqual(Option.some("free"));
    }).pipe(Effect.provide(syncLayer)),
  );

  it.effect("lets queued readers in when the writer ahead of them is interrupted", () =>
    Effect.gen(function* () {
      const lock = yield* StaveSpaceLock;
      const log: Array<string> = [];
      const reader = yield* holder(lock, "/spaces/a", "shared", log, "reader");
      const writer = yield* holder(lock, "/spaces/a", "exclusive", log, "writer");
      const queued = yield* holder(lock, "/spaces/a", "shared", log, "queued reader");
      yield* Fiber.interrupt(writer.fiber);
      yield* Deferred.await(queued.entered);
      expect(log).toEqual(["reader", "queued reader"]);
      yield* reader.release;
      yield* queued.release;
      yield* Fiber.join(queued.fiber);
      expect(yield* lock.tryWithWorkspaceLocks(["/spaces/a"], Effect.succeed("free"))).toEqual(
        Option.some("free"),
      );
    }).pipe(Effect.provide(syncLayer)),
  );

  it.effect("runs a nested shared admission at once even with a writer waiting", () =>
    Effect.gen(function* () {
      const lock = yield* StaveSpaceLock;
      const log: Array<string> = [];
      const writerQueued = yield* Deferred.make<void>();
      const outer = yield* lock
        .withSharedSpaceLock(
          "/spaces/a",
          Effect.gen(function* () {
            yield* Deferred.await(writerQueued);
            return yield* lock.withSharedSpaceLock(
              "/spaces/a/../a",
              Effect.succeed("nested"),
              Duration.zero,
            );
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      const writer = yield* holder(lock, "/spaces/a", "exclusive", log, "writer");
      yield* Deferred.succeed(writerQueued, undefined);
      expect(yield* Fiber.join(outer)).toEqual(Option.some(Option.some("nested")));
      yield* Deferred.await(writer.entered);
      yield* writer.release;
      yield* Fiber.join(writer.fiber);
    }).pipe(Effect.provide(syncLayer)),
  );

  it.effect("makes a forked child that re-enters after its parent released acquire the lock", () =>
    Effect.gen(function* () {
      const lock = yield* StaveSpaceLock;
      const log: Array<string> = [];
      const go = yield* Deferred.make<void>();
      const tried = yield* Deferred.make<Option.Option<void>>();
      const child = yield* lock
        .withSharedSpaceLock(
          "/spaces/a",
          Effect.forkDetach(
            Effect.gen(function* () {
              yield* Deferred.await(go);
              yield* Deferred.succeed(
                tried,
                yield* lock.withSharedSpaceLock("/spaces/a", Effect.void, Duration.zero),
              );
              return yield* lock.withSharedSpaceLock(
                "/spaces/a",
                Effect.sync(() => log.push("child")),
              );
            }),
          ),
        )
        .pipe(Effect.map(Option.getOrThrow));
      const writer = yield* holder(lock, "/spaces/a", "exclusive", log, "writer");
      yield* Deferred.await(writer.entered);
      yield* Deferred.succeed(go, undefined);
      expect(Option.isNone(yield* Deferred.await(tried))).toBe(true);
      expect(log).toEqual(["writer"]);
      yield* writer.release;
      yield* Fiber.join(child);
      expect(log).toEqual(["writer", "child"]);
    }).pipe(Effect.provide(syncLayer)),
  );
});
