CREATE TABLE `client` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`first_name` varchar(255) NOT NULL,
	`last_name` varchar(255),
	`weight` decimal(5,2),
	`height` decimal(3,2),
	`user_id` bigint NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `client_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_user_id_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `exercise` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`body_part` enum('PEITO','TRICEPS','COSTAS','BICEPS','OMBRO','PERNA','ANTEBRACO','ABDOMEN','GLUTEO','LOMBAR','CARDIO') NOT NULL,
	`client_id` bigint,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `exercise_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`email` varchar(255) NOT NULL,
	`password` varchar(255) NOT NULL,
	`role` enum('USER','ADMIN') NOT NULL DEFAULT 'USER',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `workout` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`list_order` int NOT NULL DEFAULT 0,
	`client_id` bigint NOT NULL,
	`deleted_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workout_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workout_exercise` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`sets` int,
	`reps` int,
	`exercise_load` decimal(5,2),
	`list_order` int NOT NULL DEFAULT 0,
	`workout_id` bigint NOT NULL,
	`exercise_id` bigint NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workout_exercise_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workout_record` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`workout_id` bigint NOT NULL,
	`deleted_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workout_record_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workout_record_exercise` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`note` varchar(255),
	`status` enum('COMPLETED','PARTIAL','SKIPPED','MODIFIED') NOT NULL,
	`exercise_id` bigint NOT NULL,
	`workout_record_id` bigint NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workout_record_exercise_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workout_record_exercise_set` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`set_number` int NOT NULL,
	`reps` int,
	`exercise_load` decimal(5,2),
	`note` varchar(255),
	`workout_record_exercise_id` bigint NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `workout_record_exercise_set_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `client` ADD CONSTRAINT `client_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exercise` ADD CONSTRAINT `exercise_client_id_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `client`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workout` ADD CONSTRAINT `workout_client_id_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `client`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workout_exercise` ADD CONSTRAINT `workout_exercise_workout_id_workout_id_fk` FOREIGN KEY (`workout_id`) REFERENCES `workout`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workout_exercise` ADD CONSTRAINT `workout_exercise_exercise_id_exercise_id_fk` FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workout_record` ADD CONSTRAINT `workout_record_workout_id_workout_id_fk` FOREIGN KEY (`workout_id`) REFERENCES `workout`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workout_record_exercise` ADD CONSTRAINT `workout_record_exercise_exercise_id_exercise_id_fk` FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workout_record_exercise` ADD CONSTRAINT `workout_record_exercise_workout_record_id_workout_record_id_fk` FOREIGN KEY (`workout_record_id`) REFERENCES `workout_record`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workout_record_exercise_set` ADD CONSTRAINT `wr_exercise_set_wr_exercise_fk` FOREIGN KEY (`workout_record_exercise_id`) REFERENCES `workout_record_exercise`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `exercise_body_part_idx` ON `exercise` (`body_part`);--> statement-breakpoint
CREATE INDEX `exercise_client_id_idx` ON `exercise` (`client_id`);--> statement-breakpoint
CREATE INDEX `workout_client_deleted_order_idx` ON `workout` (`client_id`,`deleted_at`,`list_order`);--> statement-breakpoint
CREATE INDEX `workout_exercise_workout_order_idx` ON `workout_exercise` (`workout_id`,`list_order`);--> statement-breakpoint
CREATE INDEX `workout_record_workout_created_idx` ON `workout_record` (`workout_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workout_record_exercise_record_idx` ON `workout_record_exercise` (`workout_record_id`);--> statement-breakpoint
CREATE INDEX `workout_record_exercise_set_exercise_idx` ON `workout_record_exercise_set` (`workout_record_exercise_id`);