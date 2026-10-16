import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`)

/** 1曲 = 1行。録音違い（シングル/アルバム/ライブ）はまとめる。 */
export const songs = sqliteTable(
  'songs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    artist: text('artist').notNull(),
    titleNorm: text('title_norm').notNull(),
    artistNorm: text('artist_norm').notNull(),
    artworkUrl: text('artwork_url'),
    appleMusicUrl: text('apple_music_url'),
    durationMs: integer('duration_ms'),
    // 投票の集計値。ランキングで毎回 votes を集計しないよう投票時に更新する
    voteCount: integer('vote_count').notNull().default(0),
    avgLevel: real('avg_level'),
    likeCount: integer('like_count').notNull().default(0),
    // MusicBrainz による名寄せ
    mbWorkId: text('mb_work_id'),
    mbStatus: text('mb_status', { enum: ['pending', 'done', 'not_found', 'error'] })
      .notNull()
      .default('pending'),
    // 一時的な失敗の再試行（Cron が mb_next_try_at を過ぎた pending/error を拾う）
    mbAttempts: integer('mb_attempts').notNull().default(0),
    mbNextTryAt: integer('mb_next_try_at', { mode: 'timestamp_ms' }),
    // 重複として統合された場合の統合先
    mergedInto: integer('merged_into'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('songs_norm_key').on(t.artistNorm, t.titleNorm).where(sql`${t.mergedInto} IS NULL`),
    index('songs_work').on(t.artistNorm, t.mbWorkId),
    index('songs_ranking').on(t.mergedInto, t.avgLevel),
    index('songs_ranking_votes').on(t.mergedInto, t.voteCount),
    index('songs_ranking_new').on(t.mergedInto, t.createdAt),
    index('songs_ranking_likes').on(t.mergedInto, t.likeCount, t.voteCount),
    index('songs_mb_queue').on(t.mbStatus, t.mbNextTryAt),
  ],
)

/** 外部サービスの曲 ID → songs。1曲に複数の録音が紐づく。 */
export const songSources = sqliteTable(
  'song_sources',
  {
    provider: text('provider', { enum: ['itunes'] }).notNull(),
    externalId: text('external_id').notNull(),
    songId: integer('song_id')
      .notNull()
      .references(() => songs.id),
  },
  (t) => [primaryKey({ columns: [t.provider, t.externalId] }), index('song_sources_song').on(t.songId)],
)

/** 匿名の投票者（cookie の ID）ごとに1曲1票。投票し直すと上書き。 */
export const votes = sqliteTable(
  'votes',
  {
    songId: integer('song_id')
      .notNull()
      .references(() => songs.id),
    voterId: text('voter_id').notNull(),
    level: integer('level').notNull(),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [primaryKey({ columns: [t.songId, t.voterId] }), check('votes_level_range', sql`${t.level} BETWEEN 1 AND 4`)],
)

/** いいね。匿名の投票者ごとに1曲1回。取り消すと行を消す。 */
export const likes = sqliteTable(
  'likes',
  {
    songId: integer('song_id')
      .notNull()
      .references(() => songs.id),
    voterId: text('voter_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.songId, t.voterId] })],
)
