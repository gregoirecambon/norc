ALTER TABLE `norc_settings` ADD `ceo_memo` text;--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `ceo_memo_updated_at` integer;--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `auto_propose_summary_model` text;--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `auto_propose_probe_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `auto_propose_probe_cooldown_hours` integer DEFAULT 48 NOT NULL;--> statement-breakpoint
CREATE TABLE `project_memo` (
	`project_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`memo` text DEFAULT '' NOT NULL,
	`kpi_note` text,
	`signal_hash` text,
	`last_probe_at` integer,
	`updated_at` integer NOT NULL
);
