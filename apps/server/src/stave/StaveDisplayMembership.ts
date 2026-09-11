/** Best-effort display enrichment; destructive admission always performs its own fresh scan. */
import type { StaveProjectInfo } from "@lecturn/contracts";
import { Cache, Context, Duration, Effect, Exit, Layer } from "effect";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StaveBinary } from "./StaveBinary.ts";
import { StaveCli } from "./StaveCli.ts";
import { StaveReadCache } from "./StaveReadCache.ts";

export class StaveDisplayMembership extends Context.Service<
  StaveDisplayMembership,
  {
    readonly enrich: (root: string, info: StaveProjectInfo) => Effect.Effect<StaveProjectInfo>;
  }
>()("lecturn/stave/StaveDisplayMembership") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const binary = yield* StaveBinary;
  const cli = yield* StaveCli;
  const invalidation = yield* StaveReadCache;
  const cache = yield* Cache.makeWith((_generation: number) => cli.sagaList, {
    capacity: 1,
    timeToLive: Exit.match({
      onSuccess: () => Duration.seconds(15),
      onFailure: () => Duration.zero,
    }),
  });
  const enrich = Effect.fn("StaveDisplayMembership.enrich")(
    function* (root: string, info: StaveProjectInfo) {
      if (
        !config.staveEnabled ||
        !(yield* settings.getSettings).stave.enabled ||
        info.state !== "live"
      )
        return info;
      yield* binary.resolve;
      const rows = yield* Cache.get(cache, yield* invalidation.generation);
      const row = rows.find(
        (row) => row.path === root && row.logicalId === info.spaceId && !row.error,
      );
      return row?.memberOf ? { ...info, memberOf: row.memberOf } : info;
    },
    Effect.orElseSucceed(() => null),
  );
  return StaveDisplayMembership.of({
    enrich: (root, info) => enrich(root, info).pipe(Effect.map((result) => result ?? info)),
  });
});
export const layer = Layer.effect(StaveDisplayMembership, make);
