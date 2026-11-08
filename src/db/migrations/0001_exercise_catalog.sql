ALTER TABLE "exercise" ADD COLUMN "external_id" varchar(64);--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "name_en" varchar(255);--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "equipment" varchar(255);--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "target" varchar(255);--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "secondary_muscles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "category" varchar(255);--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "instructions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "video" varchar(512);--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "media_attribution" text;--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "exercise_external_id_unique" ON "exercise" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workout_exercise_exercise_id_idx" ON "workout_exercise" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workout_record_exercise_exercise_id_idx" ON "workout_record_exercise" USING btree ("exercise_id");