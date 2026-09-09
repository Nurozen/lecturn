import { Schema } from "effect";
import type Stripe from "stripe";
import type { BillingEvent } from "./BillingStore.ts";

const customerObject = Schema.Struct({
  customer: Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })]),
});
const customerId = Schema.decodeUnknownOption(customerObject);
/** Retain routing references only; never store webhook bodies or payment details. */
export function stripeEventReceipt(
  event: Stripe.Event,
  routingCustomer?: string,
  routingObjectId?: string,
): BillingEvent | null {
  if (
    !/^(customer\.subscription\.|checkout\.session\.|invoice\.|charge\.refunded$|refund\.updated$|charge\.dispute\.)/.test(
      event.type,
    )
  )
    return null;
  const decoded = customerId(event.data.object);
  if (decoded._tag === "None" && !routingCustomer) return null;
  const customer = routingCustomer ?? (decoded._tag === "Some" ? decoded.value.customer : "");
  return {
    id: `stripe:${event.livemode ? "live" : "test"}:${event.id}`,
    customer_id: typeof customer === "string" ? customer : customer.id,
    user_id: null,
    kind: event.type,
    ...(routingObjectId ? { object_id: routingObjectId } : {}),
  };
}
