ALTER TABLE `songs` ADD `registered_by` text;--> statement-breakpoint
CREATE INDEX `songs_registered` ON `songs` (`registered_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `songs_title_norm` ON `songs` (`title_norm`);