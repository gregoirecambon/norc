ALTER TABLE `norc_settings` ADD `chores_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `chores_notion_sync` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE TABLE `pending_chore_casts` (
	`id` text PRIMARY KEY NOT NULL,
	`chore_id` text NOT NULL,
	`source_page_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`cast_text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`discussion_id` text,
	`page_id` text NOT NULL,
	`proposed_comment_id` text,
	`proposed_by_user_id` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by_user_id` text
);
