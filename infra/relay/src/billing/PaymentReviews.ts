import { Clock, Effect } from "effect";
import { RelayDb } from "../db.ts";
import { BillingError } from "./BillingStore.ts";

export interface PostDeletionPaymentReview {
  invoiceId: string;
  userId: string;
  customerId: string;
  subscriptionId: string;
  amountPaid: number;
  currency: string;
  paidAt: number;
  deletedAt: number;
}
export type PaymentReviewRecorder = (
  review: PostDeletionPaymentReview,
) => Effect.Effect<void, BillingError>;
const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));
const unavailable = () =>
  new BillingError({ code: "persistence", message: "Payment review could not be persisted" });

/** Durable operator queue. Recording or resolving a review never moves money. */
export const makePaymentReviews = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
  const record: PaymentReviewRecorder = Effect.fn("PaymentReviews.record")(function* (review) {
    const time = yield* now;
    yield* query(sql`INSERT INTO relay_billing_payment_reviews(invoice_id,user_id,customer_id,subscription_id,amount_paid,currency,paid_at,deleted_at,reason,status,detected_at)
      VALUES (${review.invoiceId},${review.userId},${review.customerId},${review.subscriptionId},${review.amountPaid},${review.currency},${review.paidAt},${review.deletedAt},'payment_settled_after_deletion','pending',${time}) ON CONFLICT(invoice_id) DO NOTHING`);
  });
  return {
    record,
    pending: Effect.fn("PaymentReviews.pending")(function* (limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return yield* new BillingError({
          code: "invalid",
          message: "Review limit must be 1 through 100",
        });
      return yield* query(
        sql<PostDeletionPaymentReview>`SELECT invoice_id AS "invoiceId",user_id AS "userId",customer_id AS "customerId",subscription_id AS "subscriptionId",amount_paid AS "amountPaid",currency,paid_at AS "paidAt",deleted_at AS "deletedAt" FROM relay_billing_payment_reviews WHERE status='pending' ORDER BY detected_at,invoice_id LIMIT ${limit}`,
      );
    }),
    resolve: Effect.fn("PaymentReviews.resolve")(function* (input: {
      invoiceId: string;
      operator: string;
      resolution: string;
    }) {
      if (
        !input.invoiceId.trim() ||
        !input.operator.trim() ||
        input.operator.length > 200 ||
        input.resolution.trim().length < 8 ||
        input.resolution.length > 1000
      )
        return yield* new BillingError({
          code: "invalid",
          message: "Invoice, operator and a resolution of 8 through 1000 characters are required",
        });
      const time = yield* now;
      const rows = yield* query(
        sql`UPDATE relay_billing_payment_reviews SET status='resolved',operator=${input.operator},resolution=${input.resolution},resolved_at=${time} WHERE invoice_id=${input.invoiceId} AND status='pending' RETURNING invoice_id`,
      );
      if (rows.length) return { applied: true };
      const existing = (yield* query(
        sql<{
          operator: string;
          resolution: string;
        }>`SELECT operator,resolution FROM relay_billing_payment_reviews WHERE invoice_id=${input.invoiceId} AND status='resolved'`,
      ))[0];
      if (existing?.operator === input.operator && existing.resolution === input.resolution)
        return { applied: false };
      return yield* new BillingError({
        code: "invalid",
        message: "Review is missing or has a different recorded resolution",
      });
    }),
  };
});
