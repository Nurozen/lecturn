import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const FILE_LOCK_POLL_INTERVAL = Duration.seconds(1);

/**
 * Directory holding the advisory lock files. Every Lecturn server on the
 * machine (desktop, nightly, dev servers) shares it, because they also share
 * the package manager's global prefix that the locked commands mutate.
 */
export const ProviderMaintenanceLockDirectory = Context.Reference<string>(
  "@lecturn/server/providerMaintenance/ProviderMaintenanceLockDirectory",
  {
    defaultValue: () => NodeOS.tmpdir(),
  },
);

const FileLockOwner = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    token: Schema.String,
    acquiredAt: Schema.String,
  }),
);
const decodeFileLockOwner = Schema.decodeUnknownOption(FileLockOwner);
const encodeFileLockOwner = Schema.encodeSync(FileLockOwner);

interface HeldFileLock {
  readonly lockPath: string;
  readonly owner: string;
  readonly waited: boolean;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ProviderMaintenanceCommandCoordinatorShape<E> {
  /**
   * Runs `run` while holding the lock for `lockKey`, both within this process
   * and across every Lecturn server on the machine. `run` is told whether it
   * had to wait for another holder, so it can re-check whether its work is
   * still needed.
   */
  readonly withCommandLock: <A, R>(input: {
    readonly targetKey: string;
    readonly lockKey: string;
    readonly onQueued?: Effect.Effect<void, E, R>;
    readonly run: (context: { readonly waited: boolean }) => Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E, R>;
}

export const makeProviderMaintenanceCommandCoordinator = Effect.fn(
  "makeProviderMaintenanceCommandCoordinator",
)(function* <E>(input: {
  readonly makeAlreadyRunningError: (targetKey: string) => E;
  /** Age after which another server's lock file is treated as abandoned. */
  readonly fileLockStaleAfter: Duration.Duration;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockDirectory = yield* ProviderMaintenanceLockDirectory;
  const runningTargetsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const locksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());

  const acquireTarget = Effect.fn("acquireTarget")(function* (targetKey: string) {
    return yield* Ref.modify(runningTargetsRef, (runningTargets) => {
      if (runningTargets.has(targetKey)) {
        return [false, runningTargets] as const;
      }
      const next = new Set(runningTargets);
      next.add(targetKey);
      return [true, next] as const;
    });
  });

  const releaseTarget = (targetKey: string) =>
    Ref.update(runningTargetsRef, (runningTargets) => {
      const next = new Set(runningTargets);
      next.delete(targetKey);
      return next;
    });

  const getLock = Effect.fn("getProviderMaintenanceCommandLock")(function* (lockKey: string) {
    const existing = (yield* Ref.get(locksRef)).get(lockKey);
    if (existing) {
      return existing;
    }

    const lock = yield* Semaphore.make(1);
    return yield* Ref.modify(locksRef, (locks) => {
      const current = locks.get(lockKey);
      if (current) {
        return [current, locks] as const;
      }
      const next = new Map(locks);
      next.set(lockKey, lock);
      return [lock, next] as const;
    });
  });

  const isStaleFileLock = Effect.fn("isStaleProviderMaintenanceFileLock")(function* (
    lockPath: string,
  ) {
    const owner = yield* fileSystem.readFileString(lockPath).pipe(
      Effect.map(decodeFileLockOwner),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(owner) && !isProcessAlive(owner.value.pid)) {
      return true;
    }
    const now = yield* Clock.currentTimeMillis;
    const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
    const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
    return (
      Option.isSome(mtime) &&
      now - mtime.value.getTime() > Duration.toMillis(input.fileLockStaleAfter)
    );
  });

  // Only the wait between attempts is interruptible (via `restore`), so an
  // interrupt can never land between creating the lock file and returning it.
  const acquireFileLock = Effect.fn("acquireProviderMaintenanceFileLock")(function* (
    lockKey: string,
    restore: <A, E2, R>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>,
  ) {
    const lockPath = path.join(
      lockDirectory,
      `lecturn-provider-maintenance-${lockKey.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.lock`,
    );
    const owner = encodeFileLockOwner({
      pid: process.pid,
      token: NodeCrypto.randomUUID(),
      acquiredAt: DateTime.formatIso(yield* DateTime.now),
    });
    let waited = false;
    while (true) {
      const acquired = yield* fileSystem.writeFileString(lockPath, owner, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (acquired) {
        return { lockPath, owner, waited } satisfies HeldFileLock;
      }
      if (yield* isStaleFileLock(lockPath)) {
        yield* fileSystem.remove(lockPath, { force: true });
        continue;
      }
      waited = true;
      yield* restore(Effect.sleep(FILE_LOCK_POLL_INTERVAL));
    }
  });

  // A lock that outlived its stale window may have been taken over; only
  // remove the file while it still names this holder.
  const releaseFileLock = (lock: HeldFileLock) =>
    fileSystem.readFileString(lock.lockPath).pipe(
      Effect.flatMap((owner) =>
        owner === lock.owner ? fileSystem.remove(lock.lockPath, { force: true }) : Effect.void,
      ),
      Effect.ignore,
    );

  const withFileLock = <A, R>(
    lockKey: string,
    run: (context: { readonly waited: boolean }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // An unusable lock directory must not block updates; fall back to the
        // in-process lock alone.
        const lock = yield* acquireFileLock(lockKey, restore).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.logWarning("Provider maintenance file lock unavailable", {
              lockKey,
              error: error.message,
            }).pipe(Effect.as(Option.none<HeldFileLock>())),
          ),
        );
        if (Option.isNone(lock)) {
          return yield* restore(run({ waited: false }));
        }
        return yield* restore(run({ waited: lock.value.waited })).pipe(
          Effect.ensuring(releaseFileLock(lock.value)),
        );
      }),
    );

  const withCommandLock: ProviderMaintenanceCommandCoordinatorShape<E>["withCommandLock"] = ({
    targetKey,
    lockKey,
    onQueued,
    run,
  }) =>
    Effect.gen(function* () {
      const acquired = yield* acquireTarget(targetKey);
      if (!acquired) {
        return yield* Effect.fail(input.makeAlreadyRunningError(targetKey));
      }

      return yield* Effect.gen(function* () {
        const lock = yield* getLock(lockKey);
        if (onQueued) {
          yield* onQueued;
        }
        const uncontended = yield* lock.withPermitsIfAvailable(1)(withFileLock(lockKey, run));
        if (Option.isSome(uncontended)) {
          return uncontended.value;
        }
        return yield* lock.withPermits(1)(withFileLock(lockKey, () => run({ waited: true })));
      }).pipe(Effect.ensuring(releaseTarget(targetKey)));
    });

  return {
    withCommandLock,
  } satisfies ProviderMaintenanceCommandCoordinatorShape<E>;
});
