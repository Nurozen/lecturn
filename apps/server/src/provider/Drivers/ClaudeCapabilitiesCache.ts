import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { ClaudeRuntimeModelInfo } from "../ClaudeModelCatalog.ts";
import type { ClaudeCapabilitiesProbe } from "../Layers/ClaudeProvider.ts";

/** One instance owns one account's metadata and last successful runtime model list. */
export const makeClaudeCapabilitiesCache = Effect.fn("makeClaudeCapabilitiesCache")(function* (
  probe: Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
) {
  let currentVersion: string | null | undefined;
  let currentModels: ReadonlyArray<ClaudeRuntimeModelInfo> | undefined;
  const semaphore = yield* Semaphore.make(1);
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: Duration.minutes(5),
    lookup: (_version: string) => probe,
  });
  const get = Effect.fn("ClaudeCapabilitiesCache.get")(function* (version: string | null) {
    if (currentVersion !== version) {
      currentVersion = version;
      currentModels = undefined;
    }
    const capabilities = yield* Cache.get(cache, version ?? "");
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
});
