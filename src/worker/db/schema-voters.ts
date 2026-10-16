import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Turnstile の確認を通って発行された投票者 ID。IP は生で持たず HMAC だけを残す。
 * 同じ発行元からの ID の量産と、1曲への票の集中を抑えるために使う。
 */
export const voters = sqliteTable(
  'voters',
  {
    id: text('id').primaryKey(),
    ipHash: text('ip_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [index('voters_ip_created').on(t.ipHash, t.createdAt)],
)
