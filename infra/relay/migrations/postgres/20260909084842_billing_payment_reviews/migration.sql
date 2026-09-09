CREATE TABLE "relay_billing_payment_reviews" (
	"invoice_id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"amount_paid" bigint NOT NULL,
	"currency" text NOT NULL,
	"paid_at" bigint NOT NULL,
	"deleted_at" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detected_at" bigint NOT NULL,
	"resolved_at" bigint,
	"resolution" text,
	"operator" text
);
--> statement-breakpoint
ALTER TABLE "relay_billing_inbox" ADD COLUMN "object_id" text;