import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { RankingResponse, SongResponse } from '../src/shared/api'
import { createDb } from '../src/worker/db/client'
import { enrichSong } from '../src/worker/musicbrainz'
import { verifiedVoter, voter } from './voters'

const ORIGIN = 'http://example.com'
let seq = 0
/** テスト間で曲が衝突しないよう、アーティスト名を毎回変える */
const uniqueArtist = (name = 'artist') => `${name}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  headers.set('Origin', ORIGIN)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.cookie) headers.set('Cookie', init.cookie)
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }))
}

async function register(title: string, artist: string, itunesTrackId = Math.floor(Math.random() * 1e9) + 1) {
  const res = await call('/api/songs', { method: 'POST', body: JSON.stringify({ itunesTrackId, title, artist }) })
  return { status: res.status, body: (await res.json()) as { id: number; created: boolean } }
}

async function voteAs(cookie: string, songId: number, level: number) {
  return call(`/api/songs/${songId}/vote`, { method: 'PUT', cookie, body: JSON.stringify({ level }) })
}

describe('曲の登録と名寄せ', () => {
  it('シングル版とアルバム版（別の iTunes ID）は同じ曲になる', async () => {
    const artist = uniqueArtist()
    const single = await register('マリーゴールド', artist, 1402042897)
    const album = await register('マリーゴールド', artist, 1446781787)
    expect(single.status).toBe(201)
    expect(album.status).toBe(200)
    expect(album.body.id).toBe(single.body.id)
  })

  it('ライブ版の付記付きの曲名も同じ曲になる', async () => {
    const artist = uniqueArtist()
    const studio = await register('マリーゴールド', artist)
    const live = await register('マリーゴールド (Live in 阪神甲子園球場, 2022.11.05)', artist)
    expect(live.body.id).toBe(studio.body.id)
  })

  it('同じ曲名でもアーティストが違えば別の曲', async () => {
    const a = await register('糸', uniqueArtist())
    const b = await register('糸', uniqueArtist())
    expect(a.body.id).not.toBe(b.body.id)
  })

  it('インストゥルメンタル・カラオケは登録できない', async () => {
    const res = await register('マリーゴールド (Instrumental)', uniqueArtist())
    expect(res.status).toBe(422)
  })

  it('Apple 以外のドメインの URL は受け付けない', async () => {
    const res = await call('/api/songs', {
      method: 'POST',
      body: JSON.stringify({ itunesTrackId: 1, title: 'x', artist: 'y', artworkUrl: 'https://evil.example/a.jpg' }),
    })
    expect(res.status).toBe(400)
  })

  it('検索結果の別録音も登録済みの曲に対応づく', async () => {
    const artist = uniqueArtist()
    const { body } = await register('水平線', artist, 111)
    const res = await call('/api/songs/resolve', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { itunesTrackId: 111, title: '水平線', artist },
          { itunesTrackId: 222, title: '水平線 (Live)', artist },
          { itunesTrackId: 333, title: '未登録の曲', artist },
        ],
      }),
    })
    expect(await res.json()).toEqual({ '111': body.id, '222': body.id })
  })
})

describe('投票', () => {
  it('1人1票で、投票し直すと上書きされ、平均と分布が更新される', async () => {
    const { body } = await register('ロビンソン', uniqueArtist())
    await voteAs(voter(1), body.id, 1)
    await voteAs(voter(1), body.id, 3)
    const res = await voteAs(voter(2), body.id, 4)
    const data = (await res.json()) as SongResponse
    if (!('song' in data)) throw new Error('unexpected merge')
    expect(data.song.voteCount).toBe(2)
    expect(data.song.avgLevel).toBe(3.5)
    expect(data.song.distribution).toEqual([0, 0, 1, 1])
    expect(data.song.myVote).toBe(4)
  })

  it('範囲外の難易度は拒否する', async () => {
    const { body } = await register('チェリー', uniqueArtist())
    expect((await voteAs(voter(1), body.id, 5)).status).toBe(400)
    expect((await voteAs(voter(1), body.id, 0)).status).toBe(400)
  })

  it('未確認でも曲は見られるが、cookie は発行せず myVote/myLike は空', async () => {
    const { body } = await register('夏色', uniqueArtist())
    const res = await call(`/api/songs/${body.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    const data = (await res.json()) as SongResponse
    if (!('song' in data)) throw new Error('unexpected merge')
    expect(data.song.myVote).toBeNull()
    expect(data.song.myLike).toBe(false)
  })

  it('確認していない（署名の無い・偽造した）投票者の票といいねは 401', async () => {
    const { body } = await register('楓', uniqueArtist())
    const forged = 'sr_vid=00000000-0000-4000-8000-000000000001'
    expect((await voteAs(forged, body.id, 2)).status).toBe(401)
    expect(
      (await call(`/api/songs/${body.id}/vote`, { method: 'PUT', body: JSON.stringify({ level: 2 }) })).status,
    ).toBe(401)
    expect((await call(`/api/songs/${body.id}/like`, { method: 'PUT', cookie: forged })).status).toBe(401)
  })

  it('Turnstile を通して発行された投票者は投票できる', async () => {
    const { body } = await register('ハナミズキ', uniqueArtist())
    const cookie = await verifiedVoter(ORIGIN, '198.51.100.7')
    expect(cookie).toMatch(/^sr_vid=[0-9a-f-]{36}\./)
    expect((await voteAs(cookie, body.id, 1)).status).toBe(200)
  })

  it('同じ回線の投票者からの票・いいねは1曲3件まで（既存票の変更は許す）', async () => {
    const { body } = await register('栄光の架橋', uniqueArtist())
    const ip = `192.0.2.${Math.floor(Math.random() * 250)}-${Math.random().toString(36).slice(2, 8)}`
    const cookies = [] as string[]
    for (let i = 0; i < 4; i++) cookies.push(await verifiedVoter(ORIGIN, ip))
    const [a, b, c, d] = cookies as [string, string, string, string]
    for (const k of [a, b, c]) expect((await voteAs(k, body.id, 2)).status).toBe(200)
    const blocked = await voteAs(d, body.id, 2)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'too_many_from_network' })
    expect((await voteAs(a, body.id, 3)).status).toBe(200) // 自分の票の変更は数えない

    for (const k of [a, b, c])
      expect((await call(`/api/songs/${body.id}/like`, { method: 'PUT', cookie: k })).status).toBe(200)
    expect((await call(`/api/songs/${body.id}/like`, { method: 'PUT', cookie: d })).status).toBe(429)
    expect((await call(`/api/songs/${body.id}/like`, { method: 'DELETE', cookie: a })).status).toBe(200) // 取り消しは対象外
  })

  // JSON はブラウザがプリフライトで止めるため、プリフライト不要な text/plain で偽装される場合を確かめる
  it('他サイトからのフォーム型リクエスト（Origin 不一致）は拒否する', async () => {
    const { body } = await register('蕾', uniqueArtist())
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/api/songs/${body.id}/vote`, {
        method: 'PUT',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain', Cookie: voter(1) },
        body: JSON.stringify({ level: 1 }),
      }),
    )
    expect(res.status).toBe(403)
  })
})

describe('ランキング', () => {
  it('難易度で絞り込める（平均の四捨五入で区切る）', async () => {
    const artist = uniqueArtist('rank')
    const easy = (await register('かんたんな曲', artist)).body.id
    const mid = (await register('ふつうの曲', artist)).body.id
    await voteAs(voter(1), easy, 1)
    await voteAs(voter(2), easy, 2) // 平均 1.5 → 中級者向け
    await voteAs(voter(1), mid, 2)

    const res = await call('/api/ranking?level=2&sort=easy')
    const { items } = (await res.json()) as RankingResponse
    const ids = items.map((i) => i.id)
    expect(ids).toContain(easy)
    expect(ids).toContain(mid)

    const level1 = (await (await call('/api/ranking?level=1')).json()) as RankingResponse
    expect(level1.items.map((i) => i.id)).not.toContain(easy)
  })

  it('票の無い曲は新着以外に出ない', async () => {
    const { body } = await register('票なし', uniqueArtist())
    const byVotes = (await (await call('/api/ranking?sort=votes')).json()) as RankingResponse
    const byNew = (await (await call('/api/ranking?sort=new')).json()) as RankingResponse
    expect(byVotes.items.map((i) => i.id)).not.toContain(body.id)
    expect(byNew.items.map((i) => i.id)).toContain(body.id)
  })
})

describe('MusicBrainz の work による統合', () => {
  const deps = (workId: string) => ({
    sleep: async () => {},
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/recording?')) return Response.json({ recordings: [{ id: 'rec-1', score: 100 }] })
      return Response.json({ relations: [{ work: { id: workId } }] })
    }) as typeof fetch,
  })

  it('同じアーティストの同じ work は古い方へ統合され、票も移る（重複票は残さない）', async () => {
    const db = createDb(env.DB)
    const artist = uniqueArtist()
    const older = (await register('蕾', artist)).body.id
    const newer = (await register('蕾(つぼみ)', artist)).body.id
    expect(newer).not.toBe(older) // 正規化では吸収できない表記ゆれ
    await voteAs(voter(1), older, 2)
    await voteAs(voter(1), newer, 4) // 同じ投票者 → 統合先の票を残す
    await voteAs(voter(2), newer, 3)

    await enrichSong(db, older, deps('work-tsubomi'))
    await enrichSong(db, newer, deps('work-tsubomi'))

    const merged = (await (await call(`/api/songs/${newer}`)).json()) as SongResponse
    expect(merged).toEqual({ mergedInto: older })
    const target = (await (await call(`/api/songs/${older}`, { cookie: voter(1) })).json()) as SongResponse
    if (!('song' in target)) throw new Error('unexpected merge')
    expect(target.song.voteCount).toBe(2)
    expect(target.song.myVote).toBe(2)
    expect(target.song.distribution).toEqual([0, 1, 1, 0])
  })

  it('別アーティストのカバーは同じ work でも統合しない', async () => {
    const db = createDb(env.DB)
    const original = (await register('糸', uniqueArtist())).body.id
    const cover = (await register('糸', uniqueArtist())).body.id
    await enrichSong(db, original, deps('work-ito'))
    await enrichSong(db, cover, deps('work-ito'))
    const res = (await (await call(`/api/songs/${cover}`)).json()) as SongResponse
    expect('song' in res).toBe(true)
  })
})
