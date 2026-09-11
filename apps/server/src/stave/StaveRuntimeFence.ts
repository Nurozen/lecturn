/** Keeps runtime starts outside filesystem teardown, including starts already in flight. */
import { Context, Deferred, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { StaveAdmission } from "./StaveAdmission.ts";
import { isPathUnder } from "./StaveSpaceLock.ts";

export class StaveRuntimeFenced extends Schema.TaggedErrorClass<StaveRuntimeFenced>()(
  "StaveRuntimeFenced",
  { message: Schema.String },
) {}

export class StaveRuntimeFence extends Context.Service<
  StaveRuntimeFence,
  {
    readonly withFence: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly withStart: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StaveRuntimeFenced, R>;
    readonly isUnder: (root: string, cwd: string) => Effect.Effect<boolean>;
  }
>()("lecturn/stave/StaveRuntimeFence") {}

export const makeWithOptions = Effect.fn("StaveRuntimeFence.makeWithOptions")(function* (options?: {
  readonly checkStart?: (cwd: string) => Effect.Effect<void, StaveRuntimeFenced>;
  /** Deterministic observation for tests holding a runtime start during teardown. */
  readonly onFenceEntered?: (root: string, pendingCount: number) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = Effect.fn("StaveRuntimeFence.canonical")(function* (
    input: string,
  ): Effect.fn.Return<string> {
    let candidate = path.resolve(input);
    const missing: string[] = [];
    while (true) {
      const resolved = yield* fs.realPath(candidate).pipe(Effect.option);
      if (Option.isSome(resolved)) return path.join(resolved.value, ...missing.toReversed());
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(input);
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  });
  const paths = Effect.fn("StaveRuntimeFence.paths")(function* (input: string) {
    return [path.resolve(input), yield* canonical(input)] as const;
  });
  const contains = (roots: ReadonlyArray<string>, candidates: ReadonlyArray<string>) =>
    roots.some((root) =>
      candidates.some((candidate) => {
        const relative = path.relative(root, candidate);
        return (
          relative === "" ||
          (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        );
      }),
    );
  const fences = new Set<ReadonlyArray<string>>();
  const starts = new Set<{
    readonly paths: ReadonlyArray<string>;
    readonly done: Deferred.Deferred<void>;
  }>();
  const isUnder = Effect.fn("StaveRuntimeFence.isUnder")(function* (root: string, cwd: string) {
    return contains(yield* paths(root), yield* paths(cwd));
  });
  const withStart = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const keys = yield* restore(paths(cwd));
        if ([...fences].some((root) => contains(root, keys))) {
          return yield* new StaveRuntimeFenced({
            message: "This Stave space is transitioning. Try again after the operation finishes.",
          });
        }
        const entry = { paths: keys, done: Deferred.makeUnsafe<void>() };
        starts.add(entry);
        return yield* restore(
          (options?.checkStart?.(cwd) ?? Effect.void).pipe(Effect.andThen(effect)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              starts.delete(entry);
            }).pipe(Effect.andThen(Deferred.succeed(entry.done, undefined))),
          ),
        );
      }),
    );
  const withFence = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const keys = yield* restore(paths(root));
        fences.add(keys);
        const pending = [...starts].filter((start) => contains(keys, start.paths));
        return yield* restore(
          (options?.onFenceEntered?.(root, pending.length) ?? Effect.void).pipe(
            Effect.andThen(
              Effect.forEach(pending, (start) => Deferred.await(start.done), { discard: true }),
            ),
            Effect.andThen(effect),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              fences.delete(keys);
            }),
          ),
        );
      }),
    );
  return StaveRuntimeFence.of({ withFence, withStart, isUnder });
});

export const layer = Layer.effect(
  StaveRuntimeFence,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const admission = yield* StaveAdmission;
    const projection = yield* ProjectionSnapshotQuery;
    const base = yield* makeWithOptions();
    return yield* makeWithOptions({
      checkStart: Effect.fn("StaveRuntimeFence.checkStart")(function* (cwd) {
        const snapshot = yield* projection.getShellSnapshot().pipe(
          Effect.mapError(
            () =>
              new StaveRuntimeFenced({
                message: "Could not verify the workspace lifecycle before starting its runtime.",
              }),
          ),
        );
        const projects = [...snapshot.projects].sort(
          (a, b) =>
            Number(Boolean(b.stave)) - Number(Boolean(a.stave)) ||
            b.workspaceRoot.length - a.workspaceRoot.length,
        );
        const owner = yield* Effect.findFirst(projects, (project) =>
          base.isUnder(project.workspaceRoot, cwd),
        );
        yield* admission
          .check({
            projectRoot: Option.isSome(owner) ? owner.value.workspaceRoot : cwd,
            ...(Option.isSome(owner) ? { projectId: owner.value.id } : {}),
            intent: "thread.turn.start",
            lockHeld: true,
          })
          .pipe(Effect.mapError((error) => new StaveRuntimeFenced({ message: error.message })));
        const info = yield* fs.stat(cwd).pipe(
          Effect.mapError(
            () =>
              new StaveRuntimeFenced({
                message: "The runtime workspace no longer exists or is inaccessible.",
              }),
          ),
        );
        if (info.type !== "Directory")
          return yield* new StaveRuntimeFenced({
            message: "The runtime workspace is not a directory.",
          });
      }),
    });
  }),
);

/** Only explicit test seams use this; production layers require the shared service. */
export const noop = StaveRuntimeFence.of({
  withFence: (_root, effect) => effect,
  withStart: (_cwd, effect) => effect,
  isUnder: isPathUnder,
});
export const layerNoop = Layer.succeed(StaveRuntimeFence, noop);
