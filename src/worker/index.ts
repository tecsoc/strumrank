import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import { secureHeaders } from 'hono/secure-headers'
import { z } from 'zod'
import { MAX_LEVEL, MIN_LEVEL, SORTS } from '../shared/levels'
import { isExcludedRecording } from '../shared/normalize'
import { createDb, type Db } from './db/client'
import { processPending } from './musicbrainz'
import { suggestSongs } from './search'
import { CAPPED, getSong, ranking, registerSong, resolveSongs, setLike, vote } from './songs'
import { cleanupVoters, optionalVoter, rateLimitKey, registerSessionRoutes, requireVoter } from './voter'

type AppEnv = { Bindings: Env; Variables: { db: Db; voterId: string | null } }

type RateLimitBinding = { limit: (opts: { key: string }) => Promise<{ success: boolean }> }
type RateLimitName =
  | 'REGISTER_LIMITER'
  | 'VOTE_LIMITER'
  | 'LIKE_LIMITER'
  | 'SEARCH_LIMITER'
  | 'READ_LIMITER'
  | 'SESSION_LIMITER'

/**
 * IP ごとの回数制限（wrangler.jsonc の ratelimits）。IPv6 は利用者がアドレスを自由に変えられるため
 * /64 単位で数える（rateLimitKey）。cf-connecting-ip が無い環境（ローカル開発・テスト）や
 * binding が無い環境では制限しない。
 */
const rateLimit = (name: RateLimitName) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const limiter = (c.env as unknown as Partial<Record<RateLimitName, RateLimitBinding>>)[name]
    const ip = c.req.header('cf-connecting-ip')
    if (limiter && ip) {
      const { success } = await limiter.limit({ key: rateLimitKey(ip) })
      if (!success) return c.json({ error: 'rate_limited' }, 429)
    }
    await next()
  })
// iTunes の値をブラウザ経由で受け取るため、URL は Apple のドメインに限定する
const appleUrl = (hosts: RegExp) => z.url({ protocol: /^https$/, hostname: hosts }).max(500)

const registerSchema = z.object({
  itunesTrackId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  artist: z.string().trim().min(1).max(200),
  artworkUrl: appleUrl(/^[a-z0-9-]+\.mzstatic\.com$/).optional(),
  appleMusicUrl: appleUrl(/^(music|itunes)\.apple\.com$/).optional(),
  durationMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 1000)
    .optional(),
})

const resolveSchema = z.object({
  items: z
    .array(
      z.object({
        itunesTrackId: z.number().int().positive(),
        title: z.string().max(200),
        artist: z.string().max(200),
      }),
    )
    .max(50),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

/** 投票者ごとの状態を含む応答は、ブラウザや中継でキャッシュさせない */
const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'no-store')
})

const base = new Hono<AppEnv>()
  .basePath('/api')
  // API は HTML を返さないので、何も読み込ませず、枠への埋め込みも禁止する
  .use(
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
    }),
  )
  .use(csrf())
  .use(async (c, next) => {
    c.set('db', createDb(c.env.DB))
    await next()
  })
// GET/POST /api/session（Turnstile の確認と、署名付き投票者 ID の発行）。siteverify を無駄に呼ばせないよう回数を絞る
base.use('/session', rateLimit('SESSION_LIMITER'), noStore)
registerSessionRoutes(base)

const app = base
  .get(
    '/ranking',
    rateLimit('READ_LIMITER'),
    zValidator(
      'query',
      z.object({
        level: z.coerce.number().int().min(MIN_LEVEL).max(MAX_LEVEL).optional(),
        sort: z.enum(SORTS).default('likes'),
        cursor: z.coerce.number().int().min(0).max(100).default(0),
      }),
    ),
    async (c) => {
      c.header('Cache-Control', 'public, max-age=30')
      return c.json(await ranking(c.var.db, c.req.valid('query')))
    },
  )
  // 曲の登録も Turnstile を通った投票者に限り、1日の登録数に上限をかける（スパムの曲と正規化キーの先取りを抑える）
  .post('/songs', rateLimit('REGISTER_LIMITER'), requireVoter, zValidator('json', registerSchema), async (c) => {
    const input = c.req.valid('json')
    if (isExcludedRecording(input.title)) return c.json({ error: 'instrumental_or_karaoke' }, 422)
    // MusicBrainz での名寄せは Cron（scheduled）が1分1件ずつ行う
    const result = await registerSong(c.var.db, input, c.var.voterId)
    if (result === CAPPED) return c.json({ error: 'too_many_registrations' }, 429)
    return c.json(result, result.created ? 201 : 200)
  })
  .get(
    '/songs/suggest',
    rateLimit('SEARCH_LIMITER'),
    zValidator('query', z.object({ q: z.string().trim().min(1).max(100) })),
    async (c) => {
      c.header('Cache-Control', 'public, max-age=30')
      return c.json(await suggestSongs(c.var.db, c.req.valid('query').q))
    },
  )
  .post('/songs/resolve', rateLimit('SEARCH_LIMITER'), zValidator('json', resolveSchema), async (c) => {
    return c.json(await resolveSongs(c.var.db, c.req.valid('json').items))
  })
  .get('/songs/:id', rateLimit('READ_LIMITER'), noStore, optionalVoter, zValidator('param', idParam), async (c) => {
    const res = await getSong(c.var.db, c.req.valid('param').id, c.var.voterId)
    return res ? c.json(res) : c.json({ error: 'not_found' }, 404)
  })
  .put(
    '/songs/:id/vote',
    rateLimit('VOTE_LIMITER'),
    requireVoter,
    zValidator('param', idParam),
    zValidator('json', z.object({ level: z.number().int().min(MIN_LEVEL).max(MAX_LEVEL) })),
    async (c) => {
      // 1曲あたりの回線上限は vote() の中で書き込みと同じ1文で判定する
      const res = await vote(c.var.db, c.req.valid('param').id, c.var.voterId, c.req.valid('json').level)
      if (res === CAPPED) return c.json({ error: 'too_many_from_network' }, 429)
      return res ? c.json(res) : c.json({ error: 'not_found' }, 404)
    },
  )
  // いいねは難易度の投票とは独立（どちらか一方だけでもよい）。PUT でいいね、DELETE で取り消し。どちらも冪等
  .put('/songs/:id/like', rateLimit('LIKE_LIMITER'), requireVoter, zValidator('param', idParam), async (c) => {
    const res = await setLike(c.var.db, c.req.valid('param').id, c.var.voterId, true)
    if (res === CAPPED) return c.json({ error: 'too_many_from_network' }, 429)
    return res ? c.json(res) : c.json({ error: 'not_found' }, 404)
  })
  // 取り消しは上限の対象外
  .delete('/songs/:id/like', rateLimit('LIKE_LIMITER'), requireVoter, zValidator('param', idParam), async (c) => {
    const res = await setLike(c.var.db, c.req.valid('param').id, c.var.voterId, false)
    if (res === CAPPED) return c.json({ error: 'too_many_from_network' }, 429)
    return res ? c.json(res) : c.json({ error: 'not_found' }, 404)
  })

export type AppType = typeof app

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processPending(createDb(env.DB)).then(() => undefined))
    // 古い投票者の行の掃除は1時間に1回（毎時0分）
    if (new Date(controller.scheduledTime).getUTCMinutes() === 0) ctx.waitUntil(cleanupVoters(env.DB))
  },
} satisfies ExportedHandler<Env>
