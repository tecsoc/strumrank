# strumrank

弾き語りしたい曲を、難しさ別に探せるランキングサイトです。人気はいいねの数、難しさは弾き語りした人の評価で決まります。

https://strumrank.tecsoc.workers.dev

## 構成

- 画面: React 19 + TanStack Router / Query + Tailwind CSS v4（Workers の静的アセットで配信）
- API: Hono on Cloudflare Workers（`/api/*` のみ Worker が処理）
- DB: Cloudflare D1 + Drizzle ORM（マイグレーションは `drizzle/`）
- 曲の検索はブラウザから iTunes Search API を呼び、表記ゆれは MusicBrainz の作品 ID で名寄せします（Cron で1分1件）
- 不正投票対策: Cloudflare Turnstile、署名付きの投票者 cookie、回線ごとの上限、Rate Limiting

すべて Cloudflare の無料プランの範囲で動きます。

## 開発

```sh
pnpm install
cp .dev.vars.example .dev.vars   # Turnstile のテストキーとローカル用の秘密値
pnpm db:migrate:local
pnpm dev
```

| コマンド | 内容 |
|---|---|
| `pnpm test` | Workers ランタイム上のテスト（vitest） |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` | Biome |
| `pnpm db:generate --name <名前>` | スキーマ変更からマイグレーションを生成 |

## デプロイ

```sh
pnpm db:migrate:remote
pnpm deploy
```

本番の秘密値は `wrangler secret put TURNSTILE_SECRET` と `wrangler secret put VOTER_SECRET` で登録します。

## 外部サービスについて

非公式の個人サイトです。各音楽サービスとは提携していません。Apple Music は Apple Inc.、Spotify は Spotify AB の商標です。歌詞やコード譜の本文は掲載せず、外部サイトへのリンクのみを置いています。
