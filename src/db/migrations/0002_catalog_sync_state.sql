CREATE TABLE IF NOT EXISTS "catalog_sync_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"db_fingerprint" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
