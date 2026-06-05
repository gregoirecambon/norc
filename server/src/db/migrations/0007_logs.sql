CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`line` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logs_ts_idx` ON `logs` (`ts`);
