import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL, sql } from 'drizzle-orm'
import type { RankingResponse, RegisterSongInput, ResolveResponse, SongResponse } from '../shared/api'
import { MAX_LEVEL, type Sort } from '../shared/levels'
import { normalizeArtist, normalizeTitle } from '../shared/normalize'
import type { Db } from './db/client'
import { likes, songSources, songs, votes } from './db/schema'

const RANKING_PAGE_SIZE = 30

export const summaryColumns = {
  id: songs.id,
  title: songs.title,
  artist: songs.artist,
  artworkUrl: songs.artworkUrl,
  voteCount: songs.voteCount,
  avgLevel: songs.avgLevel,
  likeCount: songs.likeCount,
}

/**
 * 投票を集計し直す。対象の曲の votes だけを読むので投票数が増えても軽い。
 * 統合済みの曲は集計しない（統合時に 0 にした値を書き戻さない）。
 */
export function recomputeAggregates(db: Db, songId: number) {
  return db
    .update(songs)
    .set({
      voteCount: sql`(SELECT COUNT(*) FROM ${votes} WHERE ${votes.songId} = ${songId})`,
      avgLevel: sql`(SELECT AVG(${votes.level}) FROM ${votes} WHERE ${votes.songId} = ${songId})`,
    })
    .where(and(eq(songs.id, songId), isNull(songs.mergedInto)))
}

/** いいね数を集計し直す。未統合の曲だけを対象にする。 */
export function recomputeLikes(db: Db, songId: number) {
  return db
    .update(songs)
    .set({ likeCount: sql`(SELECT COUNT(*) FROM ${likes} WHERE ${likes.songId} = ${songId})` })
    .where(and(eq(songs.id, songId), isNull(songs.mergedInto)))
}

const MAX_MERGE_HOPS = 5

/** 統合済みなら統合先をたどって、未統合の曲の ID を返す。曲が無ければ null。 */
export async function resolveId(db: Db, songId: number): Promise<number | null> {
  let id = songId
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    const row = await db.select({ mergedInto: songs.mergedInto }).from(songs).where(eq(songs.id, id)).get()
    if (!row) return null
    if (row.mergedInto === null) return id
    id = row.mergedInto
  }
  return null
}

/** 統合済みなら統合先の ID を返す */
async function resolveMerged(db: Db, songId: number): Promise<{ id: number; merged: boolean } | null> {
  const id = await resolveId(db, songId)
  return id === null ? null : { id, merged: id !== songId }
}

/**
 * 正規化キーが一致する曲を探す。統合済みの曲のキーも見て統合先へたどる
 * （統合済みのキーで同じ曲が新しく作られるのを防ぐ）。未統合の行を優先する。
 */
async function findByNormKey(db: Db, artistNorm: string, titleNorm: string): Promise<number | null> {
  const row = await db
    .select({ id: songs.id, mergedInto: songs.mergedInto })
    .from(songs)
    .where(and(eq(songs.artistNorm, artistNorm), eq(songs.titleNorm, titleNorm)))
    .orderBy(sql`${songs.mergedInto} IS NOT NULL`, asc(songs.id))
    .get()
  if (!row) return null
  return row.mergedInto === null ? row.id : resolveId(db, row.mergedInto)
}

export async function registerSong(db: Db, input: RegisterSongInput): Promise<{ id: number; created: boolean }> {
  const externalId = String(input.itunesTrackId)
  const source = await db
    .select({ songId: songSources.songId })
    .from(songSources)
    .where(and(eq(songSources.provider, 'itunes'), eq(songSources.externalId, externalId)))
    .get()
  if (source) {
    const resolved = await resolveMerged(db, source.songId)
    if (resolved) return { id: resolved.id, created: false }
  }

  const titleNorm = normalizeTitle(input.title)
  const artistNorm = normalizeArtist(input.artist)
  const existing = await findByNormKey(db, artistNorm, titleNorm)
  if (existing !== null) {
    await db.insert(songSources).values({ provider: 'itunes', externalId, songId: existing }).onConflictDoNothing()
    return { id: existing, created: false }
  }

  // 同時登録で一意制約に当たっても落ちないよう、挿入できなければ既存行を引く
  const inserted = await db
    .insert(songs)
    .values({
      title: input.title,
      artist: input.artist,
      titleNorm,
      artistNorm,
      artworkUrl: input.artworkUrl ?? null,
      appleMusicUrl: input.appleMusicUrl ?? null,
      durationMs: input.durationMs ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: songs.id })
  const created = inserted[0]
  const id = created?.id ?? (await findByNormKey(db, artistNorm, titleNorm))
  if (id === null) throw new Error('song upsert failed')

  await db.insert(songSources).values({ provider: 'itunes', externalId, songId: id }).onConflictDoNothing()
  return { id, created: created !== undefined }
}

