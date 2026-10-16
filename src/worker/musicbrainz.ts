import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { Db } from './db/client'
import { likes, songSources, songs, votes } from './db/schema'
import { recomputeAggregates, recomputeLikes, resolveId } from './songs'

const API = 'https://musicbrainz.org/ws/2'
// MusicBrainz は連絡先入りの User-Agent と 1秒1リクエスト以下を求めている
const USER_AGENT = 'strumrank/0.1 ( https://github.com/tecsoc/strumrank )'
const MIN_INTERVAL_MS = 1100
const TIMEOUT_MS = 5000
const MIN_SCORE = 90
export const MAX_ATTEMPTS = 5
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000

export type Deps = { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now?: () => Date }
const defaultDeps: Deps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

type SearchResponse = { recordings?: { id: string; score?: number }[] }
type RecordingResponse = { relations?: { work?: { id: string }; url?: { resource?: string } }[] }

const SPOTIFY_TRACK =
  /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([A-Za-z0-9]{22})(?:[/?#].*)?$/

/** url-rels から Spotify の曲ページ URL を取り出す。クエリ等は除き、ID の形式が正しいものだけ採用する */
export function spotifyTrackUrl(relations: RecordingResponse['relations']): string | null {
  for (const r of relations ?? []) {
    const m = r.url?.resource ? SPOTIFY_TRACK.exec(r.url.resource) : null
    if (m) return `https://open.spotify.com/track/${m[1]}`
  }
  return null
}

export type RecordingMatch = { workId: string | null; spotifyUrl: string | null }

// Lucene の特殊文字をエスケープする
function escapeQuery(s: string): string {
  return s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1')
}

async function getJson<T>(deps: Deps, url: string): Promise<T> {
  const res = await deps.fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`)
  return res.json() as Promise<T>
}

/**
 * 曲名とアーティスト名から MusicBrainz の work ID と Spotify の曲ページを探す。
 * 問い合わせ回数を増やさないよう、work を見つけた時点で打ち切り、それまでに見た recording の Spotify URL を使う。
 */
export async function findRecordingMatch(
  title: string,
  artist: string,
  deps: Deps = defaultDeps,
): Promise<RecordingMatch> {
  const query = `recording:"${escapeQuery(title)}" AND artist:"${escapeQuery(artist)}"`
  const search = await getJson<SearchResponse>(
    deps,
    `${API}/recording?${new URLSearchParams({ query, fmt: 'json', limit: '5' })}`,
  )
  const candidates = (search.recordings ?? []).filter((r) => (r.score ?? 0) >= MIN_SCORE).slice(0, 2)
  let spotifyUrl: string | null = null
  for (const rec of candidates) {
    await deps.sleep(MIN_INTERVAL_MS)
    const detail = await getJson<RecordingResponse>(deps, `${API}/recording/${rec.id}?inc=work-rels+url-rels&fmt=json`)
    spotifyUrl ??= spotifyTrackUrl(detail.relations)
    const workId = detail.relations?.find((r) => r.work)?.work?.id
    if (workId) return { workId, spotifyUrl }
  }
  return { workId: null, spotifyUrl }
}

/** 曲名とアーティスト名から MusicBrainz の work ID を探す。見つからなければ null。 */
export async function findWorkId(title: string, artist: string, deps: Deps = defaultDeps): Promise<string | null> {
  return (await findRecordingMatch(title, artist, deps)).workId
}

/**
 * src の曲を target に統合する。票は target に移し、同じ投票者の票は target 側を残す。
 * target が統合済みなら統合先をたどり、src が既に統合済みなら何もしない（循環を作らない）。
 */
export async function mergeSong(db: Db, srcId: number, targetId: number): Promise<void> {
  const target = await resolveId(db, targetId)
  if (target === null || target === srcId) return
  const src = await db.select({ mergedInto: songs.mergedInto }).from(songs).where(eq(songs.id, srcId)).get()
  if (!src || src.mergedInto !== null) return

  await db.batch([
    db.update(songSources).set({ songId: target }).where(eq(songSources.songId, srcId)),
    db
      .insert(votes)
      .select(
        db
          .select({
            songId: sql<number>`${target}`.as('song_id'),
            voterId: votes.voterId,
            level: votes.level,
            createdAt: votes.createdAt,
            updatedAt: votes.updatedAt,
          })
          .from(votes)
          .where(eq(votes.songId, srcId)),
      )
      .onConflictDoNothing(),
    db.delete(votes).where(eq(votes.songId, srcId)),
    db
      .insert(likes)
      .select(
        db
          .select({ songId: sql<number>`${target}`.as('song_id'), voterId: likes.voterId, createdAt: likes.createdAt })
          .from(likes)
          .where(eq(likes.songId, srcId)),
      )
      .onConflictDoNothing(),
    db.delete(likes).where(eq(likes.songId, srcId)),
    // src に統合されていた曲も target を指すようにする
    db.update(songs).set({ mergedInto: target }).where(eq(songs.mergedInto, srcId)),
    db
      .update(songs)
      .set({ mergedInto: target, voteCount: 0, avgLevel: null, likeCount: 0 })
      .where(and(eq(songs.id, srcId), isNull(songs.mergedInto))),
    // 統合先に Spotify の曲ページが無ければ統合元のものを引き継ぐ
    db
      .update(songs)
      .set({ spotifyUrl: sql`(SELECT ${songs.spotifyUrl} FROM ${songs} WHERE ${songs.id} = ${srcId})` })
      .where(and(eq(songs.id, target), isNull(songs.spotifyUrl))),
    recomputeAggregates(db, target),
    recomputeLikes(db, target),
  ])
}

/** 一時的な失敗として、指数バックオフで再試行の予定を入れる */
async function scheduleRetry(db: Db, songId: number, attemptsSoFar: number, deps: Deps) {
  const attempts = attemptsSoFar + 1
  const now = (deps.now ?? (() => new Date()))()
  const backoff = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 60_000)
  await db
    .update(songs)
    .set({ mbStatus: 'error', mbAttempts: attempts, mbNextTryAt: new Date(now.getTime() + backoff) })
    .where(eq(songs.id, songId))
}

/**
 * 1曲の work ID を MusicBrainz で調べて記録する。同じアーティストの同じ work が
 * 他にあれば、新しい方を古い方（ID の小さい方）へ統合する。カバー曲は別アーティストなので統合しない。
 * 一時的な失敗（5xx・429・タイムアウト等）は指数バックオフで再試行の予定を入れる。
 */
export async function enrichSong(db: Db, songId: number, deps: Deps = defaultDeps): Promise<void> {
  const song = await db.select().from(songs).where(eq(songs.id, songId)).get()
  if (!song || song.mergedInto !== null || song.mbStatus === 'done' || song.mbStatus === 'not_found') return

  let match: RecordingMatch
  try {
    match = await findRecordingMatch(song.title, song.artist, deps)
  } catch {
    await scheduleRetry(db, songId, song.mbAttempts, deps)
    return
  }
  const spotifyUrl = song.spotifyUrl ?? match.spotifyUrl
  const workId = match.workId
  if (!workId) {
    await db.update(songs).set({ mbStatus: 'not_found', spotifyUrl }).where(eq(songs.id, songId))
    return
  }

  // 統合まで終えて初めて done にする。途中で失敗したら error に戻して再試行させる
  // （done のまま残ると Cron の対象外になり、重複が恒久化する）
  try {
    await db
      .update(songs)
      .set({ mbWorkId: workId, mbStatus: 'done', mbNextTryAt: null, spotifyUrl })
      .where(eq(songs.id, songId))
    const other = await db
      .select({ id: songs.id })
      .from(songs)
      .where(
        and(
          eq(songs.artistNorm, song.artistNorm),
          eq(songs.mbWorkId, workId),
          isNull(songs.mergedInto),
          ne(songs.id, songId),
        ),
      )
      .orderBy(asc(songs.id))
      .get()
    // 統合の向きは常に「新しい → 古い」に固定する
    if (other) await mergeSong(db, Math.max(songId, other.id), Math.min(songId, other.id))
  } catch {
    await scheduleRetry(db, songId, song.mbAttempts, deps)
  }
}

/**
 * Cron から1分に1回呼ぶ。未処理・再試行待ちの曲を古い順に1件だけ処理する。
 * 1回の実行で問い合わせは最大3回（約1.1秒間隔）なので、MusicBrainz の 1req/s を守れる。
 */
export async function processPending(db: Db, deps: Deps = defaultDeps): Promise<number | null> {
  const now = (deps.now ?? (() => new Date()))()
  const next = await db
    .select({ id: songs.id })
    .from(songs)
    .where(
      and(
        isNull(songs.mergedInto),
        inArray(songs.mbStatus, ['pending', 'error']),
        lt(songs.mbAttempts, MAX_ATTEMPTS),
        or(isNull(songs.mbNextTryAt), lte(songs.mbNextTryAt, now)),
      ),
    )
    .orderBy(asc(songs.id))
    .get()
  if (!next) return null
  await enrichSong(db, next.id, deps)
  return next.id
}
