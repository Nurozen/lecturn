CREATE TABLE "relay_billing_accounts" (
	"user_id" varchar(255) PRIMARY KEY,
	"customer_id" varchar(255) UNIQUE,
	"deleted_at" bigint,
	"generation" integer DEFAULT 0 NOT NULL,
	"lease_token" varchar(64),
	"lease_until" bigint DEFAULT 0 NOT NULL,
	"reconcile_after" bigint DEFAULT 0 NOT NULL,
	"state" jsonb DEFAULT '{}' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_billing_inbox" (
	"id" varchar(255) PRIMARY KEY,
	"customer_id" varchar(255),
	"user_id" varchar(255),
	"kind" varchar(255) NOT NULL,
	"created_at" bigint NOT NULL,
	"processed_at" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "relay_billing_inbox_pending" ON "relay_billing_inbox" ("processed_at","created_at");