/** iTunes の検索結果のうち登録済みのものを、曲 ID に対応づける（1回のバッチで引く） */
export async function resolveSongs(
  db: Db,
  items: { itunesTrackId: number; title: string; artist: string }[],
): Promise<ResolveResponse> {
  if (items.length === 0) return {}
  const keyed = items.map((i) => ({
    externalId: String(i.itunesTrackId),
    key: `${normalizeArtist(i.artist)}\u0000${normalizeTitle(i.title)}`,
  }))
  const artistNorms = [...new Set(items.map((i) => normalizeArtist(i.artist)))]
  const [bySource, byNorm] = await db.batch([
    db
      .select({ externalId: songSources.externalId, songId: songSources.songId, mergedInto: songs.mergedInto })
      .from(songSources)
      .innerJoin(songs, eq(songs.id, songSources.songId))
      .where(
        and(
          eq(songSources.provider, 'itunes'),
          inArray(
            songSources.externalId,
            keyed.map((k) => k.externalId),
          ),
        ),
      ),
    db
      .select({ id: songs.id, artistNorm: songs.artistNorm, titleNorm: songs.titleNorm, mergedInto: songs.mergedInto })
      .from(songs)
      .where(inArray(songs.artistNorm, artistNorms)),
  ])

  // mergeSong が統合済みの子も統合先へ付け替えるので、merged_into は1段たどれば足りる
  const sourceMap = new Map(bySource.map((r) => [r.externalId, r.mergedInto ?? r.songId]))
  const normMap = new Map<string, number>()
  for (const r of byNorm) {
    const key = `${r.artistNorm}\u0000${r.titleNorm}`
    // 未統合の行を優先し、統合済みの行は統合先で代用する
    if (r.mergedInto === null) normMap.set(key, r.id)
    else if (!normMap.has(key)) normMap.set(key, r.mergedInto)
  }
  const result: ResolveResponse = {}
  for (const k of keyed) {
    const id = sourceMap.get(k.externalId) ?? normMap.get(k.key)
    if (id !== undefined) result[k.externalId] = id
  }
  return result
}

/** voterId が null（未確認の閲覧者）のときは myVote: null、myLike: false を返す */
export async function getSong(db: Db, songId: number, voterId: string | null): Promise<SongResponse | null> {
  const resolved = await resolveMerged(db, songId)
  if (!resolved) return null
  if (resolved.merged) return { mergedInto: resolved.id }

  // 未確認の閲覧者は空文字で引く（投票者 ID は UUID なので空文字の行は存在しない）
  const me = voterId ?? ''
  const [song, dist, mine, liked] = await db.batch([
    db
      .select({ ...summaryColumns, appleMusicUrl: songs.appleMusicUrl, spotifyUrl: songs.spotifyUrl })
      .from(songs)
      .where(eq(songs.id, songId)),
    db
      .select({ level: votes.level, n: sql<number>`COUNT(*)` })
      .from(votes)
      .where(eq(votes.songId, songId))
      .groupBy(votes.level),
    db
      .select({ level: votes.level })
      .from(votes)
      .where(and(eq(votes.songId, songId), eq(votes.voterId, me))),
    db
      .select({ songId: likes.songId })
      .from(likes)
      .where(and(eq(likes.songId, songId), eq(likes.voterId, me))),
  ])
  const row = song[0]
  if (!row) return null
  const distribution = Array.from({ length: MAX_LEVEL }, () => 0)
  for (const d of dist) distribution[d.level - 1] = d.n
  return { song: { ...row, distribution, myVote: mine[0]?.level ?? null, myLike: liked.length > 0 } }
}

/**
 * 投票する。対象が未統合のときだけ票を入れる（判定と書き込みを1文にして、統合と競合しても
 * 統合済みの曲に票が残らないようにする）。入らなかった場合は統合先へ投票し直す。
 */
