ALTER TABLE "workout_exercise" ADD COLUMN "load_updated_at" timestamp;--> statement-breakpoint
-- Backfill: sem histórico melhor, a última alteração da linha vale como a da carga.
UPDATE "workout_exercise" SET "load_updated_at" = "updated_at" WHERE "exercise_load" IS NOT NULL;
