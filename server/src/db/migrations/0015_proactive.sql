ALTER TABLE `norc_settings` ADD `scheduler_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `auto_propose_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `auto_propose_interval_hours` integer DEFAULT 12 NOT NULL;
