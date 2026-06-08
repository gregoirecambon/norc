ALTER TABLE `task_runs` ADD `last_progress_at` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `openclaw_run_id` text;--> statement-breakpoint
ALTER TABLE `norc_settings` ADD `run_hard_cap_sec` integer DEFAULT 1800 NOT NULL;
