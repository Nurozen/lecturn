// @effect-diagnostics nodeBuiltinImport:off -- standalone path boundary shared by provider and terminal services
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
/** Shared process-lifetime fence for Stave admission and filesystem mutations. */
import { Context, Effect, FileSystem, Layer, Path, Semaphore } from "effect";

export class StaveSpaceLock extends Context.Service<
  StaveSpaceLock,
  {
    readonly withSpaceLock: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/stave/StaveSpaceLock") {}

export const layer = Layer.effect(
  StaveSpaceLock,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const locks = new Map<string, Semaphore.Semaphore>();
    const withSpaceLock = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const key = yield* fs.realPath(root).pipe(
          Effect.catch(() =>
            fs
              .realPath(path.dirname(root))
              .pipe(Effect.map((parent) => path.join(parent, path.basename(root)))),
          ),
          Effect.orElseSucceed(() => path.resolve(root)),
        );
        let lock = locks.get(key);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return yield* lock.withPermits(1)(effect);
      });
    return StaveSpaceLock.of({ withSpaceLock });
  }),
);

/** Segment-aware ancestry, resolving existing symlink aliases before comparison. */
export const isPathUnder = (root: string, candidate: string) =>
  Effect.promise(async () => {
    const canonical = async (value: string) =>
      NodeFSP.realpath(value).catch(() => NodePath.resolve(value));
    const [base, target] = await Promise.all([canonical(root), canonical(candidate)]);
    const relative = NodePath.relative(base, target);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    );
  });
