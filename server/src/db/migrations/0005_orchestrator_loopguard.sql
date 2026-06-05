CREATE TABLE `orchestrator_comments` (
	`comment_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `notion_integration` ADD `bot_user_id` text;
