CREATE TABLE `slack_integration` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_token` text,
	`signing_secret` text,
	`bot_user_id` text,
	`app_id` text,
	`team_id` text,
	`team_name` text,
	`bot_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
