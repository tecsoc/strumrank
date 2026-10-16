// 不正投票対策。Cloudflare の無料機能だけで次の3段で抑える。
// 1. Turnstile（無料）でボットを止めてから投票者 ID を発行する
// 2. 投票者 ID は HMAC で署名し、サーバーが発行した ID 以外は受け付けない（ID の偽造で1人1票を回避させない）
// 3. 同じ発行元（IP の HMAC）からの ID 発行数と、1曲あたりの票・いいね数に上限を設ける（cookie を消しての連投を抑える）
//    IP を変える手口に備えて、IPv4 /24・IPv6 /48 の範囲（サブネット）でも別枠で数える
// 4. データセンター・VPN の回線（ASN）からは、確認から10分を過ぎた投票の前に Turnstile をもう一度求める
// IP そのものは保存しない。
// 署名の鍵は VOTER_SECRET（現在）と VOTER_SECRET_PREV（入れ替え前、任意）の両方で検証し、
// 鍵を入れ替えても既存の投票者 ID が一斉に無効にならないようにする。
import { zValidator } from '@hono/zod-validator'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Context, Hono, Env as HonoEnv } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { DATACENTER_ASNS } from './asn-list'
import { voters } from './db/schema-voters'

/** http（ローカル開発）で使う cookie 名。https では __Host- 付きを使う */
export const VOTER_COOKIE = 'sr_vid'
/** Secure・Path=/・Domain なしが必須の接頭辞。サブドメインからの上書きを防ぐ */
export const VOTER_COOKIE_HOST = '__Host-sr_vid'
/** 署名の形式の版。値は `<uuid>.v1.<署名>`（旧形式 `<uuid>.<署名>` も現鍵で読める） */
const SIGNATURE_VERSION = 'v1'
/** Turnstile の action。クライアントの render 時と同じ値にする */
export const TURNSTILE_ACTION = 'vote'
/** 投票のない投票者 ID を消すまでの日数と、投票があっても消す日数（cookie の寿命と同じ） */
const INACTIVE_VOTER_DAYS = 30
const VOTER_RETENTION_DAYS = 400
const CLEANUP_BATCH = 500
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
  /** 入れ替え前の HMAC 鍵（任意）。設定中はこの鍵で署名された cookie も受け付け、現鍵で署名し直す */
  VOTER_SECRET_PREV?: string
  /** siteverify 応答の hostname と照合する値（任意）。未設定なら hostname・action を照合しない（ローカルのテストキー用） */
  TURNSTILE_HOSTNAME?: string
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

async function signature(secret: string, id: string): Promise<string> {
  return base64url(await hmac(secret, `voter:${id}`))
}

export async function signVoterId(secret: string, id: string): Promise<string> {
  return `${id}.${SIGNATURE_VERSION}.${await signature(secret, id)}`
}

export type VerifiedVoter = {
  id: string /** 旧形式・旧鍵の署名なので、現鍵の v1 形式で発行し直すべき */
  stale: boolean
}

/**
 * 署名が正しければ投票者 ID を返す。未署名（UUID だけ）や改ざんは null。
 * v1 形式は現鍵 → 旧鍵（prevSecret）の順に、旧形式 `<uuid>.<署名>` は現鍵だけで検証する。
 */
export async function readVoterCookie(
  secret: string,
  value: string | undefined,
  prevSecret?: string,
): Promise<VerifiedVoter | null> {
  if (!value) return null
  const parts = value.split('.')
  const id = parts[0] ?? ''
  if (!UUID.test(id)) return null
  if (parts.length === 3 && parts[1] === SIGNATURE_VERSION) {
    const sig = parts[2] ?? ''
    if (timingSafeEqual(await signature(secret, id), sig)) return { id, stale: false }
    if (prevSecret && timingSafeEqual(await signature(prevSecret, id), sig)) return { id, stale: true }
    return null
  }
  if (parts.length === 2 && timingSafeEqual(await signature(secret, id), parts[1] ?? '')) return { id, stale: true }
  return null
}

