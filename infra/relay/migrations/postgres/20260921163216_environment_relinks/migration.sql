CREATE TABLE "relay_environment_link_cleanup" (
	"user_id" varchar(191),
	"environment_id" varchar(191),
	"target" jsonb,
	"organization_id" text,
	CONSTRAINT "relay_environment_link_cleanup_pkey" PRIMARY KEY("user_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "relay_environment_link_owners" (
	"legacy_cleanup_pending" boolean DEFAULT false NOT NULL,
	"environment_id" varchar(191) PRIMARY KEY
);
--> statement-breakpoint
-- Only pre-migration duplicate links enter the one-off cleanup queue. The
-- worker chooses the newest committed link again while holding its lock.
INSERT INTO relay_environment_link_owners(environment_id, legacy_cleanup_pending)
SELECT environment_id, true FROM relay_environment_links WHERE revoked_at IS NULL
GROUP BY environment_id HAVING count(*) > 1;
