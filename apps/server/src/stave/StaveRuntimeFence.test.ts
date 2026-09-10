import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref } from "effect";
import { ProjectId } from "@t3tools/contracts";
import * as RuntimeFence from "./StaveRuntimeFence.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { StaveAdmission, StaveSpaceTransitioningError } from "./StaveAdmission.ts";

const virtualFs = FileSystem.makeNoop({ realPath: (path) => Effect.succeed(path) });
const memoryFence = RuntimeFence.makeWithOptions().pipe(
  Effect.provideService(FileSystem.FileSystem, virtualFs),
);

it.layer(NodeServices.layer)("StaveRuntimeFence", (it) => {
  it.effect("drains admitted starts, refuses new descendants, and admits siblings", () =>
    Effect.gen(function* () {
      const fence = yield* memoryFence;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const body = yield* Deferred.make<void>();
      const keepFence = yield* Deferred.make<void>();
      const start = yield* fence
        .withStart(
          "/spaces/one/repo",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const teardown = yield* fence
        .withFence(
          "/spaces/one",
          Deferred.succeed(body, undefined).pipe(Effect.andThen(Deferred.await(keepFence))),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(body));
      const rejected = yield* fence
        .withStart("/spaces/one/another", Effect.die("must not start"))
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      if (rejected._tag === "Failure") assert.equal(rejected.failure._tag, "StaveRuntimeFenced");
      assert.equal(
        yield* fence.withStart("/spaces/one-more", Effect.succeed("sibling")),
        "sibling",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(start);
      yield* Deferred.await(body);
      yield* Deferred.succeed(keepFence, undefined);
      yield* Fiber.join(teardown);
      assert.equal(yield* fence.withStart("/spaces/one/repo", Effect.succeed("after")), "after");
    }),
  );

  it.effect("interruption releases a draining fence and a cancelled start drains", () =>
    Effect.gen(function* () {
      const fence = yield* memoryFence;
      const entered = yield* Deferred.make<void>();
      const start = yield* fence
        .withStart(
          "/space",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const teardown = yield* fence.withFence("/space", Effect.void).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(teardown);
      yield* fence.withStart("/space", Effect.void);
      yield* Fiber.interrupt(start);
      yield* fence.withFence("/space", Effect.void);
    }),
  );

  it.effect("nested fences retain protection until the outer operation exits", () =>
    Effect.gen(function* () {
      const fence = yield* memoryFence;
      yield* fence.withFence(
        "/space",
        Effect.gen(function* () {
          yield* fence.withFence("/space/repo", Effect.void);
          const result = yield* fence.withStart("/space/repo", Effect.void).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
        }),
      );
      yield* fence.withStart("/space/repo", Effect.void);
    }),
  );

  it.effect("matches symlink aliases and missing descendants without prefix collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const root = path.join(dir, "root");
      const alias = path.join(dir, "alias");
      yield* fs.makeDirectory(root);
      yield* fs.symlink(root, alias);
      const fence = yield* RuntimeFence.makeWithOptions();
      assert.isTrue(yield* fence.isUnder(root, path.join(alias, "missing", "deep")));
      assert.isFalse(yield* fence.isUnder(root, `${root}-sibling`));
      yield* fence.withFence(
        root,
        Effect.gen(function* () {
          const result = yield* fence
            .withStart(path.join(alias, "missing"), Effect.void)
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
        }),
      );
    }),
  );

  it.effect("rechecks the Stave owner for nested cwd after a fence releases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const repo = path.join(root, "repo");
      yield* fs.makeDirectory(repo);
      const destroyed = yield* Ref.make(false);
      const calls: string[] = [];
      const fence = yield* RuntimeFence.StaveRuntimeFence.pipe(
        Effect.provide(
          RuntimeFence.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProjectionSnapshotQuery)({
                  getShellSnapshot: () =>
                    Effect.succeed({
                      snapshotSequence: 0,
                      threads: [],
                      updatedAt: "2026-01-01T00:00:00.000Z",
                      projects: [
                        {
                          id: ProjectId.make("stave-owner"),
                          title: "space",
                          workspaceRoot: root,
                          defaultModelSelection: null,
                          scripts: [],
                          createdAt: "2026-01-01T00:00:00.000Z",
                          updatedAt: "2026-01-01T00:00:00.000Z",
                          stave: {
                            spaceId: "space",
                            state: "live",
                            isSaga: false,
                            repos: [],
                            memories: [],
                          },
                        },
                      ],
                    }),
                }),
                Layer.succeed(StaveAdmission, {
                  check: (input) =>
                    Effect.gen(function* () {
                      calls.push(input.projectRoot);
                      assert.equal(input.projectId, "stave-owner");
                      assert.isTrue(input.lockHeld);
                      if (yield* Ref.get(destroyed))
                        return yield* new StaveSpaceTransitioningError({
                          projectRoot: root,
                          intent: input.intent,
                          message: "destroyed",
                        });
                    }),
                }),
              ),
            ),
          ),
        ),
      );
      yield* fence.withStart(repo, Effect.void);
      yield* fence.withFence(root, Ref.set(destroyed, true));
      const result = yield* fence
        .withStart(repo, Effect.die("stale runtime must not start"))
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(calls, [root, root]);
    }),
  );

  it.effect("refuses a stale vanished cwd even after its owner moved out of the projection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped();
      const root = path.join(base, "space");
      yield* fs.makeDirectory(root);
      const fence = yield* RuntimeFence.StaveRuntimeFence.pipe(
        Effect.provide(
          RuntimeFence.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProjectionSnapshotQuery)({
                  getShellSnapshot: () =>
                    Effect.succeed({
                      snapshotSequence: 0,
                      projects: [],
                      threads: [],
                      updatedAt: "2026-01-01T00:00:00.000Z",
                    }),
                }),
                Layer.succeed(StaveAdmission, { check: () => Effect.void }),
              ),
            ),
          ),
        ),
      );
      yield* fence.withFence(root, fs.remove(root, { recursive: true }));
      const result = yield* fence
        .withStart(root, Effect.die("missing cwd must not start"))
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});
