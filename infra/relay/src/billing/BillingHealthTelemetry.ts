import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { BillingHealth } from "./BillingOperations.ts";

/** Numeric attributes remain queryable without parsing a serialized log message. */
export const reportBillingHealth = <E, R>(health: Effect.Effect<BillingHealth, E, R>) =>
  health.pipe(
    Effect.flatMap((value) =>
      Effect.annotateCurrentSpan(
        Object.fromEntries(
          Object.entries(value).map(([key, count]) => [`billing.health.${key}`, count]),
        ),
      ).pipe(Effect.andThen(Effect.logInfo("Billing operational health", value))),
    ),
    Effect.withSpan("relay.billing.health"),
  );

/** Build the exporter per scheduled invocation; its scope flushes before this effect returns. */
export const traceBillingMaintenance = <A, E, R, LE, LR>(
  effect: Effect.Effect<A, E, R>,
  tracerLayer: Layer.Layer<never, LE, LR>,
) => effect.pipe(Effect.withSpan("relay.billing.reconcile_pending"), Effect.provide(tracerLayer));
