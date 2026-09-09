import { Schema } from "effect";
import type Stripe from "stripe";
import type { BillingEvent } from "./BillingStore.ts";

const customerObject = Schema.Struct({
  customer: Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })]),
});
const customerId = Schema.decodeUnknownOption(customerObject);
/** Retain routing references only; never store webhook bodies or payment details. */
export function stripeEventReceipt(event: Stripe.Event): BillingEvent | null {
  if (!/^(customer\.subscription\.|checkout\.session\.|invoice\.)/.test(event.type)) return null;
  const decoded = customerId(event.data.object);
  if (decoded._tag === "None") return null;
  const customer = decoded.value.customer;
  return {
    id: `stripe:test:${event.id}`,
    customer_id: typeof customer === "string" ? customer : customer.id,
    user_id: null,
    kind: event.type,
  };
}
