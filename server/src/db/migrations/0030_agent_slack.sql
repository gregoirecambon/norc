ALTER TABLE `agents` ADD `slack_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `slack_usergroup_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `slack_handle` text;
