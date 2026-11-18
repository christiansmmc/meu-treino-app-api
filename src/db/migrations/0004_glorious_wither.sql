CREATE TYPE "public"."next_load" AS ENUM('KEEP', 'UP', 'UP_MORE');--> statement-breakpoint
ALTER TABLE "workout_record_exercise" ADD COLUMN "next_load" "next_load";