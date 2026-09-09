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
    ) => Effect.Effect<void, ManagedAccessRequired | ManagedAccessUnavailable>;
  }
>()("t3code-relay/billing/ManagedAccess") {}

export const disabled = ManagedAccess.of({ check: () => Effect.void });
export const layerDisabled = Layer.succeed(ManagedAccess, disabled);

/** Local canonical projection only: no Stripe calls on ordinary authorization paths. */
export const make = (
  load: (userId: string) => Effect.Effect<BillingAccount | undefined, BillingError>,
) =>
  ManagedAccess.of({
    check: Effect.fn("ManagedAccess.check")(function* (userId, _feature) {
      const account = yield* load(userId).pipe(
        Effect.mapError(
          () =>
            new ManagedAccessUnavailable({
              message: "Connect subscription status is temporarily unavailable. Please retry.",
            }),
        ),
      );
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      if (!account || account.deleted_at !== null)
        return yield* new ManagedAccessRequired({
          message: "An active Connect subscription is required.",
        });
      if (now - Number(account.updated_at) >= 900 || Number(account.updated_at) > now)
        return yield* new ManagedAccessUnavailable({
          message: "Connect subscription status needs reconciliation. Please retry.",
        });
      if (!Number.isFinite(account.state.accessUntil) || (account.state.accessUntil ?? 0) <= now)
        return yield* new ManagedAccessRequired({
          message: "An active Connect subscription is required.",
        });
    }),
  });

export const layer = (enabled: boolean) =>
  enabled
    ? Layer.effect(
        ManagedAccess,
        Effect.gen(function* () {
          const store = yield* makeBillingStore;
          return make(store.load);
        }),
      )
    : layerDisabled;
