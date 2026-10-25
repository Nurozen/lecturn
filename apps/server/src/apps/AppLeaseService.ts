/**
 * Live-tool leases, in memory only (see `AppLeaseService` in services.ts). A
 * lease that is not renewed before its TTL ends is dropped and announced on
 * `stream`, so a closed app reads as closed without anyone polling.
 */
import type { AppId } from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { type AppLease, AppLeaseService } from "./services.ts";

export const make = Effect.gen(function* () {
  const leases = yield* Ref.make(new Map<AppId, AppLease>());
  const changes = yield* PubSub.unbounded<{
    readonly appId: AppId;
    readonly lease: Option.Option<AppLease>;
  }>();
  // One expiry timer per app; a renewal replaces (and interrupts) the old one.
  const expiryTimers = yield* FiberMap.make<AppId>();

  const drop = (appId: AppId, only?: AppLease) =>
    Ref.modify(leases, (current) => {
      const existing = current.get(appId);
      if (existing === undefined || (only !== undefined && existing !== only)) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.delete(appId);
      return [true, next] as const;
    }).pipe(
      Effect.flatMap((dropped) =>
        dropped ? PubSub.publish(changes, { appId, lease: Option.none() }) : Effect.void,
      ),
      Effect.asVoid,
    );

  const set: AppLeaseService["Service"]["set"] = (appId, input) =>
    Effect.gen(function* () {
      const ttl = Duration.seconds(input.ttlSeconds);
      const now = yield* DateTime.now;
      const lease: AppLease = {
        appId,
        url: input.url,
        bearer: input.bearer,
        expiresAt: DateTime.addDuration(now, ttl),
      };
      yield* Ref.update(leases, (current) => new Map(current).set(appId, lease));
      yield* PubSub.publish(changes, { appId, lease: Option.some(lease) });
      yield* FiberMap.run(
        expiryTimers,
        appId,
        Effect.sleep(ttl).pipe(Effect.andThen(drop(appId, lease))),
      );
      return { expiresAt: DateTime.formatIso(lease.expiresAt) };
    });

  const clear: AppLeaseService["Service"]["clear"] = (appId) =>
    FiberMap.remove(expiryTimers, appId).pipe(Effect.andThen(drop(appId)));

  const current: AppLeaseService["Service"]["current"] = (appId) =>
    Effect.gen(function* () {
      const lease = (yield* Ref.get(leases)).get(appId);
      if (lease === undefined) return Option.none();
      // The timer may not have run yet at the exact expiry instant.
      const now = yield* DateTime.now;
      return DateTime.isLessThan(now, lease.expiresAt) ? Option.some(lease) : Option.none();
    });

  return AppLeaseService.of({
    set,
    clear,
    current,
    stream: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(AppLeaseService, make);
