ALTER TABLE `norc_settings` ADD `deep_ping_enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `deep_ping_interval_sec` integer DEFAULT 600 NOT NULL;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `failure_notify_threshold` integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` ADD `transport_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` ADD `deep_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` ADD `up_since_at` integer;
--> statement-breakpoint
ALTER TABLE `agents` ADD `last_ok_at` integer;
--> statement-breakpoint
ALTER TABLE `agents` ADD `down_notified_at` integer;
