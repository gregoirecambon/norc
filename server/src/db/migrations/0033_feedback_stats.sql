CREATE TABLE `feedback_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`token` text NOT NULL,
	`channel` text NOT NULL,
	`recipient` text,
	`recipient_name` text,
	`run_title` text,
	`agent_id` text,
	`agent_name` text,
	`run_status` text,
	`questions_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_invites_token_unique` ON `feedback_invites` (`token`);--> statement-breakpoint
CREATE TABLE `feedback_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`run_title` text,
	`agent_id` text,
	`agent_name` text,
	`rating` integer NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feedback_tool_ratings` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`tool_key` text NOT NULL,
	`rating` integer NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `feedback_submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `feedback_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `feedback_sample_rate` real DEFAULT 0.25 NOT NULL;--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `feedback_channel` text DEFAULT 'slack' NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `triggering_slack_user_id` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `tool_flags` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `tokens_used` integer;
