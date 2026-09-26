import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@lecturn/contracts";
import { resolveServerBackgroundActivitySettings } from "@lecturn/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { awaitShellEnvironment, getShellEnvironmentStatus } from "../shellEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

const DETECTION_TIMED_OUT_MESSAGE =
  "Provider detection timed out. Retry or configure the executable path in Settings.";
const DETECTION_RETRY_BASE_DELAY_MS = 5_000;
const DETECTION_RETRY_MAX_DELAY_MS = 60_000;

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

interface ApplySnapshotOptions {
  readonly forceRefresh?: boolean;
  /** Set by the periodic health check; user retries and settings changes leave it unset. */
  readonly routine?: boolean;
}

/** Consecutive routine timeouts a ready provider absorbs before its failure is published. */
const ROUTINE_TIMEOUTS_BEFORE_DEMOTION = 2;
/** Periodic checks add up to this fraction of the interval so providers do not probe in lockstep. */
const REFRESH_INTERVAL_JITTER = 0.1;

function withUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly discovery?: {
    readonly waitForShell: boolean;
    readonly refreshEnvironment: () => void;
  };
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean;
  /** Upper bound on one discovery probe. Drivers with slower sequential checks raise it. */
  readonly detectionTimeout?: Duration.Input;
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ServerProviderShape,
  ServerSettingsError,
  Scope.Scope | BackgroundPolicy.BackgroundPolicy | ServerSettingsService
