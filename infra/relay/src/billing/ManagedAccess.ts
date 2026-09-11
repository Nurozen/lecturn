import { effectiveAccountAccess } from "./BillingGrants.ts";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { makeBillingStore, type BillingError, type BillingAccount } from "./BillingStore.ts";

export type ManagedFeature = "managedConnect" | "pushNotifications" | "liveActivities";
export class ManagedAccessRequired extends Schema.TaggedErrorClass<ManagedAccessRequired>()(
  "ManagedAccessRequired",
  { message: Schema.String },
) {}
export class ManagedAccessUnavailable extends Schema.TaggedErrorClass<ManagedAccessUnavailable>()(
  "ManagedAccessUnavailable",
  { message: Schema.String },
) {}
export class ManagedAccess extends Context.Service<
  ManagedAccess,
  {
    readonly check: (
      userId: string,
      feature: ManagedFeature,
      originCreatedAtSeconds?: number,
    ) => Effect.Effect<void, ManagedAccessRequired | ManagedAccessUnavailable>;
  }
>()("lecturn-relay/billing/ManagedAccess") {}

export const disabled = ManagedAccess.of({ check: () => Effect.void });
export const layerDisabled = Layer.succeed(ManagedAccess, disabled);

/** Local canonical projection only: no Stripe calls on ordinary authorization paths. */
export const make = (
  load: (userId: string) => Effect.Effect<BillingAccount | undefined, BillingError>,
  enforcementUsers?: readonly string[],
  enforcePayment = true,
) =>
  ManagedAccess.of({
    check: Effect.fn("ManagedAccess.check")(function* (userId, _feature, originCreatedAtSeconds) {
      const account = yield* load(userId).pipe(
        Effect.mapError(
          () =>
            new ManagedAccessUnavailable({
              message: "Connect subscription status is temporarily unavailable. Please retry.",
            }),
        ),
      );
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      if (account?.deleted_at != null)
        return yield* new ManagedAccessRequired({ message: "This account was deleted." });
      if (
        !enforcePayment ||
        (enforcementUsers !== undefined &&
          !enforcementUsers.includes("*") &&
          !enforcementUsers.includes(userId))
      )
        return;
      const access = effectiveAccountAccess(account, now);
      if (!access.available)
        return yield* new ManagedAccessUnavailable({
          message: "Connect subscription status needs reconciliation. Please retry.",
        });
      if (!access.allowed)
        return yield* new ManagedAccessRequired({
          message: "An active Connect subscription is required.",
        });
      if (
        originCreatedAtSeconds !== undefined &&
        (!Number.isFinite(originCreatedAtSeconds) ||
          originCreatedAtSeconds >= now + 1 ||
          !Number.isFinite(access.windowStart) ||
          originCreatedAtSeconds < (access.windowStart ?? Infinity))
      )
        return yield* new ManagedAccessRequired({
          message: "This notification belongs to an expired Connect access window.",
        });
    }),
  });

export const layer = (
  enabled: boolean,
  enforcementUsers?: readonly string[],
  enforcePayment = true,
) =>
  enabled
    ? Layer.effect(
        ManagedAccess,
        Effect.gen(function* () {
          const store = yield* makeBillingStore;
          return make(store.load, enforcementUsers, enforcePayment);
        }),
      )
    : layerDisabled;
