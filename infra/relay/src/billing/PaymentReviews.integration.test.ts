import { describe, expect, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { RelayDb } from "../db.ts";
import { operationId } from "./BillingStore.ts";
import { makePaymentReviews } from "./PaymentReviews.ts";

const url = process.env.BILLING_TEST_DATABASE_URL;
const database = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    return { $client: yield* PgClient.PgClient } as RelayDb["Service"];
  }),
).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(url ?? "postgresql://127.0.0.1/unused") })),
);

describe.skipIf(!url)("post-deletion payment reviews PostgreSQL", () => {
  it.effect("persists one review per invoice and records an immutable operator resolution", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(200_000);
      const { $client: sql } = yield* RelayDb;
      const reviews = yield* makePaymentReviews;
      const id = `payment-review-${yield* operationId}`;
      const review = {
        invoiceId: id,
        userId: `${id}-user`,
        customerId: `${id}-customer`,
        subscriptionId: `${id}-subscription`,
        amountPaid: 1000,
        currency: "usd",
        paidAt: 180,
        deletedAt: 170,
      };
      yield* reviews.record(review);
      yield* reviews.record(review);
      expect(
        (yield* sql`SELECT invoice_id FROM relay_billing_payment_reviews WHERE invoice_id=${id}`)
          .length,
      ).toBe(1);
      expect((yield* reviews.pending()).some((value) => value.invoiceId === id)).toBe(true);
      const resolution = {
        invoiceId: id,
        operator: "test-operator",
        resolution: "Reviewed provider refund receipt re_test; customer notified",
      };
      expect(yield* reviews.resolve(resolution)).toEqual({ applied: true });
      expect(yield* reviews.resolve(resolution)).toEqual({ applied: false });
      yield* reviews.record(review);
      expect((yield* reviews.pending()).some((value) => value.invoiceId === id)).toBe(false);
      const row = (yield* sql<{
        status: string;
        operator: string;
        resolution: string;
        resolved_at: number;
      }>`SELECT status,operator,resolution,resolved_at FROM relay_billing_payment_reviews WHERE invoice_id=${id}`)[0]!;
      expect(row.status).toBe("resolved");
      expect(row.operator).toBe("test-operator");
      expect(row.resolution).toBe(resolution.resolution);
      expect(Number(row.resolved_at)).toBe(200);
      expect(
        (yield* reviews
          .resolve({ ...resolution, resolution: "A different unreviewed outcome" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(database)),
  );
});
