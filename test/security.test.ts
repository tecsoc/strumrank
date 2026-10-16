import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { MAX_REGISTRATIONS_PER_IP_PER_DAY, MAX_REGISTRATIONS_PER_VOTER_PER_DAY } from '../src/worker/songs'
import { MAX_PER_SONG_PER_IP } from '../src/worker/voter'
import { verifiedVoter, voter } from './voters'

const ORIGIN = 'http://example.com'
let seq = 0
const uniqueArtist = () => `sec-${++seq}-${Math.random().toString(36).slice(2, 8)}`
// テストごとに別の /24 にして、回線ごとの上限が他のテストと混ざらないようにする
const uniqueIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${(seq++ % 200) + 1}`
const trackId = () => Math.floor(Math.random() * 1e9) + 1

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  headers.set('Origin', ORIGIN)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.cookie) headers.set('Cookie', init.cookie)
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }))
}

const register = (cookie: string | undefined, title: string, artist: string) =>
  call('/api/songs', { method: 'POST', cookie, body: JSON.stringify({ itunesTrackId: trackId(), title, artist }) })

describe('曲の登録（S1）', () => {
  it('未確認の利用者は登録できない（401 で確認を求める）', async () => {
    const res = await register(undefined, '登録できない曲', uniqueArtist())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'verification_required' })
  })

  it('1人1日の新しい曲の登録には上限があり、既存の曲への紐づけは数えない', async () => {
    const cookie = await verifiedVoter(ORIGIN, uniqueIp())
    const artist = uniqueArtist()
    for (let i = 0; i < MAX_REGISTRATIONS_PER_VOTER_PER_DAY; i++) {
      expect((await register(cookie, `曲${i}`, artist)).status).toBe(201)
    }
    const over = await register(cookie, '上限を超える曲', artist)
    expect(over.status).toBe(429)
    expect(await over.json()).toEqual({ error: 'too_many_registrations' })
    // 登録済みの曲（別の録音）への紐づけは上限後でもできる
    const existing = await register(cookie, '曲0 (Live)', artist)
    expect(existing.status).toBe(200)
  })

  it('同じ回線からの新しい曲の登録にも上限がある（投票者を作り直しても超えられない）', async () => {
    const ip = uniqueIp()
    const artist = uniqueArtist()
    const perVoter = MAX_REGISTRATIONS_PER_VOTER_PER_DAY
    const voters = await Promise.all(
      Array.from({ length: Math.ceil(MAX_REGISTRATIONS_PER_IP_PER_DAY / perVoter) + 1 }, () =>
        verifiedVoter(ORIGIN, ip),
      ),
    )
    let created = 0
    let capped = 0
    for (const [v, cookie] of voters.entries()) {
      for (let i = 0; i < perVoter; i++) {
        const res = await register(cookie, `回線${v}-${i}`, artist)
        if (res.status === 201) created++
        if (res.status === 429) capped++
      }
    }
    expect(created).toBe(MAX_REGISTRATIONS_PER_IP_PER_DAY)
    expect(capped).toBeGreaterThan(0)
  })
})

describe('1曲あたりの回線上限は同時に送っても破れない（S2）', () => {
  it('同じ回線の投票者が同時に投票しても、入るのは上限まで', async () => {
    const ip = uniqueIp()
    const songRes = await register(voter(31), '同時投票の曲', uniqueArtist())
    const { id } = (await songRes.json()) as { id: number }
    const cookies = await Promise.all(Array.from({ length: 6 }, () => verifiedVoter(ORIGIN, ip)))
    const results = await Promise.all(
      cookies.map((cookie) =>
        call(`/api/songs/${id}/vote`, { method: 'PUT', cookie, body: JSON.stringify({ level: 2 }) }),
      ),
    )
    const ok = results.filter((r) => r.status === 200).length
    expect(ok).toBe(MAX_PER_SONG_PER_IP)
    expect(results.filter((r) => r.status === 429)).toHaveLength(cookies.length - MAX_PER_SONG_PER_IP)

    const likes = await Promise.all(cookies.map((cookie) => call(`/api/songs/${id}/like`, { method: 'PUT', cookie })))
    expect(likes.filter((r) => r.status === 200)).toHaveLength(MAX_PER_SONG_PER_IP)
  })
})

describe('読み取りの制限（S3・S5）', () => {
  it('ランキングのページ送りは 100 件目までに制限する', async () => {
    expect((await call('/api/ranking?cursor=100')).status).toBe(200)
    expect((await call('/api/ranking?cursor=101')).status).toBe(400)
  })

  it('1〜2文字だけの補完は前方一致に限る（全件の部分一致はしない）', async () => {
    const artist = uniqueArtist()
    const front = (await (await register(voter(32), '糸', artist)).json()) as { id: number }
    const middle = (await (await register(voter(32), '赤い糸', artist)).json()) as { id: number }
    const ids = (
      (await (await call(`/api/songs/suggest?q=${encodeURIComponent('糸')}`)).json()) as { id: number }[]
    ).map((s) => s.id)
    expect(ids).toContain(front.id)
    expect(ids).not.toContain(middle.id)
  })

  it('照合は（アーティスト, 曲名）の完全一致だけを引き、同じアーティストの別の曲は読まない', async () => {
    const artist = uniqueArtist()
    const a = (await (await register(voter(33), '照合する曲', artist)).json()) as { id: number }
    await register(voter(33), '照合しない曲', artist)
    const res = await call('/api/songs/resolve', {
      method: 'POST',
      body: JSON.stringify({ items: [{ itunesTrackId: trackId(), title: '照合する曲', artist }] }),
    })
    expect(Object.values((await res.json()) as Record<string, number>)).toEqual([a.id])
  })
})

describe('API の応答ヘッダー（S6）', () => {
  it('枠への埋め込みと MIME の推測を禁止し、何も読み込ませない', async () => {
    const res = await call('/api/ranking')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  it('投票者ごとの状態を含む応答はキャッシュさせない', async () => {
    const song = (await (await register(voter(34), 'キャッシュしない曲', uniqueArtist())).json()) as { id: number }
    expect((await call(`/api/songs/${song.id}`)).headers.get('Cache-Control')).toBe('no-store')
    expect((await call('/api/session')).headers.get('Cache-Control')).toBe('no-store')
  })
})
