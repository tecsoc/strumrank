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
    // 同じ回線の中で IP を変える手口（機内モードの切り替え、IPv6 のプライバシー拡張）に備えて
    // IPv4 は /24、IPv6 は /48 の範囲でも数える。この列を追加する前に発行した ID は NULL
    subnetHash: text('subnet_hash'),
    // Turnstile の確認を最後に通った時刻。データセンター・VPN 経由では投票の前に新しい確認を求める
    lastVerifiedAt: integer('last_verified_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    index('voters_ip_created').on(t.ipHash, t.createdAt),
    index('voters_subnet_created').on(t.subnetHash, t.createdAt),
  ],
)
