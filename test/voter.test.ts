import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  checkPerSongIpCap,
  hashIp,
  issueVoter,
  MAX_PER_SONG_PER_IP,
  MAX_VOTERS_PER_IP_PER_DAY,
  registerSessionRoutes,
  requireVoter,
  signVoterId,
  type VoterBindings,
  verifyVoterCookie,
} from '../src/worker/voter'

const SECRET = 'test-voter-secret'
const bindings: VoterBindings = {
  DB: env.DB,
  VOTER_SECRET: SECRET,
  TURNSTILE_SECRET: 'turnstile-secret',
  TURNSTILE_SITE_KEY: 'site-key',
}

// voters のマイグレーションは本体の組み込み時に drizzle-kit で生成するため、
// それまではテスト内で同じ定義のテーブルを作る（生成後は IF NOT EXISTS で何もしない）
beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS voters (id text PRIMARY KEY NOT NULL, ip_hash text NOT NULL, created_at integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL)",
  )
})

let ipSeq = 0
const uniqueIp = () => `203.0.113.${++ipSeq}-${Math.random().toString(36).slice(2, 8)}`

/** siteverify の結果を固定したテスト用アプリ */
function createApp(turnstileSuccess: boolean) {
  const app = new Hono<{ Bindings: VoterBindings; Variables: { voterId: string } }>().basePath('/api')
  registerSessionRoutes(app, {
    fetch: (async () => Response.json({ success: turnstileSuccess })) as unknown as typeof fetch,
  })
  app.put('/protected', requireVoter, (c) => c.json({ voterId: c.var.voterId }))
  return (path: string, init: RequestInit & { ip?: string; cookie?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.ip) headers.set('cf-connecting-ip', init.ip)
    if (init.cookie) headers.set('Cookie', init.cookie)
    if (init.body) headers.set('Content-Type', 'application/json')
    return app.fetch(new Request(`https://example.com${path}`, { ...init, headers }), bindings)
  }
}

const cookieOf = (res: Response) => res.headers.get('Set-Cookie')?.split(';')[0] ?? ''

describe('署名付きの投票者 ID', () => {
  it('サーバーが署名した ID だけを受け付ける', async () => {
    const id = crypto.randomUUID()
    const signed = await signVoterId(SECRET, id)
    expect(await verifyVoterCookie(SECRET, signed)).toBe(id)
  })

  it('未署名の旧形式・改ざん・別の鍵の署名は拒否する', async () => {
    const id = crypto.randomUUID()
    const signed = await signVoterId(SECRET, id)
    const other = crypto.randomUUID()
    expect(await verifyVoterCookie(SECRET, id)).toBeNull()
    expect(await verifyVoterCookie(SECRET, `${other}${signed.slice(id.length)}`)).toBeNull()
    expect(await verifyVoterCookie(SECRET, `${signed.slice(0, -1)}A`)).toBeNull()
    expect(await verifyVoterCookie('another-secret', signed)).toBeNull()
    expect(await verifyVoterCookie(SECRET, undefined)).toBeNull()
  })
})

