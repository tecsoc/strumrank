import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  checkPerSongIpCap,
  DATACENTER_REVERIFY_MS,
  hashIp,
  issueVoter,
  MAX_PER_SONG_PER_IP,
  MAX_PER_SONG_PER_SUBNET,
  MAX_VOTERS_PER_IP_PER_DAY,
  MAX_VOTERS_PER_SUBNET_PER_DAY,
  normalizeIp,
  registerSessionRoutes,
  requireVoter,
  signVoterId,
  subnetOf,
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

// サブネット（/24）単位でも数えるので、テストごとに別の /24 になるようにする
let ipSeq = 0
const netBase = Math.floor(Math.random() * 200)
const uniqueSubnet = () => `10.${netBase}.${++ipSeq % 256}`
const uniqueIp = () => `${uniqueSubnet()}.7`

/** siteverify の結果を固定したテスト用アプリ */
function createApp(turnstileSuccess: boolean) {
  const app = new Hono<{ Bindings: VoterBindings; Variables: { voterId: string } }>().basePath('/api')
  registerSessionRoutes(app, {
    fetch: (async () => Response.json({ success: turnstileSuccess })) as unknown as typeof fetch,
  })
  app.put('/protected', requireVoter, (c) => c.json({ voterId: c.var.voterId }))
  return (path: string, init: RequestInit & { ip?: string; cookie?: string; asn?: number } = {}) => {
    const headers = new Headers(init.headers)
    if (init.ip) headers.set('cf-connecting-ip', init.ip)
    if (init.cookie) headers.set('Cookie', init.cookie)
    if (init.body) headers.set('Content-Type', 'application/json')
    const req = new Request(`https://example.com${path}`, { ...init, headers })
    // 本番では Cloudflare が付ける request.cf を、テストでは差し込む
    if (init.asn !== undefined) Object.defineProperty(req, 'cf', { value: { asn: init.asn } })
    return app.fetch(req, bindings)
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

describe('IP の正規化とサブネット', () => {
  it.each([
    ['203.0.113.45', '203.0.113.45', '203.0.113.0/24'],
    ['::ffff:203.0.113.45', '203.0.113.45', '203.0.113.0/24'],
    ['::ffff:cb00:712d', '203.0.113.45', '203.0.113.0/24'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd:12:0:0:0:1', '2001:db8:abcd::/48'],
    ['2001:DB8:ABCD:FFFF:1:2:3:4', '2001:db8:abcd:ffff:1:2:3:4', '2001:db8:abcd::/48'],
    ['[2001:db8::1]', '2001:db8:0:0:0:0:0:1', '2001:db8:0::/48'],
    ['fe80::1%en0', 'fe80:0:0:0:0:0:0:1', 'fe80:0:0::/48'],
  ])('%s → %s（%s）', (raw, ip, subnet) => {
    expect(normalizeIp(raw)).toBe(ip)
    expect(subnetOf(raw)).toBe(subnet)
  })
})

describe('サブネット単位の上限', () => {
  const post = (call: ReturnType<typeof createApp>, ip: string) =>
    call('/api/session', { method: 'POST', ip, body: JSON.stringify({ token: 'ok' }) })

  it('同じ /24 の別の IP でも、発行は24時間でサブネットの上限まで', async () => {
    const call = createApp(true)
    const net = uniqueSubnet()
    for (let i = 0; i < MAX_VOTERS_PER_SUBNET_PER_DAY; i++) {
      // IP 単位の上限（20件）には当たらないよう、毎回別の IP にする
      expect((await post(call, `${net}.${i + 1}`)).status).toBe(200)
    }
    expect((await post(call, `${net}.250`)).status).toBe(429)
    // IPv4-mapped IPv6 で同じサブネットを名乗っても数える
    expect((await post(call, `::ffff:${net}.251`)).status).toBe(429)
    // 別の /24 は影響を受けない
    expect((await post(call, uniqueIp())).status).toBe(200)
  })

  it('IPv6 は /48 で数える', async () => {
    const prefix = `2001:db8:${(++ipSeq).toString(16)}`
    for (let i = 0; i < MAX_VOTERS_PER_SUBNET_PER_DAY; i++) {
      expect(await issueVoter(env.DB, SECRET, `${prefix}:${(i + 1).toString(16)}::1`)).not.toBeNull()
    }
    expect(await issueVoter(env.DB, SECRET, `${prefix}:ffff::1`)).toBeNull()
    expect(await issueVoter(env.DB, SECRET, `2001:db8:${(++ipSeq).toString(16)}::1`)).not.toBeNull()
  })

  it('1曲あたりも、同じサブネットの別 IP からの票はサブネットの上限まで', async () => {
    const row = await env.DB.prepare(
      "INSERT INTO songs (title, artist, title_norm, artist_norm) VALUES ('s','s',?1,?1) RETURNING id",
    )
      .bind(`subnet-${Math.random().toString(36).slice(2)}`)
      .first<{ id: number }>()
    const songId = row?.id as number
    const net = uniqueSubnet()
    const ids: string[] = []
    for (let i = 0; i <= MAX_PER_SONG_PER_SUBNET; i++)
      ids.push((await issueVoter(env.DB, SECRET, `${net}.${i + 1}`)) as string)
    for (const id of ids.slice(0, MAX_PER_SONG_PER_SUBNET)) {
      expect(await checkPerSongIpCap(env.DB, 'likes', songId, id)).toBe(true)
      await env.DB.prepare('INSERT INTO likes (song_id, voter_id) VALUES (?, ?)').bind(songId, id).run()
    }
    expect(await checkPerSongIpCap(env.DB, 'likes', songId, ids[MAX_PER_SONG_PER_SUBNET] as string)).toBe(false)
  })
})

describe('データセンター・VPN の回線からの投票', () => {
  // DigitalOcean（一覧に含まれる）と、NTT（含まれない）
  const DC_ASN = 14061
  const ISP_ASN = 4713

  async function verified(call: ReturnType<typeof createApp>, ip: string, asn: number) {
    const res = await call('/api/session', { method: 'POST', ip, asn, body: JSON.stringify({ token: 'ok' }) })
    expect(res.status).toBe(200)
    return cookieOf(res)
  }
  const voterIdOf = (cookie: string) => cookie.split('=')[1]?.split('.')[0] as string
  const ageVerification = (id: string) =>
    env.DB.prepare('UPDATE voters SET last_verified_at = ? WHERE id = ?')
      .bind(Date.now() - DATACENTER_REVERIFY_MS - 1000, id)
      .run()

  it('確認から10分を過ぎたら確認を求め、確認し直すと同じ ID のまま投票できる', async () => {
    const call = createApp(true)
    const ip = uniqueIp()
    const cookie = await verified(call, ip, DC_ASN)
    expect((await call('/api/protected', { method: 'PUT', ip, asn: DC_ASN, cookie })).status).toBe(200)

    await ageVerification(voterIdOf(cookie))
    const stale = await call('/api/protected', { method: 'PUT', ip, asn: DC_ASN, cookie })
    expect(stale.status).toBe(401)
    expect(await stale.json()).toEqual({ error: 'verification_required' })

    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM voters').first<{ n: number }>()
    const again = await call('/api/session', {
      method: 'POST',
      ip,
      asn: DC_ASN,
      cookie,
      body: JSON.stringify({ token: 'ok' }),
    })
    expect(again.status).toBe(200)
    expect(again.headers.get('Set-Cookie')).toBeNull()
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM voters').first<{ n: number }>()
    expect(after?.n).toBe(before?.n)

    const res = await call('/api/protected', { method: 'PUT', ip, asn: DC_ASN, cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ voterId: voterIdOf(cookie) })
  })

  it('確認し直しても Turnstile に失敗したら通さない', async () => {
    const ip = uniqueIp()
    const cookie = await verified(createApp(true), ip, DC_ASN)
    await ageVerification(voterIdOf(cookie))
    const failed = await createApp(false)('/api/session', {
      method: 'POST',
      ip,
      asn: DC_ASN,
      cookie,
      body: JSON.stringify({ token: 'bad' }),
    })
    expect(failed.status).toBe(403)
    expect((await createApp(true)('/api/protected', { method: 'PUT', ip, asn: DC_ASN, cookie })).status).toBe(401)
  })

  it('一般の回線では、時間がたっても確認し直しは不要', async () => {
    const call = createApp(true)
    const ip = uniqueIp()
    const cookie = await verified(call, ip, ISP_ASN)
    await ageVerification(voterIdOf(cookie))
    expect((await call('/api/protected', { method: 'PUT', ip, asn: ISP_ASN, cookie })).status).toBe(200)
    // cf が無い（ローカル開発）場合も同じ
    expect((await call('/api/protected', { method: 'PUT', ip, cookie })).status).toBe(200)
  })
})
