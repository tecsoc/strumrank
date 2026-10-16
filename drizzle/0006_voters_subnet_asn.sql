ALTER TABLE `voters` ADD `subnet_hash` text;--> statement-breakpoint
ALTER TABLE `voters` ADD `last_verified_at` integer;--> statement-breakpoint
CREATE INDEX `voters_subnet_created` ON `voters` (`subnet_hash`,`created_at`);