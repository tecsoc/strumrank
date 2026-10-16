// 不正投票対策。Cloudflare の無料機能だけで次の3段で抑える。
// 1. Turnstile（無料）でボットを止めてから投票者 ID を発行する
// 2. 投票者 ID は HMAC で署名し、サーバーが発行した ID 以外は受け付けない（ID の偽造で1人1票を回避させない）
// 3. 同じ発行元（IP の HMAC）からの ID 発行数と、1曲あたりの票・いいね数に上限を設ける（cookie を消しての連投を抑える）
//    IP を変える手口に備えて、IPv4 /24・IPv6 /48 の範囲（サブネット）でも別枠で数える
// 4. データセンター・VPN の回線（ASN）からは、確認から10分を過ぎた投票の前に Turnstile をもう一度求める
// IP そのものは保存しない。
import { zValidator } from '@hono/zod-validator'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Context, Hono, Env as HonoEnv } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { DATACENTER_ASNS } from './asn-list'
import { voters } from './db/schema-voters'

export const VOTER_COOKIE = 'sr_vid'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const SITEVERIFY_TIMEOUT_MS = 5000
/** 同じ発行元から24時間に発行できる投票者 ID の数。携帯回線などの共有 IP を考えて余裕を持たせる */
export const MAX_VOTERS_PER_IP_PER_DAY = 20
/** 1曲に対して、同じ発行元の投票者が入れられる票（またはいいね）の数 */
export const MAX_PER_SONG_PER_IP = 3
/** サブネット（IPv4 /24、IPv6 /48）単位の上限。学校・会社・携帯回線の共有を考えて IP 単位より大きくする */
export const MAX_VOTERS_PER_SUBNET_PER_DAY = 60
export const MAX_PER_SONG_PER_SUBNET = 10
/** データセンター・VPN 経由のとき、確認を通ってから投票できる時間 */
export const DATACENTER_REVERIFY_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type VoterBindings = {
  DB: D1Database
  /** HMAC 用の秘密鍵（wrangler secret） */
  VOTER_SECRET: string
  /** Turnstile のシークレットキー（wrangler secret） */
  TURNSTILE_SECRET: string
  /** Turnstile のサイトキー（公開値。wrangler の vars） */
  TURNSTILE_SITE_KEY: string
}

type VoterEnv = { Bindings: VoterBindings; Variables: { voterId: string } }
type OptionalVoterEnv = { Bindings: VoterBindings; Variables: { voterId: string | null } }

// ---- 署名 ----

const keyCache = new Map<string, Promise<CryptoKey>>()
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ])
    keyCache.set(secret, key)
  }
  return key
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(message))
  return new Uint8Array(sig)
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 長さが同じなら内容によらず同じ時間で比べる */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function signVoterId(secret: string, id: string): Promise<string> {
  return `${id}.${base64url(await hmac(secret, `voter:${id}`))}`
}

/** 署名が正しければ投票者 ID を返す。未署名（旧形式の UUID だけ）や改ざんは null。 */
export async function verifyVoterCookie(secret: string, value: string | undefined): Promise<string | null> {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot < 0) return null
  const id = value.slice(0, dot)
  if (!UUID.test(id)) return null
  const expected = await signVoterId(secret, id)
  return timingSafeEqual(expected, value) ? id : null
}

export async function hashIp(secret: string, ip: string): Promise<string> {
  const bytes = await hmac(secret, `ip:${ip}`)
  return [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** IPv6 を8グループの16進に展開する。不正な形式なら null */
function expandIpv6(ip: string): number[] | null {
  const [head = '', tail, ...rest] = ip.split('::')
  if (rest.length > 0) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':'))
  let headParts = parse(head)
  let tailParts = tail === undefined ? [] : parse(tail)
  // 末尾が IPv4 表記（::ffff:192.0.2.1 など）なら2グループに直す
  const last = (tail === undefined ? headParts : tailParts).at(-1)
  if (last?.includes('.')) {
    const v4 = last.split('.').map(Number)
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const groups = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)].map((n) => n.toString(16))
    if (tail === undefined) headParts = [...headParts.slice(0, -1), ...groups]
    else tailParts = [...tailParts.slice(0, -1), ...groups]
  }
  const missing = 8 - headParts.length - tailParts.length
  if (tail === undefined ? missing !== 0 : missing < 1) return null
  const all = [...headParts, ...Array(tail === undefined ? 0 : missing).fill('0'), ...tailParts]
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN))
  return nums.some(Number.isNaN) ? null : nums
}

