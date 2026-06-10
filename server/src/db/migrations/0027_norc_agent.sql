ALTER TABLE `notion_integration` ADD `norc_org_page_id` text;--> statement-breakpoint
CREATE TABLE `pending_self_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`diff_text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`discussion_id` text,
	`page_id` text NOT NULL,
	`proposed_comment_id` text,
	`proposed_by_user_id` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by_user_id` text
);
