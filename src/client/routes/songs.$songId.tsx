import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { SongDetail, SongResponse } from '../../shared/api'
import { LEVELS, levelLabel, MAX_LEVEL } from '../../shared/levels'
import { googleScoreSearchUrl, spotifySearchUrl, ufretSearchUrl } from '../../shared/links'
import { Artwork } from '../components/Artwork'
import { Fingerboard, FretMeter, LevelLabels } from '../components/FretMeter'
import { PickIcon } from '../components/PickIcon'
import { ApiError, api } from '../lib/api'
import { actionErrorMessage, withVerification } from '../lib/verify'

export const Route = createFileRoute('/songs/$songId')({
  component: SongPage,
})

function SongPage() {
  const id = Number(Route.useParams().songId)
  const valid = Number.isInteger(id) && id > 0
  const navigate = useNavigate()
  const query = useQuery({ queryKey: ['song', id], queryFn: () => api.song(id), enabled: valid })

  // 重複として統合済みの曲は統合先へ移す
  const mergedInto = query.data && 'mergedInto' in query.data ? query.data.mergedInto : null
  useEffect(() => {
    if (mergedInto !== null) navigate({ to: '/songs/$songId', params: { songId: String(mergedInto) }, replace: true })
  }, [mergedInto, navigate])

  if (!valid || query.isError) {
    const notFound = !valid || (query.error instanceof ApiError && query.error.status === 404)
    return (
      <p className="py-16 text-muted">
        {notFound ? 'この曲は見つかりません。' : '曲の情報を読み込めませんでした。'}
        <Link to="/" className="underline">
          ランキングに戻る
        </Link>
      </p>
    )
  }
  if (!query.data || !('song' in query.data)) return <p className="py-16 text-muted">読み込み中…</p>
  return <SongView song={query.data.song} />
}

function SongView({ song }: { song: SongDetail }) {
  const total = song.distribution.reduce((a, b) => a + b, 0)
  const max = Math.max(1, ...song.distribution)
  return (
    <main className="pt-4 lg:grid lg:grid-cols-2 lg:gap-16">
      <div>
        <div className="flex items-start gap-4">
          <Artwork url={song.artworkUrl} size={96} />
          <div className="min-w-0">
            <h1 className="font-display text-[1.75rem] leading-tight break-words">{song.title}</h1>
            <p className="mt-1 text-muted">{song.artist}</p>
          </div>
        </div>

        <LikeButton song={song} />

        <section aria-labelledby="summary" className="mt-10">
          <h2 id="summary" className="sr-only">
            みんなの評価
          </h2>
          <p className="mb-2 flex items-baseline justify-between">
            <span className="text-lg font-bold">{song.avgLevel === null ? '難易度' : levelLabel(song.avgLevel)}</span>
            <span className="text-sm text-muted">
              {song.avgLevel === null ? '' : `平均 ${song.avgLevel.toFixed(1)} / ${MAX_LEVEL}　${total}票`}
            </span>
          </p>
          <FretMeter avg={song.avgLevel} size="lg" />
          {total > 0 && (
            <dl className="mt-4 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 text-sm">
              {LEVELS.map((l, i) => (
                <Distribution key={l.value} label={l.label} count={song.distribution[i] ?? 0} max={max} />
              ))}
            </dl>
          )}
        </section>
      </div>

      {/* PC では右列。投票とリンクを曲情報の横に並べる */}
      <div className="lg:pt-2">
        <VoteBoard song={song} />

        <section aria-labelledby="links" className="mt-10">
          <h2 id="links" className="font-bold">
            聴く
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {/* Apple Music Identity Guidelines: 公式バッジを改変せず、Apple Music へリンクし、他サービスより先に置く */}
            {song.appleMusicUrl && (
              <a href={song.appleMusicUrl} target="_blank" rel="noopener noreferrer" className="inline-block p-1">
                <img
                  src="/badges/apple-music-ja.svg"
                  alt="Apple Music で聴く"
                  width={140}
                  height={40}
                  className="h-10 w-auto"
                />
              </a>
            )}
            {/* Spotify Design Guidelines: 公式アイコンを改変せず 21px 以上、周囲にアイコン高さの半分の余白。
                緑は白黒背景のみ可なので、この背景色では単色（ライトは黒・ダークは白）を使う */}
            <a
              href={song.spotifyUrl ?? spotifySearchUrl(song.title, song.artist)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center gap-3 rounded-[8px] border-2 border-ink px-3 font-bold hover:bg-line/50"
            >
              <picture>
                <source srcSet="/badges/spotify-icon-white.svg" media="(prefers-color-scheme: dark)" />
                <img src="/badges/spotify-icon-black.svg" alt="" width={24} height={24} className="size-6" />
              </picture>
              {song.spotifyUrl ? 'Spotify で聴く' : 'Spotify で探す'}
            </a>
          </div>

          <h2 className="mt-8 font-bold">コード譜・楽譜を探す</h2>
          <ul className="mt-2 divide-y divide-line border-y border-line">
            <ExternalLink href={ufretSearchUrl(song.title)}>U-FRET でコード譜を探す</ExternalLink>
            <ExternalLink href={googleScoreSearchUrl(song.title, song.artist)}>Google で楽譜を探す</ExternalLink>
          </ul>
        </section>
      </div>
    </main>
  )
}

function Distribution({ label, count, max }: { label: string; count: number; max: number }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="h-2 rounded-full bg-line">
        <span className="block h-full rounded-full bg-pick" style={{ width: `${(count / max) * 100}%` }} />
      </dd>
      <dd className="text-right tabular-nums">{count}</dd>
    </>
  )
}

