import { AppId } from "@lecturn/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AppLeaseServiceLayer from "./AppLeaseService.ts";
import { AppLeaseService } from "./services.ts";

const appId = AppId.make("dev.example.app");
const lease = (ttlSeconds: number) => ({
  url: "http://127.0.0.1:4100/mcp",
  bearer: "live-bearer",
  ttlSeconds,
});

const isLive = Effect.gen(function* () {
  const leases = yield* AppLeaseService;
  return Option.isSome(yield* leases.current(appId));
});

/** The `lease` of each change, as `live` or `closed`. */
const collectChanges = (count: number) =>
  Effect.gen(function* () {
    const leases = yield* AppLeaseService;
    return yield* leases.stream.pipe(
      Stream.take(count),
      Stream.map((change) => (Option.isSome(change.lease) ? "live" : "closed")),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
  });

describe("AppLeaseService", () => {
  it.effect("expires a lease that is not renewed within its TTL", () =>
    Effect.gen(function* () {
      const leases = yield* AppLeaseService;
      const changes = yield* collectChanges(2);

      const { expiresAt } = yield* leases.set(appId, lease(10));
      assert.strictEqual(expiresAt, "1970-01-01T00:00:10.000Z");
      assert.isTrue(yield* isLive);

      yield* TestClock.adjust("9 seconds");
      assert.isTrue(yield* isLive);

      yield* TestClock.adjust("1 second");
      assert.isFalse(yield* isLive);
      assert.deepEqual(yield* Fiber.join(changes), ["live", "closed"]);
    }).pipe(Effect.provide(AppLeaseServiceLayer.layer)),
  );

  it.effect("keeps a lease alive while its heartbeat renews it", () =>
    Effect.gen(function* () {
      const leases = yield* AppLeaseService;
      yield* leases.set(appId, lease(10));
      for (let beat = 0; beat < 5; beat++) {
        yield* TestClock.adjust("8 seconds");
        yield* leases.set(appId, lease(10));
      }
      yield* TestClock.adjust("9 seconds");
      assert.isTrue(yield* isLive);

      yield* TestClock.adjust("1 second");
      assert.isFalse(yield* isLive);
    }).pipe(Effect.provide(AppLeaseServiceLayer.layer)),
  );

  it.effect("announces a cleared lease once and stops its expiry", () =>
    Effect.gen(function* () {
      const leases = yield* AppLeaseService;
      const changes = yield* collectChanges(3);

      yield* leases.set(appId, lease(10));
      yield* leases.clear(appId);
      yield* leases.clear(appId);
      assert.isFalse(yield* isLive);

      yield* leases.set(appId, lease(30));
      yield* TestClock.adjust("10 seconds");
      // The first lease's timer must not end the second one.
      assert.isTrue(yield* isLive);
      assert.deepEqual(yield* Fiber.join(changes), ["live", "closed", "live"]);
    }).pipe(Effect.provide(AppLeaseServiceLayer.layer)),
  );
});
