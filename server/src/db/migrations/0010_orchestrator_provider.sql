ALTER TABLE `norc_settings` ADD `orchestrator_provider` text DEFAULT 'anthropic' NOT NULL;
--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `orchestrator_base_url` text;
