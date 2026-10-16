import { env, exports } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { SongResponse } from '../src/shared/api'
import { createDb } from '../src/worker/db/client'
import { likes, songs, votes } from '../src/worker/db/schema'
import { type Deps, enrichSong, MAX_ATTEMPTS, mergeSong, processPending } from '../src/worker/musicbrainz'
import { registerSong, setLike, vote } from '../src/worker/songs'

const db = createDb(env.DB)
let seq = 0
const uniqueArtist = () => `merge-artist-${++seq}-${Math.random().toString(36).slice(2, 8)}`
const voter = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const trackId = () => Math.floor(Math.random() * 1e9) + 1

const register = async (title: string, artist: string) =>
  (await registerSong(db, { itunesTrackId: trackId(), title, artist })).id

/** 指定した work ID を返す MusicBrainz のモック */
const mbReturning = (workId: string): Deps => ({
  sleep: async () => {},
  fetch: (async (input: RequestInfo | URL) =>
    String(input).includes('/recording?')
      ? Response.json({ recordings: [{ id: 'rec', score: 100 }] })
      : Response.json({ relations: [{ work: { id: workId } }] })) as typeof fetch,
})

const mbFailing = (status = 503): Deps => ({
  sleep: async () => {},
  fetch: (async () => new Response('busy', { status })) as typeof fetch,
})

const getSongRow = (id: number) => db.select().from(songs).where(eq(songs.id, id)).get()

async function songResponse(id: number) {
  const res = await exports.default.fetch(new Request(`http://example.com/api/songs/${id}`))
  return (await res.json()) as SongResponse
}

describe('統合が循環しない', () => {
  it('同じ work の2曲をどの順で調べても、新しい方だけが古い方へ統合される', async () => {
    const artist = uniqueArtist()
    const older = await register('蕾', artist)
    const newer = await register('蕾(つぼみ)', artist)
    // 新しい方を先に調べる（古い方はまだ work ID を持たない）
    await enrichSong(db, newer, mbReturning('w-cycle'))
    await enrichSong(db, older, mbReturning('w-cycle'))
    expect((await getSongRow(older))?.mergedInto).toBeNull()
    expect((await getSongRow(newer))?.mergedInto).toBe(older)
  })

  it('既に統合済みの曲を src にした統合は何もしない', async () => {
    const artist = uniqueArtist()
    const a = await register('曲A', artist)
    const b = await register('曲B', artist)
    await mergeSong(db, b, a)
    await mergeSong(db, a, b) // b は統合済みなので統合先 a に解決され、a→a は何もしない
    expect((await getSongRow(a))?.mergedInto).toBeNull()
    expect((await getSongRow(b))?.mergedInto).toBe(a)
  })
})

describe('統合済みの曲の扱い', () => {
  it('統合済みの曲と同じ正規化キーで登録すると、統合先の曲になる', async () => {
    const artist = uniqueArtist()
    const target = await register('ひまわりの約束', artist)
    const src = await register('ひまわり', artist)
    await mergeSong(db, src, target)
    const again = await registerSong(db, { itunesTrackId: trackId(), title: 'ひまわり', artist })
    expect(again).toEqual({ id: target, created: false })
  })

  it('統合済みの曲への投票は統合先に入り、統合済みの曲の集計は 0 のまま', async () => {
    const artist = uniqueArtist()
    const target = await register('夏色', artist)
    const src = await register('夏色 2', artist)
    await mergeSong(db, src, target)
    const res = await vote(db, src, voter(1), 3)
    expect(res && 'song' in res ? res.song.id : null).toBe(target)
    expect((await getSongRow(target))?.voteCount).toBe(1)
    const srcRow = await getSongRow(src)
    expect(srcRow?.voteCount).toBe(0)
    expect(await songResponse(src)).toEqual({ mergedInto: target })
  })
})

