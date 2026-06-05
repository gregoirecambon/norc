CREATE TABLE `norc_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`orchestrator_enabled` integer DEFAULT false NOT NULL,
	`orchestrator_api_key` text,
	`orchestrator_model` text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	`orchestrator_system_prompt` text,
	`auto_route_threshold` real DEFAULT 0.7 NOT NULL,
	`heartbeat_enabled` integer DEFAULT true NOT NULL,
	`heartbeat_interval_sec` integer DEFAULT 60 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
