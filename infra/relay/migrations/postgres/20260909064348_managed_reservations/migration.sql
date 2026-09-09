CREATE TABLE "relay_managed_reservations" (
	"user_id" varchar(255),
	"environment_id" varchar(191),
	"generation" integer NOT NULL,
	"account_generation" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"state" varchar(16) NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "relay_managed_reservations_pkey" PRIMARY KEY("user_id","environment_id")
);