/**
 * 集計用に IP をそろえる。IPv4-mapped IPv6（::ffff:a.b.c.d）は IPv4 として扱い、
 * IPv6 はゾーン ID を除いて展開した形にする。
 */
export function normalizeIp(raw: string): string {
  const ip = raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase()
  if (!ip.includes(':')) return ip
  const g = expandIpv6(ip)
  if (!g) return ip
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const [hi = 0, lo = 0] = g.slice(6)
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  return g.map((n) => n.toString(16)).join(':')
}

/** サブネット（IPv4 /24、IPv6 /48）の表記。ローカル開発の 'local' はそのまま */
export function subnetOf(raw: string): string {
  const ip = normalizeIp(raw)
  if (ip === 'local') return ip
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0/24` : ip
}

export async function hashSubnet(secret: string, ip: string): Promise<string> {
  const bytes = await hmac(secret, `subnet:${subnetOf(ip)}`)
  return [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function clientIp(c: Context): string {
  // ローカル開発・テストでは付かないので、まとめて1つの発行元として扱う
  const ip = c.req.header('cf-connecting-ip')
  return ip ? normalizeIp(ip) : 'local'
}

/** 接続元がデータセンター・VPN 事業者のネットワークか（ローカル・テストで cf が無ければ false） */
export function isDatacenterRequest(c: Context): boolean {
  const asn = (c.req.raw as Request & { cf?: { asn?: unknown } }).cf?.asn
  return typeof asn === 'number' && DATACENTER_ASNS.has(asn)
}

// ---- Turnstile ----

export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<boolean> {
  const body = new FormData()
  body.set('secret', secret)
  body.set('response', token)
  if (ip !== 'local') body.set('remoteip', ip)
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}

// ---- 投票者 ID の発行 ----

/** 発行元ごと（IP とサブネットの両方）の上限内なら投票者 ID を作って返す。上限を超えていれば null。 */
export async function issueVoter(d1: D1Database, secret: string, ip: string, now = Date.now()): Promise<string | null> {
  const db = drizzle(d1)
  const [ipHash, subnetHash] = await Promise.all([hashIp(secret, ip), hashSubnet(secret, ip)])
  const since = new Date(now - DAY_MS)
  const [byIp, bySubnet] = await db.batch([
    db
      .select({ n: count() })
      .from(voters)
      .where(and(eq(voters.ipHash, ipHash), gt(voters.createdAt, since))),
    db
      .select({ n: count() })
      .from(voters)
      .where(and(eq(voters.subnetHash, subnetHash), gt(voters.createdAt, since))),
  ])
  if ((byIp[0]?.n ?? 0) >= MAX_VOTERS_PER_IP_PER_DAY) return null
  if ((bySubnet[0]?.n ?? 0) >= MAX_VOTERS_PER_SUBNET_PER_DAY) return null
  const id = crypto.randomUUID()
  await db.insert(voters).values({ id, ipHash, subnetHash, lastVerifiedAt: new Date(now), createdAt: new Date(now) })
  return id
}

/** 既存の投票者が確認を通り直したときに時刻だけ更新する。投票者が見つからなければ false */
export async function touchVerified(d1: D1Database, id: string, now = Date.now()): Promise<boolean> {
  const rows = await drizzle(d1)
    .update(voters)
    .set({ lastVerifiedAt: new Date(now) })
    .where(eq(voters.id, id))
    .returning({ id: voters.id })
  return rows.length > 0
}

// ---- 1曲あたりの上限 ----

/**
 * 1曲に対する、同じ発行元の投票者による票（または いいね）の数が上限未満かを返す。
 * 自分の既存の票を変更する場合は数えずに許可する。
 * 同時に複数の票が来ると上限を少し超えることがあるが、量産を抑える目的には足りる。
 */
export async function checkPerSongIpCap(
  d1: D1Database,
  table: 'votes' | 'likes',
  songId: number,
  voterId: string,
  cap = MAX_PER_SONG_PER_IP,
  subnetCap = MAX_PER_SONG_PER_SUBNET,
): Promise<boolean> {
  // テーブル名はバインドできないため、許可した2つの名前だけを埋め込む
  const t = sql.raw(table === 'votes' ? 'votes' : 'likes')
  const row = await drizzle(d1).get<{ mine: number; n: number; ns: number }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM ${t} WHERE song_id = ${songId} AND voter_id = ${voterId}) AS mine,
      (SELECT COUNT(*) FROM ${t} AS x JOIN voters AS v ON v.id = x.voter_id
        WHERE x.song_id = ${songId}
          AND v.ip_hash = (SELECT ip_hash FROM voters WHERE id = ${voterId})) AS n,
      (SELECT COUNT(*) FROM ${t} AS x JOIN voters AS v ON v.id = x.voter_id
        WHERE x.song_id = ${songId}
          AND v.subnet_hash = (SELECT subnet_hash FROM voters WHERE id = ${voterId})) AS ns`)
  if (!row) return true
  return row.mine === 1 || (row.n < cap && row.ns < subnetCap)
}

