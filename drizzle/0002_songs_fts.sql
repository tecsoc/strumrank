-- 補完検索用の全文索引。drizzle のスキーマで表せないため custom マイグレーションで作る（ユーザー承認済みの例外）。
-- trigram なので日本語の部分一致に使える（3文字未満は LIKE で補う。src/worker/search.ts）。
-- combined は「アーティスト曲名」「曲名アーティスト」と空白なしで続けて打った場合に一致させるための列。
CREATE VIRTUAL TABLE `songs_fts` USING fts5(title_norm, artist_norm, combined, tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER `songs_fts_ai` AFTER INSERT ON `songs` BEGIN
  INSERT INTO songs_fts(rowid, title_norm, artist_norm, combined)
  VALUES (new.id, new.title_norm, new.artist_norm, new.artist_norm || new.title_norm || ' ' || new.title_norm || new.artist_norm);
END;
--> statement-breakpoint
CREATE TRIGGER `songs_fts_ad` AFTER DELETE ON `songs` BEGIN
  DELETE FROM songs_fts WHERE rowid = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `songs_fts_au` AFTER UPDATE OF title_norm, artist_norm ON `songs` BEGIN
  DELETE FROM songs_fts WHERE rowid = old.id;
  INSERT INTO songs_fts(rowid, title_norm, artist_norm, combined)
  VALUES (new.id, new.title_norm, new.artist_norm, new.artist_norm || new.title_norm || ' ' || new.title_norm || new.artist_norm);
END;
--> statement-breakpoint
INSERT INTO songs_fts(rowid, title_norm, artist_norm, combined)
SELECT id, title_norm, artist_norm, artist_norm || title_norm || ' ' || title_norm || artist_norm FROM songs;
