// @effect-diagnostics nodeBuiltinImport:off -- standalone path boundary shared by provider and terminal services
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
/** Shared process-lifetime fence for Stave admission and filesystem mutations. */
import { Context, Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect";

export class StaveSpaceLock extends Context.Service<
  StaveSpaceLock,
  {
    readonly withSpaceLock: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Fence project root changes against registered ancestor operations. */
    readonly tryWithWorkspaceLocks: <A, E, R>(
      roots: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    /** Refuse contention without parking a worker needed by the lock holder. */
    readonly tryWithSpaceLock: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
  }
>()("lecturn/stave/StaveSpaceLock") {}

export const layer = Layer.effect(
  StaveSpaceLock,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const locks = new Map<string, Semaphore.Semaphore>();
    const canonical = Effect.fn("StaveSpaceLock.canonical")(function* (root: string) {
      let candidate = path.resolve(root);
      const missing: string[] = [];
      while (true) {
        const resolved = yield* fs.realPath(candidate).pipe(Effect.option);
        if (Option.isSome(resolved)) return path.join(resolved.value, ...missing.toReversed());
        const parent = path.dirname(candidate);
        if (parent === candidate) return path.resolve(root);
        missing.push(path.basename(candidate));
        candidate = parent;
      }
    });
    const getLock = Effect.fn("StaveSpaceLock.getLock")(function* (root: string) {
      const key = yield* canonical(root);
      let lock = locks.get(key);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(key, lock);
      }
      return lock;
    });
    const withSpaceLock = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
      getLock(root).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));
    const tryWithSpaceLock = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
      getLock(root).pipe(Effect.flatMap((lock) => lock.withPermitsIfAvailable(1)(effect)));
    const tryWithWorkspaceLocks = <A, E, R>(
      roots: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const targets = yield* Effect.forEach(roots, canonical);
        const keys = new Set(targets);
        // Registered roots survive the filesystem move until their operation
        // releases the mutex, even when the manifest is already gone.
        for (const root of locks.keys()) {
          if (
            targets.some((target) => {
              const relative = path.relative(root, target);
              return (
                relative === "" ||
                (relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(relative))
              );
            })
          )
            keys.add(root);
        }
        let guarded = Effect.map(effect, Option.some);
        for (const root of [...keys].sort().toReversed()) {
          const mutex = yield* getLock(root);
          guarded = mutex.withPermitsIfAvailable(1)(guarded).pipe(Effect.map(Option.flatten));
        }
        return yield* guarded;
      });
    return StaveSpaceLock.of({ withSpaceLock, tryWithSpaceLock, tryWithWorkspaceLocks });
  }),
);

/** Segment-aware ancestry, resolving existing symlink aliases before comparison. */
export const isPathUnder = (root: string, candidate: string) =>
  Effect.promise(async () => {
    const canonical = async (value: string) => {
      let candidate = NodePath.resolve(value);
      const missing: string[] = [];
      while (true) {
        const resolved = await NodeFSP.realpath(candidate).catch(() => undefined);
        if (resolved !== undefined) return NodePath.join(resolved, ...missing.toReversed());
        const parent = NodePath.dirname(candidate);
        if (parent === candidate) return NodePath.resolve(value);
        missing.push(NodePath.basename(candidate));
        candidate = parent;
      }
    };
    const [base, target] = await Promise.all([canonical(root), canonical(candidate)]);
    const relative = NodePath.relative(base, target);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    );
  });