export async function vote(
  db: Db,
  songId: number,
  voterId: string,
  level: number,
  hop = 0,
): Promise<SongResponse | null> {
  const target = await resolveId(db, songId)
  if (target === null) return null
  const now = new Date()
  const [inserted] = await db.batch([
    db
      .insert(votes)
      .select(
        db
          .select({
            songId: songs.id,
            voterId: sql<string>`${voterId}`.as('voter_id'),
            level: sql<number>`${level}`.as('level'),
            createdAt: sql<number>`${now.getTime()}`.as('created_at'),
            updatedAt: sql<number>`${now.getTime()}`.as('updated_at'),
          })
          .from(songs)
          .where(and(eq(songs.id, target), isNull(songs.mergedInto))),
      )
      .onConflictDoUpdate({ target: [votes.songId, votes.voterId], set: { level, updatedAt: now } })
      .returning({ songId: votes.songId }),
    recomputeAggregates(db, target),
  ])
  if (inserted.length === 0) return hop < MAX_MERGE_HOPS ? vote(db, target, voterId, level, hop + 1) : null
  return getSong(db, target, voterId)
}

/**
 * いいねする（liked=true）／取り消す（liked=false）。どちらも冪等。
 * いいねは投票と同じく、対象が未統合のときだけ入れる。入らなければ統合先でやり直す。
 */
export async function setLike(
  db: Db,
  songId: number,
  voterId: string,
  liked: boolean,
  hop = 0,
): Promise<SongResponse | null> {
  const target = await resolveId(db, songId)
  if (target === null) return null
  if (!liked) {
    await db.batch([
      db.delete(likes).where(and(eq(likes.songId, target), eq(likes.voterId, voterId))),
      recomputeLikes(db, target),
    ])
    return getSong(db, target, voterId)
  }
  const [inserted] = await db.batch([
    db
      .insert(likes)
      .select(
        db
          .select({
            songId: songs.id,
            voterId: sql<string>`${voterId}`.as('voter_id'),
            createdAt: sql<number>`${Date.now()}`.as('created_at'),
          })
          .from(songs)
          .where(and(eq(songs.id, target), isNull(songs.mergedInto))),
      )
      // 既にいいね済みでも行を返させるため、DO NOTHING ではなく同値で更新する
      .onConflictDoUpdate({ target: [likes.songId, likes.voterId], set: { songId: sql`excluded.song_id` } })
      .returning({ songId: likes.songId }),
    recomputeLikes(db, target),
  ])
  if (inserted.length === 0) return hop < MAX_MERGE_HOPS ? setLike(db, target, voterId, liked, hop + 1) : null
  return getSong(db, target, voterId)
}

export async function ranking(db: Db, opts: { level?: number; sort: Sort; cursor: number }): Promise<RankingResponse> {
  const conditions = [isNull(songs.mergedInto)]
  // easy/hard は avg_level IS NOT NULL（= 票あり）にして songs_ranking 索引の順で読む
  if (opts.sort === 'easy' || opts.sort === 'hard') conditions.push(isNotNull(songs.avgLevel))
  if (opts.sort === 'votes') conditions.push(gte(songs.voteCount, 1))
  // いいね順（既定）は、いいねか難易度の票が1つ以上ある曲
  if (opts.sort === 'likes') conditions.push(or(gte(songs.likeCount, 1), isNotNull(songs.avgLevel)) as SQL)
  if (opts.level !== undefined) {
    // levelOf() の四捨五入と同じ区切り。端のレベルは片側を開く
    if (opts.level > 1) conditions.push(gte(songs.avgLevel, opts.level - 0.5))
    if (opts.level < MAX_LEVEL) conditions.push(lt(songs.avgLevel, opts.level + 0.5))
  }
  const order = {
    easy: [asc(songs.avgLevel), desc(songs.voteCount), asc(songs.id)],
    hard: [desc(songs.avgLevel), desc(songs.voteCount), asc(songs.id)],
    votes: [desc(songs.voteCount), asc(songs.id)],
    likes: [desc(songs.likeCount), desc(songs.voteCount), asc(songs.id)],
    new: [desc(songs.createdAt), desc(songs.id)],
  }[opts.sort]

  const rows = await db
    .select(summaryColumns)
    .from(songs)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(RANKING_PAGE_SIZE + 1)
    .offset(opts.cursor)
  const hasMore = rows.length > RANKING_PAGE_SIZE
  return { items: rows.slice(0, RANKING_PAGE_SIZE), nextCursor: hasMore ? opts.cursor + RANKING_PAGE_SIZE : null }
}