describe('確認（Turnstile）と投票者 ID の発行', () => {
  it('確認前は投票できず、確認後に発行された cookie で投票できる', async () => {
    const call = createApp(true)
    const ip = uniqueIp()
    expect((await call('/api/protected', { method: 'PUT', ip })).status).toBe(401)

    const res = await call('/api/session', { method: 'POST', ip, body: JSON.stringify({ token: 'ok' }) })
    expect(res.status).toBe(200)
    const cookie = cookieOf(res)
    expect(res.headers.get('Set-Cookie')).toMatch(/HttpOnly/)

    const voted = await call('/api/protected', { method: 'PUT', ip, cookie })
    expect(voted.status).toBe(200)
  })

  it('Turnstile の検証に失敗したら発行しない', async () => {
    const res = await createApp(false)('/api/session', {
      method: 'POST',
      ip: uniqueIp(),
      body: JSON.stringify({ token: 'bad' }),
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('同じ回線からの発行は24時間で上限まで', async () => {
    const call = createApp(true)
    const ip = uniqueIp()
    for (let i = 0; i < MAX_VOTERS_PER_IP_PER_DAY; i++) {
      const res = await call('/api/session', { method: 'POST', ip, body: JSON.stringify({ token: 'ok' }) })
      expect(res.status).toBe(200)
    }
    const over = await call('/api/session', { method: 'POST', ip, body: JSON.stringify({ token: 'ok' }) })
    expect(over.status).toBe(429)
    // 別の回線は影響を受けない
    const other = await call('/api/session', { method: 'POST', ip: uniqueIp(), body: JSON.stringify({ token: 'ok' }) })
    expect(other.status).toBe(200)
  })

  it('24時間たてば同じ回線から再び発行できる', async () => {
    const ip = uniqueIp()
    const old = Date.now() - 25 * 60 * 60 * 1000
    for (let i = 0; i < MAX_VOTERS_PER_IP_PER_DAY; i++) await issueVoter(env.DB, SECRET, ip, old)
    expect(await issueVoter(env.DB, SECRET, ip)).not.toBeNull()
  })

  it('IP は生のまま保存しない', async () => {
    const ip = uniqueIp()
    const id = await issueVoter(env.DB, SECRET, ip)
    const row = await env.DB.prepare('SELECT ip_hash FROM voters WHERE id = ?').bind(id).first<{ ip_hash: string }>()
    expect(row?.ip_hash).toBe(await hashIp(SECRET, ip))
    expect(row?.ip_hash).not.toContain(ip)
  })
})

describe('1曲あたりの同じ回線からの票の上限', () => {
  async function newSong(): Promise<number> {
    const t = `cap-${Math.random().toString(36).slice(2)}`
    const row = await env.DB.prepare(
      'INSERT INTO songs (title, artist, title_norm, artist_norm) VALUES (?1, ?1, ?1, ?1) RETURNING id',
    )
      .bind(t)
      .first<{ id: number }>()
    if (!row) throw new Error('insert failed')
    return row.id
  }
  const voteRow = (songId: number, voterId: string) =>
    env.DB.prepare('INSERT INTO votes (song_id, voter_id, level) VALUES (?, ?, 2)').bind(songId, voterId).run()
  const likeRow = (songId: number, voterId: string) =>
    env.DB.prepare('INSERT INTO likes (song_id, voter_id) VALUES (?, ?)').bind(songId, voterId).run()

  it.each([
    ['votes', voteRow],
    ['likes', likeRow],
  ] as const)('%s: 上限までは入れられ、超えると拒否する。別の回線と自分の票の変更は数えない', async (table, insert) => {
    const songId = await newSong()
    const ip = uniqueIp()
    const sameNetwork: string[] = []
    for (let i = 0; i <= MAX_PER_SONG_PER_IP; i++) {
      const id = await issueVoter(env.DB, SECRET, ip)
      if (!id) throw new Error('issue failed')
      sameNetwork.push(id)
    }
    for (const id of sameNetwork.slice(0, MAX_PER_SONG_PER_IP)) {
      expect(await checkPerSongIpCap(env.DB, table, songId, id)).toBe(true)
      await insert(songId, id)
    }
    const last = sameNetwork[MAX_PER_SONG_PER_IP] as string
    expect(await checkPerSongIpCap(env.DB, table, songId, last)).toBe(false)
    // 既に票を入れた人の変更は許可
    expect(await checkPerSongIpCap(env.DB, table, songId, sameNetwork[0] as string)).toBe(true)
    // 別の回線の人は許可
    const other = await issueVoter(env.DB, SECRET, uniqueIp())
    expect(await checkPerSongIpCap(env.DB, table, songId, other as string)).toBe(true)
  })
})
