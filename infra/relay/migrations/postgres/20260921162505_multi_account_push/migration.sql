CREATE TABLE "relay_push_token_owners" (
	"kind" text,
	"token" text,
	"device_id" varchar(255) NOT NULL,
	CONSTRAINT "relay_push_token_owners_pkey" PRIMARY KEY("kind","token")
);
--> statement-breakpoint
INSERT INTO relay_push_token_owners(kind, token, device_id)
SELECT 'push', push_token, device_id FROM relay_mobile_devices WHERE push_token IS NOT NULL
UNION ALL SELECT 'push_to_start', push_to_start_token, device_id FROM relay_mobile_devices WHERE push_to_start_token IS NOT NULL
UNION ALL SELECT 'activity', activity_push_token, device_id FROM relay_live_activities WHERE activity_push_token IS NOT NULL;
--> statement-breakpoint
DROP INDEX "idx_relay_live_activities_activity_push_token";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_live_activities_activity_push_token" ON "relay_live_activities" ("user_id","activity_push_token");--> statement-breakpoint
DROP INDEX "idx_relay_mobile_devices_push_token";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_mobile_devices_push_token" ON "relay_mobile_devices" ("user_id","push_token");--> statement-breakpoint
DROP INDEX "idx_relay_mobile_devices_push_to_start_token";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_mobile_devices_push_to_start_token" ON "relay_mobile_devices" ("user_id","push_to_start_token");