/** いいねは誰でも押せる。難易度の投票とは独立していて、ランキングの順位はいいね数で決まる。 */
function LikeButton({ song }: { song: SongDetail }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    // 初回は確認ダイアログを挟んでから送る（署名付きの投票者 ID が必要）
    mutationFn: (like: boolean) => withVerification(() => (like ? api.like(song.id) : api.unlike(song.id))),
    onSuccess: (data: SongResponse) => {
      queryClient.setQueryData(['song', song.id], data)
      queryClient.invalidateQueries({ queryKey: ['ranking'] })
    },
  })
  const liked = mutation.isPending ? mutation.variables : song.myLike
  const count = song.likeCount + (mutation.isPending ? (liked ? 1 : -1) : 0)
  const likeError = mutation.isError
    ? actionErrorMessage(mutation.error, 'いいねを保存できませんでした。もう一度押してください。')
    : null

  return (
    <div className="mt-6">
      <button
        type="button"
        aria-pressed={liked}
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(!song.myLike)}
        className={`inline-flex items-center gap-2 rounded-full border-2 px-4 py-2 font-bold transition-transform active:scale-95 ${
          liked ? 'border-pick bg-pick text-pick-ink' : 'border-ink'
        }`}
      >
        <PickIcon filled={liked} className={`size-5 ${liked ? 'text-pick-ink' : 'text-ink'}`} />
        いいね
        <span className="tabular-nums">{Math.max(0, count)}</span>
      </button>
      {likeError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {likeError}
        </p>
      )}
    </div>
  )
}

/** 難易度は弾き語りしたことがある人向けの任意の投票。指板の上で近いところを選ぶ。 */
function VoteBoard({ song }: { song: SongDetail }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (level: number) => withVerification(() => api.vote(song.id, level)),
    onSuccess: (data: SongResponse) => {
      queryClient.setQueryData(['song', song.id], data)
      queryClient.invalidateQueries({ queryKey: ['ranking'] })
    },
  })
  const selected = mutation.isPending ? mutation.variables : song.myVote
  const voteError = mutation.isError
    ? actionErrorMessage(mutation.error, '評価を保存できませんでした。もう一度選んでください。')
    : null

  return (
    <section aria-labelledby="vote" className="mt-10 lg:mt-0">
      <h2 id="vote" className="font-bold">
        {song.myVote === null ? '弾き語りしてみた難しさ' : 'あなたが弾き語りしてみた難しさ'}
      </h2>
      <p className="text-sm text-muted">
        {song.myVote === null
          ? '弾き語りしたことがある人だけ、近いところを選んでください。'
          : '選び直すと評価を変更できます。'}
      </p>
      <div className="relative mt-3 grid h-16 grid-cols-4 overflow-hidden rounded-[4px] bg-board shadow-[inset_0_2px_0_var(--color-board-edge),inset_0_-2px_0_var(--color-board-edge)]">
        <Fingerboard />
        {LEVELS.map((l) => (
          <button
            key={l.value}
            type="button"
            aria-pressed={selected === l.value}
            aria-label={l.label}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(l.value)}
            className={`group relative flex items-center justify-center focus-visible:-outline-offset-4 ${
              selected === l.value ? 'bg-pick/20' : 'hover:bg-white/10 focus-visible:bg-white/10'
            }`}
          >
            {/* 押せる位置を常に輪郭の丸で示し、選んだ位置だけピック色で塗る */}
            <span
              className={`size-7 rounded-full border-2 transition-transform duration-150 ${
                selected === l.value
                  ? 'scale-110 border-white bg-pick'
                  : 'border-nut/70 group-hover:border-nut group-hover:bg-nut/20 group-focus-visible:border-nut'
              }`}
            />
          </button>
        ))}
      </div>
      <LevelLabels selected={selected} />
      {voteError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {voteError}
        </p>
      )}
      <output aria-live="polite" className="mt-2 block text-sm">
        {mutation.isSuccess && !mutation.isPending ? '評価を保存しました。' : null}
      </output>
    </section>
  )
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <a href={href} target="_blank" rel="noopener noreferrer" className="flex justify-between py-3 hover:text-muted">
        {children}
        <span aria-hidden className="text-muted">
          ↗
        </span>
      </a>
    </li>
  )
}
