CREATE TABLE `notion_integration` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key` text NOT NULL,
	`workspace_name` text,
	`bot_name` text,
	`webhook_verify_token` text,
	`status` text DEFAULT 'pending_key' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