> {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const serverSettings = yield* ServerSettingsService;
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initial = yield* input.initialSnapshot(initialSettings);
  const initialSnapshot: ServerProvider =
    input.discovery && initial.enabled
      ? {
          ...initial,
          discovery: {
            status: "detecting",
            phase:
              input.discovery.waitForShell && getShellEnvironmentStatus() === "pending"
                ? "shell"
                : "provider",
          },
        }
      : initial;
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const routineTimeoutsRef = yield* Ref.make(0);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;
  const detectionRetryRef = yield* Ref.make<{
    readonly attempts: number;
    readonly fiber: Fiber.Fiber<void, unknown> | null;
  }>({ attempts: 0, fiber: null });

  // Timed-out detection retries itself with backoff, so a busy host recovers
  // without the user pressing Retry. The pending fiber clears its own slot
  // before refreshing, so the refresh it runs never interrupts itself.
  const scheduleDetectionRetry = Effect.gen(function* () {
    const state = yield* Ref.get(detectionRetryRef);
    if (state.fiber !== null) return;
    const delayMs = Math.min(
      DETECTION_RETRY_BASE_DELAY_MS * 2 ** state.attempts,
      DETECTION_RETRY_MAX_DELAY_MS,
    );
    const fiber = yield* Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.andThen(Ref.update(detectionRetryRef, (current) => ({ ...current, fiber: null }))),
      Effect.andThen(
        Effect.suspend((): Effect.Effect<ServerProvider, ServerSettingsError> => refreshSnapshot()),
      ),
      Effect.asVoid,
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
    );
    yield* Ref.set(detectionRetryRef, { attempts: state.attempts + 1, fiber });
  });

  const cancelDetectionRetry = Effect.gen(function* () {
    const { fiber } = yield* Ref.getAndSet(detectionRetryRef, { attempts: 0, fiber: null });
    if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
  });

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation) {
        return [null, state] as const;
      }
      // Enrichment derives from the snapshot it was handed; a runtime usage
      // update that landed since must not be reverted by it.
      const discovery = state.snapshot.discovery;
      if (discovery?.status === "timed-out" || discovery?.status === "error")
        return [null, state] as const;
      const merged = withUsageLimits(
        discovery && !nextSnapshot.discovery ? { ...nextSnapshot, discovery } : nextSnapshot,
        state.snapshot.usageLimits,
      );
      if (Equal.equals(state.snapshot, merged)) {
        return [null, state] as const;
      }
      return [merged, { ...state, snapshot: merged }] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: ApplySnapshotOptions,
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    ) {
      const state = yield* Ref.get(snapshotStateRef);
      const nextGeneration = state.enrichmentGeneration + 1;
      yield* Ref.set(snapshotStateRef, {
        ...state,
        enrichmentGeneration: nextGeneration,
      });
      yield* Ref.set(settingsRef, nextSettings);
      yield* restartSnapshotEnrichment(nextSettings, state.snapshot, nextGeneration);
      return state.snapshot;
    }

    const probe = Effect.gen(function* () {
      if (!input.discovery) return yield* input.checkProvider;
      const previous = (yield* Ref.get(snapshotStateRef)).snapshot;
      if (!previous.enabled) return yield* input.checkProvider;
      const publishDetection = Effect.fn("publishDetection")(function* (
        discovery: NonNullable<ServerProvider["discovery"]>,
      ) {
        // Routine health checks must not interrupt an already usable provider.
        if (previous.discovery?.status === "ready") return;
        const snapshot = yield* Ref.modify(snapshotStateRef, (state) => {
          const snapshot = { ...state.snapshot, discovery };
          return [snapshot, { ...state, snapshot }] as const;
        });
        yield* PubSub.publish(changesPubSub, snapshot);
      });
      const failure = (
        status: "timed-out" | "error",
        phase: "shell" | "provider",
        message: string,
      ): ServerProvider => ({
        ...previous,
        status: "warning",
        message,
        discovery: { status, phase, message },
      });
      if (input.discovery.waitForShell) {
        yield* publishDetection({ status: "detecting", phase: "shell" });
        const shell = yield* Effect.promise(() =>
          awaitShellEnvironment({
            retry:
              previous.discovery?.status === "error" || previous.discovery?.status === "timed-out",
          }),
        );
        if (shell.status !== "ready")
          return failure(
            shell.status,
            "shell",
            shell.message ??
              "Loading the shell environment failed. Retry or configure the provider executable path in Settings.",
          );
      }
      input.discovery.refreshEnvironment();
      yield* publishDetection({ status: "detecting", phase: "provider" });
      return yield* input.checkProvider.pipe(
        Effect.map((snapshot): ServerProvider => ({
          ...snapshot,
          // A check may report its own inner timeout; anything else is ready or error.
          discovery:
            snapshot.discovery?.status === "timed-out"
              ? snapshot.discovery
              : {
                  status: snapshot.installed && snapshot.status !== "error" ? "ready" : "error",
                  phase: "provider",
                  ...(snapshot.message ? { message: snapshot.message } : {}),
                },
        })),
        Effect.timeoutOrElse({
          duration: input.detectionTimeout ?? "15 seconds",
          orElse: () =>
            Effect.succeed(failure("timed-out", "provider", DETECTION_TIMED_OUT_MESSAGE)),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Provider detection failed", cause).pipe(
            Effect.as(
              failure(
                "error",
                "provider",
                "Could not detect the provider. Retry or configure its executable path in Settings.",
              ),
            ),
          ),
        ),
      );
    });
    const probedSnapshot = yield* probe;
    // A busy machine can stall one routine check. Keep a ready provider usable
    // until routine checks time out repeatedly; every other failure publishes now.
    if (probedSnapshot.discovery?.status === "timed-out" && options?.routine === true) {
      const current = (yield* Ref.get(snapshotStateRef)).snapshot;
      const timeouts = yield* Ref.updateAndGet(routineTimeoutsRef, (count) => count + 1);
      if (current.discovery?.status === "ready" && timeouts < ROUTINE_TIMEOUTS_BEFORE_DEMOTION) {
        yield* Effect.logWarning("Routine provider health check timed out; keeping ready status", {
          instanceId: current.instanceId,
          consecutiveTimeouts: timeouts,
        });
        yield* Ref.set(settingsRef, nextSettings);
        return current;
      }
    }
    yield* Ref.set(routineTimeoutsRef, 0);
    if (probedSnapshot.discovery?.status === "timed-out") {
      yield* scheduleDetectionRetry;
    } else {
      yield* cancelDetectionRetry;
    }
    const { snapshot: nextSnapshot, generation: nextGeneration } = yield* Ref.modify(
      snapshotStateRef,
      (state) => {
        const generation = input.enrichSnapshot
          ? state.enrichmentGeneration + 1
          : state.enrichmentGeneration;
        const snapshot = withUsageLimits(
          probedSnapshot,
          resolveUsageLimitsAfterProbe({
            published: state.snapshot.usageLimits,
            probed: probedSnapshot.usageLimits,
          }),
        );
        return [
          { snapshot, generation },
          { snapshot, enrichmentGeneration: generation },
        ] as const;
      },
    );
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: ApplySnapshotOptions) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  /**
   * Runtime usage updates arrive between probes. They patch only
   * `usageLimits` on whatever snapshot is published and leave the enrichment
   * generation alone, so an in-flight enrichment still lands.
   */
  const applyUsageLimits: ServerProviderShape["applyUsageLimits"] = (update) =>
    Effect.gen(function* () {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
        const usageLimits = applyUsageLimitsUpdate({
          previous: state.snapshot.usageLimits,
          update,
          checkedAt: update.checkedAt,
        });
        // `applyUsageLimitsUpdate` hands back the same object when nothing
        // moved, which is the common case for Codex's per-tick notification.
        if (usageLimits === state.snapshot.usageLimits) {
          return [null, state] as const;
        }
        const snapshot = withUsageLimits(state.snapshot, usageLimits);
        return [snapshot, { ...state, snapshot }] as const;
      });
      if (snapshotToPublish !== null) {
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }
    });

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* (options?: {
    readonly routine?: boolean;
  }) {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { ...options, forceRefresh: true });
  });

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : serverSettings.getSettings.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* serverSettings.subscribeChanges;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    getRefreshInterval.pipe(
      Effect.flatMap((refreshInterval) =>
        Effect.raceFirst(
          Random.next.pipe(
            Effect.flatMap((jitter) => {
              const intervalMillis = Duration.toMillis(Duration.fromInputUnsafe(refreshInterval));
              return Effect.sleep(
                intervalMillis <= 0
                  ? "60 seconds"
                  : Duration.millis(intervalMillis * (1 + REFRESH_INTERVAL_JITTER * jitter)),
              );
            }),
            Effect.as(true),
          ),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) =>
            input.refreshOnInterval !== false &&
            intervalElapsed &&
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) > 0
              ? hasProviderStatusDemand.pipe(
                  Effect.flatMap((shouldRefresh) =>
                    shouldRefresh
                      ? refreshSnapshot({ routine: true }).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    applyUsageLimits,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
