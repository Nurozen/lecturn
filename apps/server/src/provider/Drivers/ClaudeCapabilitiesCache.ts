import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";

import type { ClaudeRuntimeModelInfo } from "../ClaudeModelCatalog.ts";
import type { ClaudeCapabilitiesProbe } from "../ClaudeProvider.ts";

const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

const withoutUsage = (capabilities: ClaudeCapabilitiesProbe): ClaudeCapabilitiesProbe => {
  const result = { ...capabilities };
  delete result.usage;
  return result;
};

/**
 * One instance owns one account's metadata and last successful runtime model list.
 *
 * A transient probe failure may reuse the last account once, but its usage
 * windows keep their age, so the fallback drops them. `isSameAccount` rejects
 * that reuse after the CLI signed in to another account.
 */
export const makeClaudeCapabilitiesCache = <E>(
  probe: Effect.Effect<ClaudeCapabilitiesProbe | undefined, E>,
  options?: {
    readonly isSameAccount?: (last: ClaudeCapabilitiesProbe) => Effect.Effect<boolean>;
  },
) =>
  Effect.gen(function* () {
    let currentVersion: string | null | undefined;
    let currentModels: ReadonlyArray<ClaudeRuntimeModelInfo> | undefined;
    let lastGood: ClaudeCapabilitiesProbe | undefined;
    const semaphore = yield* Semaphore.make(1);
    const cache = yield* Cache.makeWith(
      (_version: string) =>
        probe.pipe(
          Effect.map((capabilities) => ({ _tag: "fresh" as const, capabilities })),
          Effect.tap(({ capabilities }) =>
            Effect.sync(() => {
              lastGood = capabilities;
            }),
          ),
          Effect.catch((error) => {
            const last = lastGood;
            lastGood = undefined;
            if (last === undefined) return Effect.fail(error);
            return (options?.isSameAccount?.(last) ?? Effect.succeed(true)).pipe(
              Effect.flatMap((sameAccount) =>
                sameAccount
                  ? Effect.succeed({ _tag: "fallback" as const, capabilities: withoutUsage(last) })
                  : Effect.fail(error),
              ),
            );
          }),
        ),
      {
        capacity: 1,
        timeToLive: (exit) =>
          // Only a fresh probe earns the TTL; a failure or its fallback retries on the next check.
          Exit.isSuccess(exit) && exit.value._tag === "fresh"
            ? CAPABILITIES_PROBE_TTL
            : Duration.zero,
      },
    );
    const get = Effect.fn("ClaudeCapabilitiesCache.get")(function* (version: string | null) {
      if (currentVersion !== version) {
        currentVersion = version;
        currentModels = undefined;
      }
      const { capabilities } = yield* Cache.get(cache, version ?? "");
      if (capabilities?.models?.length) currentModels = capabilities.models;
      return capabilities;
    });
    return {
      get: (version: string | null) => semaphore.withPermits(1)(get(version)),
      invalidate: semaphore.withPermits(1)(Cache.invalidateAll(cache)),
      get currentModels() {
        return currentModels;
      },
    };
  }).pipe(Effect.withSpan("makeClaudeCapabilitiesCache"));
