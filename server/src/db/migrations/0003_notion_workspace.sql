ALTER TABLE `notion_integration` ADD `parent_page_id` text;
--> statement-breakpoint
ALTER TABLE `notion_integration` ADD `workspace_status` text DEFAULT 'not_provisioned' NOT NULL;
--> statement-breakpoint
CREATE TABLE `notion_databases` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`notion_database_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`created_at` integer NOT NULL
);
