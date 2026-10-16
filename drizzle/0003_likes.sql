CREATE TABLE `likes` (
	`song_id` integer NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`song_id`, `voter_id`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `songs` ADD `like_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `songs_ranking_likes` ON `songs` (`merged_into`,`like_count`);