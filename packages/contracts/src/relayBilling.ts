import * as Schema from "effect/Schema";

export const RelayBillingInterval = Schema.Literals(["month", "year"]);
export type RelayBillingInterval = typeof RelayBillingInterval.Type;
export const RelayBillingStatus = Schema.Struct({
  state: Schema.Literals([
    "disabled",
    "free",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unavailable",
  ]),
  trialEligible: Schema.Boolean,
  cancelAt: Schema.NullOr(Schema.String),
  checkoutEnabled: Schema.Boolean,
  portalEnabled: Schema.Boolean,
  interval: Schema.NullOr(RelayBillingInterval),
  currentPeriodEnd: Schema.NullOr(Schema.String),
  trialEnd: Schema.NullOr(Schema.String),
  cancelAtPeriodEnd: Schema.Boolean,
  hasAccess: Schema.Boolean,
  accessReason: Schema.optionalKey(Schema.String),
  accessUntil: Schema.optionalKey(Schema.NullOr(Schema.String)),
  features: Schema.Struct({
    managedConnect: Schema.Boolean,
    pushNotifications: Schema.Boolean,
    liveActivities: Schema.Boolean,
  }),
  quota: Schema.Struct({ limit: Schema.Number, used: Schema.Number }),
});
export type RelayBillingStatus = typeof RelayBillingStatus.Type;
export const RelayBillingCheckoutRequest = Schema.Struct({ interval: RelayBillingInterval });
export const RelayBillingReconcileRequest = Schema.Struct({ sessionId: Schema.String });
export const RelayBillingRedirect = Schema.Struct({ url: Schema.String });
