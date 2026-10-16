import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { RankingResponse, SongResponse } from '../src/shared/api'
import { createDb } from '../src/worker/db/client'
import { mergeSong } from '../src/worker/musicbrainz'
import { registerSong } from '../src/worker/songs'
import { voter } from './voters'

const ORIGIN = 'http://example.com'
const db = createDb(env.DB)
let seq = 0
const uniqueArtist = () => `like-artist-${++seq}-${Math.random().toString(36).slice(2, 8)}`

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  headers.set('Origin', ORIGIN)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.cookie) headers.set('Cookie', init.cookie)
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }))
}

const register = async (title: string, artist = uniqueArtist()) =>
  (await registerSong(db, { itunesTrackId: Math.floor(Math.random() * 1e9) + 1, title, artist })).id

async function like(cookie: string, songId: number, method: 'PUT' | 'DELETE' = 'PUT') {
  const res = await call(`/api/songs/${songId}/like`, { method, cookie })
  return { status: res.status, body: (await res.json()) as SongResponse }
}

const song = (r: SongResponse) => {
  if (!('song' in r)) throw new Error('unexpected merge')
  return r.song
}

async function rankingIds(query = '') {
  const res = await call(`/api/ranking${query}`)
  return ((await res.json()) as RankingResponse).items.map((i) => i.id)
}

describe('いいね', () => {
  it('同じ人が何度いいねしても1件で、取り消すと0件に戻る（冪等）', async () => {
    const id = await register('ロビンソン')
    await like(voter(1), id)
    const twice = song((await like(voter(1), id)).body)
    expect(twice.likeCount).toBe(1)
    expect(twice.myLike).toBe(true)

    const undone = song((await like(voter(1), id, 'DELETE')).body)
    expect(undone.likeCount).toBe(0)
    expect(undone.myLike).toBe(false)
    // 取り消し済みをもう一度取り消してもエラーにならない
    expect((await like(voter(1), id, 'DELETE')).status).toBe(200)
  })

  it('投票なしでいいねできる（いいねと難易度の投票は独立）', async () => {
    const id = await register('チェリー')
    const s = song((await like(voter(2), id)).body)
    expect(s.likeCount).toBe(1)
    expect(s.voteCount).toBe(0)
    expect(s.myVote).toBeNull()
  })

  it('いいねなしで投票できる', async () => {
    const id = await register('夏色')
    const res = await call(`/api/songs/${id}/vote`, {
      method: 'PUT',
      cookie: voter(3),
      body: JSON.stringify({ level: 2 }),
    })
    const s = song((await res.json()) as SongResponse)
    expect(s.voteCount).toBe(1)
    expect(s.likeCount).toBe(0)
    expect(s.myLike).toBe(false)
  })

  it('統合済みの曲へのいいねは統合先に入る', async () => {
    const artist = uniqueArtist()
    const target = await register('蕾', artist)
    const src = await register('蕾(つぼみ)', artist)
    await mergeSong(db, src, target)
    const s = song((await like(voter(4), src)).body)
    expect(s.id).toBe(target)
    expect(s.likeCount).toBe(1)
  })

  it('存在しない曲へのいいねは 404', async () => {
    expect((await like(voter(5), 999_999_999)).status).toBe(404)
  })
})

describe('ランキング（既定はいいね順）', () => {
  it('いいねの多い順に並び、いいねが同数なら票の多い順', async () => {
    const many = await register('いいね2件')
    const few = await register('いいね1件')
    const tieMoreVotes = await register('いいね1件・票あり')
    await like(voter(11), many)
    await like(voter(12), many)
    await like(voter(11), few)
    await like(voter(11), tieMoreVotes)
    await call(`/api/songs/${tieMoreVotes}/vote`, {
      method: 'PUT',
      cookie: voter(11),
      body: JSON.stringify({ level: 1 }),
    })

    const ids = await rankingIds()
    const pos = (id: number) => ids.indexOf(id)
    expect(pos(many)).toBeGreaterThanOrEqual(0)
    expect(pos(many)).toBeLessThan(pos(tieMoreVotes))
    expect(pos(tieMoreVotes)).toBeLessThan(pos(few))
  })

  it('投票だけ・いいねだけの曲も出て、どちらも無い曲は出ない', async () => {
    const onlyVote = await register('票だけ')
    const onlyLike = await register('いいねだけ')
    const none = await register('どちらもなし')
    await call(`/api/songs/${onlyVote}/vote`, { method: 'PUT', cookie: voter(21), body: JSON.stringify({ level: 3 }) })
    await like(voter(21), onlyLike)

    const ids = await rankingIds('?sort=likes')
    expect(ids).toContain(onlyVote)
    expect(ids).toContain(onlyLike)
    expect(ids).not.toContain(none)
  })

  it('難易度の絞り込みはいいね順でも効く', async () => {
    const hard = await register('難しい曲')
    await like(voter(31), hard)
    await call(`/api/songs/${hard}/vote`, { method: 'PUT', cookie: voter(31), body: JSON.stringify({ level: 4 }) })
    expect(await rankingIds('?level=4')).toContain(hard)
    expect(await rankingIds('?level=1')).not.toContain(hard)
  })
})
