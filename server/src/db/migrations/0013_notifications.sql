ALTER TABLE `norc_settings` ADD `notify_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `notify_email` text;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `smtp_host` text;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `smtp_port` integer;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `smtp_user` text;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `smtp_pass` text;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `smtp_from` text;
