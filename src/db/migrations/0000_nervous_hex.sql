CREATE TYPE "public"."body_part" AS ENUM('PEITO', 'TRICEPS', 'COSTAS', 'BICEPS', 'OMBRO', 'PERNA', 'ANTEBRACO', 'ABDOMEN', 'GLUTEO', 'LOMBAR', 'CARDIO');--> statement-breakpoint
CREATE TYPE "public"."record_exercise_status" AS ENUM('COMPLETED', 'PARTIAL', 'SKIPPED', 'MODIFIED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('USER', 'ADMIN');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"first_name" varchar(255) NOT NULL,
	"last_name" varchar(255),
	"weight" numeric(5, 2),
	"height" numeric(3, 2),
	"user_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exercise" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"body_part" "body_part" NOT NULL,
	"client_id" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password" varchar(255) NOT NULL,
	"role" "user_role" DEFAULT 'USER' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workout" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"list_order" integer DEFAULT 0 NOT NULL,
	"client_id" bigint NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workout_exercise" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sets" integer,
	"reps" integer,
	"exercise_load" numeric(5, 2),
	"list_order" integer DEFAULT 0 NOT NULL,
	"workout_id" bigint NOT NULL,
	"exercise_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workout_record" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workout_id" bigint NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workout_record_exercise" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"note" varchar(255),
	"status" "record_exercise_status" NOT NULL,
	"exercise_id" bigint NOT NULL,
	"workout_record_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workout_record_exercise_set" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"set_number" integer NOT NULL,
	"reps" integer,
	"exercise_load" numeric(5, 2),
	"note" varchar(255),
	"workout_record_exercise_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client" ADD CONSTRAINT "client_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exercise" ADD CONSTRAINT "exercise_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workout" ADD CONSTRAINT "workout_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workout_exercise" ADD CONSTRAINT "workout_exercise_workout_id_workout_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workout"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workout_exercise" ADD CONSTRAINT "workout_exercise_exercise_id_exercise_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercise"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workout_record" ADD CONSTRAINT "workout_record_workout_id_workout_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workout"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workout_record_exercise" ADD CONSTRAINT "workout_record_exercise_exercise_id_exercise_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercise"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workout_record_exercise" ADD CONSTRAINT "workout_record_exercise_workout_record_id_workout_record_id_fk" FOREIGN KEY ("workout_record_id") REFERENCES "public"."workout_record"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workout_record_exercise_set" ADD CONSTRAINT "workout_record_exercise_set_workout_record_exercise_id_workout_record_exercise_id_fk" FOREIGN KEY ("workout_record_exercise_id") REFERENCES "public"."workout_record_exercise"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_user_id_unique" ON "client" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exercise_body_part_idx" ON "exercise" USING btree ("body_part");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exercise_client_id_idx" ON "exercise" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workout_client_deleted_order_idx" ON "workout" USING btree ("client_id","deleted_at","list_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workout_exercise_workout_order_idx" ON "workout_exercise" USING btree ("workout_id","list_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workout_record_workout_created_idx" ON "workout_record" USING btree ("workout_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workout_record_exercise_record_idx" ON "workout_record_exercise" USING btree ("workout_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workout_record_exercise_set_exercise_idx" ON "workout_record_exercise_set" USING btree ("workout_record_exercise_id");