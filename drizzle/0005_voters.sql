CREATE TABLE `voters` (
	`id` text PRIMARY KEY NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `voters_ip_created` ON `voters` (`ip_hash`,`created_at`);