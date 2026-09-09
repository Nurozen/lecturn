CREATE TABLE "relay_managed_gateway_accounts" (
	"user_id" text PRIMARY KEY,
	"generation" bigint DEFAULT 0 NOT NULL,
	"next_sync_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_managed_gateway_environments" (
	"user_id" text,
	"environment_id" text,
	"public_hostname" text NOT NULL,
	"origin_hostname" text NOT NULL,
	"origin_dns_record_id" text,
	"generation" bigint NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	CONSTRAINT "relay_managed_gateway_environments_pkey" PRIMARY KEY("user_id","environment_id")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_managed_gateway_accounts_due" ON "relay_managed_gateway_accounts" ("next_sync_at","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_managed_gateway_public_hostname" ON "relay_managed_gateway_environments" ("public_hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_managed_gateway_origin_hostname" ON "relay_managed_gateway_environments" ("origin_hostname");--> statement-breakpoint
ALTER TABLE "relay_managed_gateway_environments" ADD CONSTRAINT "relay_managed_gateway_environments_5Esr7ODOLAQD_fkey" FOREIGN KEY ("user_id") REFERENCES "relay_managed_gateway_accounts"("user_id");