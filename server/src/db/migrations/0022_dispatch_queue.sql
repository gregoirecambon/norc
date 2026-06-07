ALTER TABLE `agents` ADD `max_concurrent_runs` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `lane` text DEFAULT 'work' NOT NULL;--> statement-breakpoint
CREATE TABLE `dispatch_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`page_id` text NOT NULL,
	`task_page_id` text,
	`project_id` text,
	`anchor_kind` text NOT NULL,
	`title` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`enqueued_at` integer NOT NULL,
	`dispatched_at` integer,
	`dropped_reason` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `dispatch_queue_agent_status_idx` ON `dispatch_queue` (`agent_id`,`status`);