/** 署名が正しければ投票者 ID を返す（readVoterCookie の ID だけを返す版） */
export async function verifyVoterCookie(
  secret: string,
  value: string | undefined,
  prevSecret?: string,
): Promise<string | null> {
  return (await readVoterCookie(secret, value, prevSecret))?.id ?? null
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

/**
 * 回数制限（Rate Limiting）のキー。IPv6 は利用者が /64 の中でアドレスを自由に変えられるため /64 にまとめる。
 * IPv4（IPv4-mapped IPv6 を含む）はそのまま。
 */
export function rateLimitKey(raw: string): string {
  const ip = normalizeIp(raw)
  if (!ip.includes(':')) return ip
  const groups = ip.split(':')
  return groups.length === 8 ? `${groups.slice(0, 4).join(':')}::/64` : ip
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

/**
 * Turnstile のトークンを検証する。expectedHostname を渡したときは、応答の hostname と action も照合する
 * （他サイトで解かれたトークンや、別の用途のウィジェットのトークンを使い回させない）。
 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  expectedHostname?: string,
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
    const data = (await res.json()) as { success?: boolean; hostname?: string; action?: string }
    if (data.success !== true) return false
    if (!expectedHostname) return true
    return data.hostname === expectedHostname && data.action === TURNSTILE_ACTION
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

/**
 * 古い投票者 ID を消す（Cron から呼ぶ）。発行から VOTER_RETENTION_DAYS を過ぎたもの、
 * または INACTIVE_VOTER_DAYS を過ぎても票もいいねも無いものが対象。1回に CLEANUP_BATCH 行まで。
 * 消した ID の票・いいねは残る（ランキングの集計は変わらない）。返り値は消した行数。
 */
export async function cleanupVoters(d1: D1Database, now = Date.now()): Promise<number> {
  const expired = now - VOTER_RETENTION_DAYS * DAY_MS
  const inactive = now - INACTIVE_VOTER_DAYS * DAY_MS
  const res = await drizzle(d1).run(sql`
    DELETE FROM voters WHERE id IN (
      SELECT v.id FROM voters AS v
      WHERE v.created_at < ${expired}
        OR (v.created_at < ${inactive}
          AND NOT EXISTS (SELECT 1 FROM votes WHERE voter_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM likes WHERE voter_id = v.id))
      LIMIT ${CLEANUP_BATCH})`)
  return res.meta.changes ?? 0
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

// ---- cookie ----

const isHttps = (c: Context) => new URL(c.req.url).protocol === 'https:'

/** __Host- 付き → 従来名の順に読み、署名を検証する */
async function readVoter(c: Context, env: VoterBindings): Promise<VerifiedVoter | null> {
  const host = getCookie(c, VOTER_COOKIE_HOST)
  const legacy = getCookie(c, VOTER_COOKIE)
  const fromHost = host ? await readVoterCookie(env.VOTER_SECRET, host, env.VOTER_SECRET_PREV) : null
  if (fromHost) return fromHost
  const fromLegacy = legacy ? await readVoterCookie(env.VOTER_SECRET, legacy, env.VOTER_SECRET_PREV) : null
  // https で従来名の cookie しか無ければ、__Host- 付きへ移すため発行し直す
  return fromLegacy && isHttps(c) ? { ...fromLegacy, stale: true } : fromLegacy
}

/** 現鍵の v1 形式で cookie を書く。https では __Host- 付きにし、従来名の cookie は消す */
async function writeVoter(c: Context, env: VoterBindings, id: string) {
  const value = await signVoterId(env.VOTER_SECRET, id)
  const base = { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: COOKIE_MAX_AGE } as const
  if (isHttps(c)) {
    setCookie(c, VOTER_COOKIE_HOST, value, { ...base, secure: true })
    if (getCookie(c, VOTER_COOKIE)) setCookie(c, VOTER_COOKIE, '', { ...base, secure: true, maxAge: 0 })
  } else {
    setCookie(c, VOTER_COOKIE, value, base)
  }
}

// ---- ミドルウェアとルート ----

/**
 * 投票・いいね用。署名付きの投票者 ID が無ければ 401 を返す（クライアントは確認画面を出す）。
 * データセンター・VPN 経由では、確認から DATACENTER_REVERIFY_MS を過ぎていても 401 にして確認を通し直させる。
 */
export const requireVoter = createMiddleware<VoterEnv>(async (c, next) => {
  const voter = await readVoter(c, c.env)
  if (!voter) return c.json({ error: 'verification_required' }, 401)
  const { id } = voter
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
  if (voter.stale) await writeVoter(c, c.env, id)
  await next()
})

/** 閲覧用。署名が正しければ投票者 ID、無ければ null。新しい ID は発行しない（旧形式の署名だけ書き直す）。 */
export const optionalVoter = createMiddleware<OptionalVoterEnv>(async (c, next) => {
  const voter = await readVoter(c, c.env)
  c.set('voterId', voter?.id ?? null)
  if (voter?.stale) await writeVoter(c, c.env, voter.id)
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
    const verified = (await readVoter(c, env)) !== null
    c.header('Cache-Control', 'no-store')
    return c.json({ siteKey: env.TURNSTILE_SITE_KEY, verified })
  })

  app.post('/session', zValidator('json', z.object({ token: z.string().min(1).max(2048) })), async (c) => {
    const env = c.env as VoterBindings
    const ip = clientIp(c)
    const ok = await verifyTurnstile(
      env.TURNSTILE_SECRET,
      c.req.valid('json').token,
      ip,
      deps.fetch,
      env.TURNSTILE_HOSTNAME || undefined,
    )
    if (!ok) return c.json({ error: 'verification_failed' }, 403)

    // 確認を通り直しただけなら新しい ID は作らず（発行の上限にも数えない）、確認時刻だけ更新する
    const existing = await readVoter(c, env)
    if (existing && (await touchVerified(env.DB, existing.id))) {
      if (existing.stale) await writeVoter(c, env, existing.id)
      return c.json({ ok: true })
    }

    const id = await issueVoter(env.DB, env.VOTER_SECRET, ip)
    if (!id) return c.json({ error: 'too_many_voters' }, 429)

    await writeVoter(c, env, id)
    return c.json({ ok: true })
  })
  return app
}
