CREATE TABLE `song_sources` (
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`song_id` integer NOT NULL,
	PRIMARY KEY(`provider`, `external_id`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `song_sources_song` ON `song_sources` (`song_id`);--> statement-breakpoint
CREATE TABLE `songs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`artist` text NOT NULL,
	`title_norm` text NOT NULL,
	`artist_norm` text NOT NULL,
	`artwork_url` text,
	`apple_music_url` text,
	`duration_ms` integer,
	`vote_count` integer DEFAULT 0 NOT NULL,
	`avg_level` real,
	`mb_work_id` text,
	`mb_status` text DEFAULT 'pending' NOT NULL,
	`merged_into` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `songs_norm_key` ON `songs` (`artist_norm`,`title_norm`) WHERE "songs"."merged_into" IS NULL;--> statement-breakpoint
CREATE INDEX `songs_work` ON `songs` (`artist_norm`,`mb_work_id`);--> statement-breakpoint
CREATE INDEX `songs_ranking` ON `songs` (`merged_into`,`avg_level`);--> statement-breakpoint
CREATE TABLE `votes` (
	`song_id` integer NOT NULL,
	`voter_id` text NOT NULL,
	`level` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`song_id`, `voter_id`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "votes_level_range" CHECK("votes"."level" BETWEEN 1 AND 4)
);
