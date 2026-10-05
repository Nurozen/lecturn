CREATE TABLE "relay_decision_funding" (
	"environment_id" text PRIMARY KEY,
	"public_key" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"payer_id" text,
	"state" text DEFAULT 'unfunded' NOT NULL,
	CONSTRAINT "relay_decision_funding_state" CHECK ("state" IN ('unfunded','active','revoked')),
	CONSTRAINT "relay_decision_funding_generation" CHECK ("generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relay_decision_funding_challenges" (
	"id" text PRIMARY KEY,
	"environment_id" text NOT NULL,
	"public_key" text NOT NULL,
	"generation" integer NOT NULL,
	"expires_at" bigint NOT NULL,
	"payer_id" text,
	"redeemed_generation" integer,
	"revoked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_decision_grants" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"monthly_input_tokens" bigint NOT NULL,
	"operator" text NOT NULL,
	"reason" text NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "relay_decision_grants_window" CHECK ("starts_at" > 0 AND "ends_at" > "starts_at"),
	CONSTRAINT "relay_decision_grants_allowance" CHECK ("monthly_input_tokens" > 0 AND "monthly_input_tokens" <= 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX "relay_decision_funding_payer" ON "relay_decision_funding" ("payer_id");--> statement-breakpoint
CREATE INDEX "relay_decision_challenges_environment" ON "relay_decision_funding_challenges" ("environment_id");--> statement-breakpoint
CREATE INDEX "relay_decision_grants_user" ON "relay_decision_grants" ("user_id");--> statement-breakpoint
ALTER TABLE "relay_decision_funding_challenges" ADD CONSTRAINT "relay_decision_funding_challenges_UleoiTCGNkIG_fkey" FOREIGN KEY ("environment_id") REFERENCES "relay_decision_funding"("environment_id");--> statement-breakpoint
ALTER TABLE "relay_decision_grants" ADD CONSTRAINT "relay_decision_grants_vvkbay2EmyO9_fkey" FOREIGN KEY ("user_id") REFERENCES "relay_billing_accounts"("user_id");