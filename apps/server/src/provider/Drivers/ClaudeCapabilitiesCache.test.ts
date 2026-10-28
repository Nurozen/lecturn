import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { ClaudeCapabilitiesProbe } from "../ClaudeProvider.ts";
import { makeClaudeCapabilitiesCache } from "./ClaudeCapabilitiesCache.ts";

const capabilities = (slug: string): ClaudeCapabilitiesProbe => ({
  email: `${slug}@example.test`,
  subscriptionType: undefined,
  tokenSource: undefined,
  apiKeySource: undefined,
  apiProvider: undefined,
  slashCommands: [],
  models: [{ value: slug, displayName: slug, description: "Synthetic model" }],
});

describe("Claude capabilities cache", () => {
  it.effect("reuses metadata until expiry and discovers changed models on explicit refresh", () =>
    Effect.gen(function* () {
      let calls = 0;
      let response = capabilities("first-model");
      const cache = yield* makeClaudeCapabilitiesCache(
        Effect.sync(() => {
          calls++;
          return response;
        }),
      );
      yield* cache.get("2.0.0");
      response = capabilities("new-model");
      expect((yield* cache.get("2.0.0"))?.models?.[0]?.value).toBe("first-model");
      expect(calls).toBe(1);
      yield* cache.invalidate;
      expect((yield* cache.get("2.0.0"))?.models?.[0]?.value).toBe("new-model");
      expect(cache.currentModels?.[0]?.value).toBe("new-model");
      response = capabilities("later-model");
      yield* TestClock.adjust("6 minutes");
      expect((yield* cache.get("2.0.0"))?.models?.[0]?.value).toBe("later-model");
      expect(calls).toBe(3);
    }),
  );

  it.effect("keeps last good models through failed and empty probes without retaining auth", () =>
    Effect.gen(function* () {
      let response: ClaudeCapabilitiesProbe | undefined = capabilities("known-model");
      const cache = yield* makeClaudeCapabilitiesCache(Effect.sync(() => response));
      yield* cache.get("2.0.0");
      response = undefined;
      yield* cache.invalidate;
      expect(yield* cache.get("2.0.0")).toBeUndefined();
      expect(cache.currentModels?.[0]?.value).toBe("known-model");
      response = { ...capabilities("ignored"), models: [] };
      yield* cache.invalidate;
      yield* cache.get("2.0.0");
      expect(cache.currentModels?.[0]?.value).toBe("known-model");
    }),
  );

  it.effect(
    "reprobes a changed CLI version and clears incompatible fallback after a downgrade",
    () =>
      Effect.gen(function* () {
        let response: ClaudeCapabilitiesProbe | undefined = capabilities("older-model");
        const cache = yield* makeClaudeCapabilitiesCache(Effect.sync(() => response));
        yield* cache.get("2.0.0");
        response = capabilities("newer-model");
        yield* cache.get("3.0.0");
        expect(cache.currentModels?.[0]?.value).toBe("newer-model");
        response = undefined;
        yield* cache.get("2.0.0");
        expect(cache.currentModels).toBeUndefined();
      }),
  );

  it.effect("isolates provider accounts even when CLI versions match", () =>
    Effect.gen(function* () {
      const work = yield* makeClaudeCapabilitiesCache(Effect.succeed(capabilities("work-model")));
      const personal = yield* makeClaudeCapabilitiesCache(
        Effect.succeed(capabilities("personal-model")),
      );
      const [workResult, personalResult] = yield* Effect.all(
        [work.get("2.0.0"), personal.get("2.0.0")],
        { concurrency: "unbounded" },
      );
      expect(workResult?.email).toBe("work-model@example.test");
      expect(personalResult?.email).toBe("personal-model@example.test");
      expect(work.currentModels?.[0]?.value).toBe("work-model");
      expect(personal.currentModels?.[0]?.value).toBe("personal-model");
    }),
  );

  it.effect("reuses the last account once without usage after a probe failure, then retries", () =>
    Effect.gen(function* () {
      let calls = 0;
      let failing = false;
      const cache = yield* makeClaudeCapabilitiesCache(
        Effect.suspend(() => {
          calls++;
          return failing
            ? Effect.fail("probe timed out")
            : Effect.succeed({
                ...capabilities("known-model"),
                usage: { rate_limits_available: true, rate_limits: [] },
              } as ClaudeCapabilitiesProbe);
        }),
      );
      expect((yield* cache.get("2.0.0"))?.usage).toBeDefined();
      failing = true;
      yield* cache.invalidate;
      const fallback = yield* cache.get("2.0.0");
      expect(fallback?.email).toBe("known-model@example.test");
      expect(fallback?.usage).toBeUndefined();
      // A fallback earns no TTL, and the last account is reused only once.
      expect(yield* Effect.flip(cache.get("2.0.0"))).toBe("probe timed out");
      expect(calls).toBe(3);
    }),
  );

  it.effect("does not reuse the last account after a sign-in to another account", () =>
    Effect.gen(function* () {
      let failing = false;
      const cache = yield* makeClaudeCapabilitiesCache(
        Effect.suspend(() =>
          failing ? Effect.fail("probe failed") : Effect.succeed(capabilities("known-model")),
        ),
        { isSameAccount: () => Effect.succeed(false) },
      );
      yield* cache.get("2.0.0");
      failing = true;
      yield* cache.invalidate;
      expect(yield* Effect.flip(cache.get("2.0.0"))).toBe("probe failed");
    }),
  );
});
