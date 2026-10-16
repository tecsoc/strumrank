import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupVoters,
  DATACENTER_REVERIFY_MS,
  hashIp,
  issueVoter,
  MAX_VOTERS_PER_IP_PER_DAY,
  MAX_VOTERS_PER_SUBNET_PER_DAY,
  normalizeIp,
  rateLimitKey,
  readVoterCookie,
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

/**
 * siteverify の結果を固定したテスト用アプリ。turnstile は成否か、siteverify の応答そのもの。
 * origin を http にするとローカル開発（__Host- cookie を使わない）を再現できる。
 */
function createApp(
  turnstile: boolean | Record<string, unknown>,
  opts: { bindings?: Partial<VoterBindings>; origin?: string } = {},
) {
  const verifyResponse = typeof turnstile === 'boolean' ? { success: turnstile } : turnstile
  const env = { ...bindings, ...opts.bindings }
  const origin = opts.origin ?? 'https://example.com'
  const app = new Hono<{ Bindings: VoterBindings; Variables: { voterId: string } }>().basePath('/api')
  registerSessionRoutes(app, {
    fetch: (async () => Response.json(verifyResponse)) as unknown as typeof fetch,
  })
  app.put('/protected', requireVoter, (c) => c.json({ voterId: c.var.voterId }))
  return (path: string, init: RequestInit & { ip?: string; cookie?: string; asn?: number } = {}) => {
    const headers = new Headers(init.headers)
    if (init.ip) headers.set('cf-connecting-ip', init.ip)
    if (init.cookie) headers.set('Cookie', init.cookie)
    if (init.body) headers.set('Content-Type', 'application/json')
    const req = new Request(`${origin}${path}`, { ...init, headers })
    // 本番では Cloudflare が付ける request.cf を、テストでは差し込む
    if (init.asn !== undefined) Object.defineProperty(req, 'cf', { value: { asn: init.asn } })
    return app.fetch(req, env)
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

describe('回数制限のキー', () => {
  it('IPv6 は /64 にまとめ、IPv4 と IPv4-mapped IPv6 は同じ IPv4 にする', () => {
    expect(rateLimitKey('2001:db8:1:2:3:4:5:6')).toBe(rateLimitKey('2001:db8:1:2:ffff::1'))
    expect(rateLimitKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(rateLimitKey('2001:db8:1:3::1')).not.toBe(rateLimitKey('2001:db8:1:2::1'))
    expect(rateLimitKey('::ffff:192.0.2.1')).toBe('192.0.2.1')
    expect(rateLimitKey('192.0.2.1')).toBe('192.0.2.1')
  })
})

describe('Turnstile の hostname と action の照合', () => {
  const HOST = 'strumrank.example'
  const session = (verify: Record<string, unknown>, hostname?: string) =>
    createApp(verify, { bindings: { TURNSTILE_HOSTNAME: hostname } })('/api/session', {
      method: 'POST',
      ip: uniqueIp(),
      body: JSON.stringify({ token: 't' }),
    })

  it('設定した hostname と action が一致したときだけ通す', async () => {
    expect((await session({ success: true, hostname: HOST, action: 'vote' }, HOST)).status).toBe(200)
    expect((await session({ success: true, hostname: 'evil.example', action: 'vote' }, HOST)).status).toBe(403)
    expect((await session({ success: true, hostname: HOST, action: 'login' }, HOST)).status).toBe(403)
    expect((await session({ success: true, hostname: HOST }, HOST)).status).toBe(403)
  })

  it('hostname を設定していなければ照合しない（ローカルのテストキー）', async () => {
    expect((await session({ success: true, hostname: 'example.com' })).status).toBe(200)
    expect((await session({ success: true }, '')).status).toBe(200)
  })
})

describe('cookie の名前と署名の版', () => {
  const ID = '00000000-0000-4000-8000-0000000000aa'
  const setCookies = (res: Response) => res.headers.getSetCookie()

  it('https では __Host- 付き（Secure・Path=/・Domain なし）、http では従来名で発行する', async () => {
    const ip = uniqueIp()
    const https = await createApp(true)('/api/session', { method: 'POST', ip, body: JSON.stringify({ token: 't' }) })
    const [hostCookie = ''] = setCookies(https)
    expect(hostCookie).toMatch(/^__Host-sr_vid=[0-9a-f-]{36}\.v1\./)
    expect(hostCookie).toMatch(/; Secure/)
    expect(hostCookie).toMatch(/; Path=\//)
    expect(hostCookie).not.toMatch(/Domain=/i)

    const http = await createApp(true, { origin: 'http://localhost' })('/api/session', {
      method: 'POST',
      ip: uniqueIp(),
      body: JSON.stringify({ token: 't' }),
    })
    const [plain = ''] = setCookies(http)
    expect(plain).toMatch(/^sr_vid=/)
    expect(plain).not.toMatch(/Secure/)
  })

  it('https で従来名の cookie しか無ければ受け付け、__Host- 付きへ移して従来名を消す', async () => {
    const ip = uniqueIp()
    const issued = await createApp(true, { origin: 'http://localhost' })('/api/session', {
      method: 'POST',
      ip,
      body: JSON.stringify({ token: 't' }),
    })
    const legacy = cookieOf(issued) // sr_vid=...
    const res = await createApp(true)('/api/protected', { method: 'PUT', ip, cookie: legacy })
    expect(res.status).toBe(200)
    const cookies = setCookies(res)
    expect(cookies.some((c) => c.startsWith('__Host-sr_vid='))).toBe(true)
    expect(cookies.some((c) => /^sr_vid=;.*Max-Age=0/.test(c))).toBe(true)
  })

  it('旧形式（版なし）の署名は現鍵で検証できれば受け付け、v1 形式で発行し直す', async () => {
    const v1 = await signVoterId(SECRET, ID)
    const old = v1.replace('.v1.', '.')
    expect(await readVoterCookie(SECRET, old)).toEqual({ id: ID, stale: true })
    expect(await readVoterCookie(SECRET, v1)).toEqual({ id: ID, stale: false })

    const res = await createApp(true)('/api/protected', {
      method: 'PUT',
      ip: uniqueIp(),
      cookie: `__Host-sr_vid=${old}`,
    })
    expect(res.status).toBe(200)
    expect(setCookies(res)[0]).toMatch(new RegExp(`^__Host-sr_vid=${ID}\\.v1\\.`))
  })

  it('入れ替え前の鍵（VOTER_SECRET_PREV）の署名も受け付け、現鍵で署名し直す', async () => {
    const OLD = 'old-voter-secret'
    const signedByOld = await signVoterId(OLD, ID)
    const withPrev = createApp(true, { bindings: { VOTER_SECRET_PREV: OLD } })
    const res = await withPrev('/api/protected', {
      method: 'PUT',
      ip: uniqueIp(),
      cookie: `__Host-sr_vid=${signedByOld}`,
    })
    expect(res.status).toBe(200)
    const renewed = cookieOf(res).split('=')[1]
    expect(await readVoterCookie(SECRET, renewed)).toEqual({ id: ID, stale: false })

    // 旧鍵を外したら受け付けない。旧形式（版なし）は旧鍵では検証しない
    const withoutPrev = createApp(true)
    expect(
      (await withoutPrev('/api/protected', { method: 'PUT', ip: uniqueIp(), cookie: `__Host-sr_vid=${signedByOld}` }))
        .status,
    ).toBe(401)
    expect(await readVoterCookie(SECRET, signedByOld.replace('.v1.', '.'), OLD)).toBeNull()
  })
})

describe('古い投票者 ID の掃除', () => {
  it('400日を過ぎたもの、30日を過ぎて票もいいねも無いものを消し、それ以外は残す', async () => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const tag = Math.random().toString(36).slice(2, 10)
    const ids = {
      expired: `cleanup-${tag}-expired`,
      inactive: `cleanup-${tag}-inactive`,
      activeOld: `cleanup-${tag}-active-old`,
      recent: `cleanup-${tag}-recent`,
    }
    const insertVoter = (id: string, ageDays: number) =>
      env.DB.prepare('INSERT INTO voters (id, ip_hash, created_at) VALUES (?1, ?2, ?3)')
        .bind(id, `hash-${tag}`, now - ageDays * day)
        .run()
    await insertVoter(ids.expired, 401)
    await insertVoter(ids.inactive, 31)
    await insertVoter(ids.activeOld, 31)
    await insertVoter(ids.recent, 1)
    const song = await env.DB.prepare(
      "INSERT INTO songs (title, artist, title_norm, artist_norm) VALUES ('掃除', ?1, '掃除', ?1) RETURNING id",
    )
      .bind(`cleanup-${tag}`)
      .first<{ id: number }>()
    await env.DB.prepare('INSERT INTO likes (song_id, voter_id) VALUES (?1, ?2)').bind(song?.id, ids.activeOld).run()

    expect(await cleanupVoters(env.DB, now)).toBeGreaterThanOrEqual(2)
    const left = await env.DB.prepare('SELECT id FROM voters WHERE id LIKE ?1')
      .bind(`cleanup-${tag}-%`)
      .all<{ id: string }>()
    expect(left.results.map((r) => r.id).sort()).toEqual([ids.activeOld, ids.recent].sort())
    // 消した投票者のいいねは残す
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE voter_id = ?1').bind(ids.activeOld).first('n'),
    ).toBe(1)
  })
})
