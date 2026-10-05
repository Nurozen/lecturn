CREATE TABLE "relay_decision_usage_accounts" (
	"payer_id" text PRIMARY KEY,
	"exposure_nano" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "decision_usage_account_exposure" CHECK ("exposure_nano" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relay_decision_usage_attempts" (
	"id" text PRIMARY KEY,
	"payer_id" text NOT NULL,
	"request_id" text NOT NULL,
	"run_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"window_start" bigint NOT NULL,
	"hold_nano" bigint NOT NULL,
	"price_nano" bigint NOT NULL,
	"status" text NOT NULL,
	"deadline" bigint NOT NULL,
	"actual_tokens" bigint,
	"cost_nano" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "decision_usage_attempt_status" CHECK ("status" IN ('admitted','dispatched','unknown','succeeded','failed','expired','late'))
);
--> statement-breakpoint
CREATE TABLE "relay_decision_usage_control" (
	"id" integer PRIMARY KEY,
	"exposure_nano" bigint DEFAULT 0 NOT NULL,
	"anomaly" boolean DEFAULT false NOT NULL,
	CONSTRAINT "decision_usage_control_id" CHECK ("id"=1),
	CONSTRAINT "decision_usage_control_exposure" CHECK ("exposure_nano" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relay_decision_usage_requests" (
	"payer_id" text,
	"request_id" text,
	"environment_id" text NOT NULL,
	"public_key" text NOT NULL,
	"credential_id" text NOT NULL,
	"funding_generation" integer NOT NULL,
	"run_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"model" text NOT NULL,
	"template_version" text NOT NULL,
	"window_start" bigint NOT NULL,
	"window_end" bigint NOT NULL,
	"hold_tokens" bigint DEFAULT 0 NOT NULL,
	"debited_input_tokens" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"active_attempt_id" text,
	"result_json" jsonb,
	"result_expires_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "relay_decision_usage_requests_pkey" PRIMARY KEY("payer_id","request_id"),
	CONSTRAINT "decision_usage_request_status" CHECK ("status" IN ('pending','unknown','succeeded','failed','expired')),
	CONSTRAINT "decision_usage_request_counts" CHECK ("hold_tokens" >= 0 AND "debited_input_tokens" >= 0 AND "attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relay_decision_usage_runs" (
	"payer_id" text,
	"run_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"spent_nano" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_decision_usage_runs_pkey" PRIMARY KEY("payer_id","run_id"),
	CONSTRAINT "decision_usage_run_counts" CHECK ("attempt_count" >= 0 AND "spent_nano" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relay_decision_usage_windows" (
	"payer_id" text,
	"window_start" bigint,
	"window_end" bigint NOT NULL,
	"used_input_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_input_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_decision_usage_windows_pkey" PRIMARY KEY("payer_id","window_start"),
	CONSTRAINT "decision_usage_window_counts" CHECK ("used_input_tokens" >= 0 AND "reserved_input_tokens" >= 0)
);
--> statement-breakpoint
CREATE INDEX "decision_usage_attempt_account" ON "relay_decision_usage_attempts" ("payer_id","created_at");--> statement-breakpoint
CREATE INDEX "decision_usage_attempt_reconcile" ON "relay_decision_usage_attempts" ("status","deadline");--> statement-breakpoint
INSERT INTO "relay_decision_usage_control" ("id") VALUES (1);

--> statement-breakpoint
CREATE INDEX "decision_usage_attempt_environment" ON "relay_decision_usage_attempts" ("environment_id","status");