describe('Cron による名寄せ', () => {
  it('1回の実行で処理するのは未処理の曲1件だけ', async () => {
    // 他のテストの曲も残っているので、全件処理されるまで回して件数で確かめる
    const artist = uniqueArtist()
    const a = await register('一曲目', artist)
    const b = await register('二曲目', artist)
    const processed: number[] = []
    for (let i = 0; i < 200; i++) {
      const id = await processPending(db, mbReturning(`w-cron-${i}`))
      if (id === null) break
      processed.push(id)
      if (processed.includes(a) && processed.includes(b)) break
    }
    expect(processed.filter((id) => id === a)).toHaveLength(1)
    expect(processed.filter((id) => id === b)).toHaveLength(1)
    expect((await getSongRow(a))?.mbStatus).toBe('done')
  })

  it('一時的な失敗は再試行の予定が入り、予定時刻までは処理されない', async () => {
    const id = await register('再試行の曲', uniqueArtist())
    const now = new Date('2030-01-01T00:00:00Z')
    await enrichSong(db, id, { ...mbFailing(503), now: () => now })
    const row = await getSongRow(id)
    expect(row?.mbStatus).toBe('error')
    expect(row?.mbAttempts).toBe(1)
    expect(row?.mbNextTryAt?.getTime()).toBeGreaterThan(now.getTime())
  })

  it(`${MAX_ATTEMPTS}回失敗したら諦める`, async () => {
    const id = await register('諦める曲', uniqueArtist())
    let t = new Date('2030-01-01T00:00:00Z').getTime()
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await enrichSong(db, id, { ...mbFailing(429), now: () => new Date(t) })
      t += 2 * 24 * 60 * 60 * 1000 // バックオフの上限（1日）より先へ進める
    }
    expect((await getSongRow(id))?.mbAttempts).toBe(MAX_ATTEMPTS)
    // 予定時刻を過ぎていても、上限に達した曲は Cron の対象にならない
    const seen: number[] = []
    for (let i = 0; i < 200; i++) {
      const next = await processPending(db, { ...mbReturning('w-giveup'), now: () => new Date(t) })
      if (next === null) break
      seen.push(next)
    }
    expect(seen).not.toContain(id)
  })
})

describe('統合後に統合元へ票・いいねが残らない', () => {
  it('mergeSong 後、統合元の votes と likes は0件で、統合先に重複なく移る', async () => {
    const artist = uniqueArtist()
    const target = await register('糸', artist)
    const src = await register('糸 (Live)', `${artist}-x`)
    await vote(db, src, voter(71), 2)
    await vote(db, target, voter(71), 4)
    await vote(db, src, voter(72), 1)
    await setLike(db, src, voter(71), true)
    await setLike(db, target, voter(71), true)
    await setLike(db, src, voter(73), true)

    await mergeSong(db, src, target)

    const left = await db.batch([
      db.select().from(votes).where(eq(votes.songId, src)),
      db.select().from(likes).where(eq(likes.songId, src)),
    ])
    expect(left[0]).toHaveLength(0)
    expect(left[1]).toHaveLength(0)
    const t = await getSongRow(target)
    expect(t?.voteCount).toBe(2)
    expect(t?.likeCount).toBe(2)
    const s = await getSongRow(src)
    expect(s?.likeCount).toBe(0)
    expect(s?.voteCount).toBe(0)
  })
})

describe('統合の途中で失敗したら再試行に回す', () => {
  it('work ID は取れたが統合で失敗した曲は done のまま残らない', async () => {
    const artist = uniqueArtist()
    const older = await register('白日', artist)
    const newer = await register('白日（別表記）', artist)
    await enrichSong(db, older, mbReturning('work-hakujitsu'))
    // 統合（mergeSong の batch）だけを一時的に失敗させる
    const original = db.batch.bind(db)
    ;(db as { batch: unknown }).batch = async () => {
      throw new Error('D1 temporary error')
    }
    try {
      await enrichSong(db, newer, mbReturning('work-hakujitsu'))
    } finally {
      ;(db as { batch: unknown }).batch = original
    }
    const row = await getSongRow(newer)
    expect(row?.mbStatus).toBe('error')
    expect(row?.mergedInto).toBeNull()
    expect(row?.mbAttempts).toBe(1)
  })
})
