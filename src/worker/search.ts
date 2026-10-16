import { and, asc, desc, gte, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm'
import type { SongSummary } from '../shared/api'
import type { Db } from './db/client'
import { songs } from './db/schema'

const SUGGEST_LIMIT = 8
// trigram は3文字未満の語を引けない
const TRIGRAM_MIN = 3

/** 検索語を空白で区切り、保存時の正規化（NFKC・小文字・空白除去）に合わせる */
function tokenize(q: string): string[] {
  return q
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

const escapeLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`)
// 前方一致の上端。BINARY 照合では U+10FFFF を付けた文字列が、t で始まるどの文字列よりも大きい
const prefixEnd = (t: string) => `${t}\u{10FFFF}`
const ftsPhrase = (t: string) => `"${t.replaceAll('"', '""')}"`

/**
 * 入力補完用に登録済みの曲を探す。3文字以上の語は全文索引（songs_fts）で絞り、
 * 短い語（「糸」「蕾」など）は絞った結果に LIKE で部分一致をかける。
 * 短い語しかない場合は全件を走査しないよう、曲名かアーティスト名の前方一致（索引の範囲検索）に限る。
 */
export async function suggestSongs(db: Db, q: string): Promise<SongSummary[]> {
  const tokens = tokenize(q)
  if (tokens.length === 0) return []
  const long = tokens.filter((t) => [...t].length >= TRIGRAM_MIN)
  const short = tokens.filter((t) => [...t].length < TRIGRAM_MIN)

  const conditions: SQL[] = [isNull(songs.mergedInto)]
  if (long.length > 0) {
    const match = long.map(ftsPhrase).join(' AND ')
    conditions.push(inArray(songs.id, sql`(SELECT rowid FROM songs_fts WHERE songs_fts MATCH ${match})`))
  }
  for (const t of short) {
    const cond =
      long.length > 0
        ? or(
            sql`${songs.titleNorm} LIKE ${`%${escapeLike(t)}%`} ESCAPE '\\'`,
            sql`${songs.artistNorm} LIKE ${`%${escapeLike(t)}%`} ESCAPE '\\'`,
          )
        : or(
            and(gte(songs.titleNorm, t), lt(songs.titleNorm, prefixEnd(t))),
            and(gte(songs.artistNorm, t), lt(songs.artistNorm, prefixEnd(t))),
          )
    if (cond) conditions.push(cond)
  }

  return db
    .select({
      id: songs.id,
      title: songs.title,
      artist: songs.artist,
      artworkUrl: songs.artworkUrl,
      voteCount: songs.voteCount,
      avgLevel: songs.avgLevel,
      likeCount: songs.likeCount,
    })
    .from(songs)
    .where(and(...conditions))
    .orderBy(desc(songs.likeCount), desc(songs.voteCount), asc(songs.id))
    .limit(SUGGEST_LIMIT)
}
