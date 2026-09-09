CREATE TABLE "relay_billing_enforcement_control" (
	"id" integer PRIMARY KEY,
	"enabled" boolean DEFAULT false NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_billing_enforcement_control_singleton" CHECK ("id"=1)
);
--> statement-breakpoint
CREATE TABLE "relay_billing_grant_audit" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"operator" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"grant_id" text,
	"starts_at" bigint,
	"ends_at" bigint,
	"environment_limit" integer,
	"created_at" bigint NOT NULL,
	CONSTRAINT "relay_billing_grant_audit_action" CHECK ("action" IN ('grant','revoke'))
);
--> statement-breakpoint
CREATE TABLE "relay_billing_identity_checks" (
	"user_id" text PRIMARY KEY,
	"next_check_at" bigint DEFAULT 0 NOT NULL,
	"checked_at" bigint,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "relay_billing_operator_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "relay_billing_operator_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"operation" text NOT NULL,
	"target" text,
	"reason" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_managed_suspensions" (
	"tunnel_id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"account_generation" integer NOT NULL,
	"reservation_generation" integer,
	"stage" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"completed_at" bigint,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "idx_relay_managed_suspensions_pending" ON "relay_managed_suspensions" ("user_id","environment_id") WHERE "completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_relay_managed_suspensions_retry" ON "relay_managed_suspensions" ("retry_at") WHERE "completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "relay_billing_identity_checks" ADD CONSTRAINT "relay_billing_identity_checks_uNGd2oiQUC7F_fkey" FOREIGN KEY ("user_id") REFERENCES "relay_billing_accounts"("user_id");
--> statement-breakpoint
INSERT INTO "relay_billing_enforcement_control" ("id") VALUES (1) ON CONFLICT DO NOTHING;
