CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`agent_id` text NOT NULL,
	`page_id` text NOT NULL,
	`task_page_id` text,
	`anchor_kind` text NOT NULL,
	`manage_task_status` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'in_flight' NOT NULL,
	`agent_acted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_token_unique` ON `task_runs` (`token`);
