CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter_type` text NOT NULL,
	`adapter_config` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'untested' NOT NULL,
	`last_pinged_at` integer,
	`last_latency_ms` integer,
	`registered_at` integer NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `connection_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`ok` integer NOT NULL,
	`latency_ms` integer,
	`error` text,
	`tested_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `registration_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`used_at` integer,
	`used_by_agent` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_tokens_token_unique` ON `registration_tokens` (`token`);