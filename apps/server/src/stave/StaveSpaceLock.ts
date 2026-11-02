// @effect-diagnostics nodeBuiltinImport:off -- standalone path boundary shared by provider and terminal services
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
/** Shared process-lifetime fence for Stave admission and filesystem mutations. */
import { Context, Deferred, Duration, Effect, FileSystem, Layer, Option, Path } from "effect";

export class StaveSpaceLock extends Context.Service<
  StaveSpaceLock,
  {
    /** Exclusive, waiting as long as it takes: Stave operations that change a space. */
    readonly withSpaceLock: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /**
     * Shared: admission that only has to exclude Stave operations, so any
     * number run together. Waits up to `wait` (unbounded when omitted;
     * `Duration.zero` never queues) and returns `None` when that runs out.
     * Reentrant within the holding fiber, so a nested admission for a space
     * the fiber already holds runs at once instead of queueing behind a writer
     * that is waiting for this very holder.
     */
    readonly withSharedSpaceLock: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
      wait?: Duration.Input,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    /**
     * Fence project root changes against registered ancestor operations.
     * Exclusive: a project create or move changes which project owns a tree,
     * so it must exclude in-flight thread admissions that resolved the old
     * owner as well as Stave operations. It never waits, because it runs
     * under the project command lock.
     */
    readonly tryWithWorkspaceLocks: <A, E, R>(
      roots: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
  }
>()("lecturn/stave/StaveSpaceLock") {}

/** Canonical roots the current fiber holds shared. */
class HeldSharedSpaces extends Context.Reference<ReadonlySet<string>>(
  "lecturn/stave/StaveSpaceLock/HeldSharedSpaces",
  { defaultValue: () => new Set() },
) {}

interface Waiter {
  readonly exclusive: boolean;
  readonly granted: Deferred.Deferred<void>;
  done: boolean;
}

/**
 * Read/write lock with FIFO hand-off: a reader queues whenever anyone is
 * already queued, so once a writer waits, later readers line up behind it and
 * a stream of turn starts cannot starve a Stave operation. Effect's Semaphore
 * cannot express this with "readers take one permit, writers take all": it
 * serves any request that fits, so a later one-permit request overtakes a
 * waiting all-permit one.
 */
class SpaceRwLock {
  private readers = 0;
  private writer = false;
  private readonly queue: Array<Waiter> = [];

  private admits(exclusive: boolean) {
    return exclusive ? !this.writer && this.readers === 0 : !this.writer;
  }

  private take(exclusive: boolean) {
    if (exclusive) this.writer = true;
    else this.readers += 1;
  }

  private wake() {
    while (this.queue.length > 0 && this.admits(this.queue[0]!.exclusive)) {
      const next = this.queue.shift()!;
      next.done = true;
      this.take(next.exclusive);
      Deferred.doneUnsafe(next.granted, Effect.void);
    }
  }

  tryAcquire(exclusive: boolean) {
    if (this.queue.length > 0 || !this.admits(exclusive)) return false;
    this.take(exclusive);
    return true;
  }

  acquire(exclusive: boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.tryAcquire(exclusive)) return Effect.void;
      const waiter: Waiter = { exclusive, granted: Deferred.makeUnsafe(), done: false };
      this.queue.push(waiter);
      return Deferred.await(waiter.granted).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (waiter.done) return this.releaseUnsafe(exclusive);
            this.queue.splice(this.queue.indexOf(waiter), 1);
            // A writer leaving the head may let the readers behind it in.
            this.wake();
          }),
        ),
      );
    });
  }

  releaseUnsafe(exclusive: boolean) {
    if (exclusive) this.writer = false;
    else this.readers -= 1;
    this.wake();
  }

  /** `wait` undefined waits as long as it takes; zero only tries. */
  with<A, E, R>(
    exclusive: boolean,
    effect: Effect.Effect<A, E, R>,
    wait?: Duration.Duration,
  ): Effect.Effect<Option.Option<A>, E, R> {
    const acquire =
      wait === undefined
        ? Effect.as(this.acquire(exclusive), true)
        : Duration.isZero(wait)
          ? Effect.sync(() => this.tryAcquire(exclusive))
          : Effect.map(Effect.timeoutOption(this.acquire(exclusive), wait), Option.isSome);
    return Effect.uninterruptibleMask((restore) =>
      restore(acquire).pipe(
        Effect.flatMap((held) =>
          held
            ? restore(effect).pipe(
                Effect.asSome,
                Effect.ensuring(Effect.sync(() => this.releaseUnsafe(exclusive))),
              )
            : Effect.succeedNone,
        ),
      ),
    );
  }
}

export const layer = Layer.effect(
  StaveSpaceLock,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const locks = new Map<string, SpaceRwLock>();
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
    const lockFor = (key: string) => {
      let lock = locks.get(key);
      if (lock === undefined) {
        lock = new SpaceRwLock();
        locks.set(key, lock);
      }
      return lock;
    };
    const withSpaceLock = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const key = yield* canonical(root);
        // Waiting would never end: the writer would wait on this fiber's own read.
        if ((yield* HeldSharedSpaces).has(key))
          return yield* Effect.die(new Error(`Stave space ${key} is already held shared.`));
        return Option.getOrThrow(yield* lockFor(key).with(true, effect));
      });
    const withSharedSpaceLock = <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
      wait?: Duration.Input,
    ) =>
      Effect.gen(function* () {
        const key = yield* canonical(root);
        const held = yield* HeldSharedSpaces;
        if (held.has(key)) return Option.some(yield* effect);
        return yield* lockFor(key).with(
          false,
          Effect.provideService(effect, HeldSharedSpaces, new Set([...held, key])),
          wait === undefined ? undefined : Duration.fromInputUnsafe(wait),
        );
      });
    const tryWithWorkspaceLocks = <A, E, R>(
      roots: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const targets = yield* Effect.forEach(roots, canonical);
        const keys = new Set(targets);
        // Registered roots survive the filesystem move until their operation
        // releases the lock, even when the manifest is already gone.
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
        let guarded = Effect.asSome(effect);
        for (const root of [...keys].sort().toReversed()) {
          guarded = lockFor(root)
            .with(true, guarded, Duration.zero)
            .pipe(Effect.map(Option.flatten));
        }
        return yield* guarded;
      });
    return StaveSpaceLock.of({ withSpaceLock, withSharedSpaceLock, tryWithWorkspaceLocks });
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
