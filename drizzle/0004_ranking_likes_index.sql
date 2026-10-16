DROP INDEX `songs_ranking_likes`;--> statement-breakpoint
CREATE INDEX `songs_ranking_likes` ON `songs` (`merged_into`,`like_count`,`vote_count`);