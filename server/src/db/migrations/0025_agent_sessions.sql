CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`page_id` text NOT NULL,
	`lane` text DEFAULT 'work' NOT NULL,
	`session_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_agent_page_lane_idx` ON `agent_sessions` (`agent_id`,`page_id`,`lane`);--> statement-breakpoint
ALTER TABLE `task_runs` ADD `session_id` text;
