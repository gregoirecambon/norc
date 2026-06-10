ALTER TABLE `task_runs` ADD `origin` text DEFAULT 'notion' NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `slack_channel` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `slack_thread_ts` text;