// ---- ミドルウェアとルート ----

/**
 * 投票・いいね用。署名付きの投票者 ID が無ければ 401 を返す（クライアントは確認画面を出す）。
 * データセンター・VPN 経由では、確認から DATACENTER_REVERIFY_MS を過ぎていても 401 にして確認を通し直させる。
 */
export const requireVoter = createMiddleware<VoterEnv>(async (c, next) => {
  const id = await verifyVoterCookie(c.env.VOTER_SECRET, getCookie(c, VOTER_COOKIE))
  if (!id) return c.json({ error: 'verification_required' }, 401)
  if (isDatacenterRequest(c)) {
    const row = await drizzle(c.env.DB)
      .select({ at: voters.lastVerifiedAt })
      .from(voters)
      .where(eq(voters.id, id))
      .get()
    const at = row?.at?.getTime() ?? 0
    if (Date.now() - at > DATACENTER_REVERIFY_MS) return c.json({ error: 'verification_required' }, 401)
  }
  c.set('voterId', id)
  await next()
})

/** 閲覧用。署名が正しければ投票者 ID、無ければ null。cookie は発行しない。 */
export const optionalVoter = createMiddleware<OptionalVoterEnv>(async (c, next) => {
  c.set('voterId', await verifyVoterCookie(c.env.VOTER_SECRET, getCookie(c, VOTER_COOKIE)))
  await next()
})

type SessionDeps = { fetch?: typeof fetch }

/**
 * GET  /session … Turnstile のサイトキーと、確認済みかどうか
 * POST /session … Turnstile のトークンを検証し、署名付きの投票者 ID を cookie で発行する
 * basePath('/api') を設定した app に登録すると /api/session になる。
 */
export function registerSessionRoutes<E extends HonoEnv & { Bindings: VoterBindings }>(
  // biome-ignore lint/suspicious/noExplicitAny: basePath やルート定義の型が呼び出し側ごとに違うため
  app: Hono<E, any, any>,
  deps: SessionDeps = {},
) {
  app.get('/session', async (c) => {
    const env = c.env as VoterBindings
    const verified = (await verifyVoterCookie(env.VOTER_SECRET, getCookie(c, VOTER_COOKIE))) !== null
    c.header('Cache-Control', 'no-store')
    return c.json({ siteKey: env.TURNSTILE_SITE_KEY, verified })
  })

  app.post('/session', zValidator('json', z.object({ token: z.string().min(1).max(2048) })), async (c) => {
    const env = c.env as VoterBindings
    const ip = clientIp(c)
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, c.req.valid('json').token, ip, deps.fetch)
    if (!ok) return c.json({ error: 'verification_failed' }, 403)

    // 確認を通り直しただけなら新しい ID は作らず（発行の上限にも数えない）、確認時刻だけ更新する
    const existing = await verifyVoterCookie(env.VOTER_SECRET, getCookie(c, VOTER_COOKIE))
    if (existing && (await touchVerified(env.DB, existing))) return c.json({ ok: true })

    const id = await issueVoter(env.DB, env.VOTER_SECRET, ip)
    if (!id) return c.json({ error: 'too_many_voters' }, 429)

    setCookie(c, VOTER_COOKIE, await signVoterId(env.VOTER_SECRET, id), {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    })
    return c.json({ ok: true })
  })
  return app
}
