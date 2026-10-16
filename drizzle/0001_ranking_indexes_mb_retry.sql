ALTER TABLE `songs` ADD `mb_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `songs` ADD `mb_next_try_at` integer;--> statement-breakpoint
CREATE INDEX `songs_ranking_votes` ON `songs` (`merged_into`,`vote_count`);--> statement-breakpoint
CREATE INDEX `songs_ranking_new` ON `songs` (`merged_into`,`created_at`);--> statement-breakpoint
CREATE INDEX `songs_mb_queue` ON `songs` (`mb_status`,`mb_next_try_at`);