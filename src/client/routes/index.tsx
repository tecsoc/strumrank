import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { memo } from 'react'
import { z } from 'zod'
import type { SongSummary } from '../../shared/api'
import { LEVELS, levelLabel, MAX_LEVEL, MIN_LEVEL, SORTS, type Sort } from '../../shared/levels'
import { Artwork } from '../components/Artwork'
import { FretMeter } from '../components/FretMeter'
import { PickIcon } from '../components/PickIcon'
import { api } from '../lib/api'

// 絞り込み条件は URL クエリだけを正とする（共有・戻る操作で同じ一覧になる）
const searchSchema = z.object({
  level: z.number().int().min(MIN_LEVEL).max(MAX_LEVEL).optional().catch(undefined),
  sort: z.enum(SORTS).optional().catch(undefined),
})

export const Route = createFileRoute('/')({
  validateSearch: searchSchema,
  component: RankingPage,
})

// ランキングはいいね数で決める。URL で sort を省略したときはいいね順
const DEFAULT_SORT: Sort = 'likes'
const SORT_ORDER: Sort[] = ['likes', 'easy', 'hard', 'votes', 'new']
const SORT_LABELS: Record<Sort, string> = {
  likes: 'いいね順',
  easy: 'やさしい順',
  hard: '難しい順',
  votes: '票が多い順',
  new: '新着',
}

/** 既定の並びは URL に出さない */
const sortParam = (s: Sort) => (s === DEFAULT_SORT ? undefined : s)

function RankingPage() {
  const { level, sort = DEFAULT_SORT } = Route.useSearch()
  const query = useInfiniteQuery({
    queryKey: ['ranking', level ?? null, sort],
    queryFn: ({ pageParam }) => api.ranking({ level, sort, cursor: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  // ページ送りの間に順位が入れ替わると同じ曲が2ページに出うるため、id で重複を除く
  const items = [...new Map((query.data?.pages.flatMap((p) => p.items) ?? []).map((s) => [s.id, s] as const)).values()]

  return (
    <main className="lg:grid lg:grid-cols-[200px_1fr] lg:gap-12">
      {/* スマホでは上部の横並びタブ、PC では左に固定した縦並び */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="mt-1 mb-6">
          <p className="break-keep font-bold">
            弾き語りしたい曲を、
            <wbr />
            難しさ別に探せるランキング
          </p>
          <p className="mt-1 text-sm text-muted">人気はいいねの数、難しさは弾き語りした人の評価で決まります。</p>
        </div>

        <nav
          aria-label="難易度"
          className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:overflow-visible lg:px-0"
        >
          <ul className="flex gap-1 border-b border-line lg:flex-col lg:gap-0 lg:border-b-0 lg:border-l">
            <FilterTab level={undefined} sort={sort} active={level === undefined}>
              すべて
            </FilterTab>
            {LEVELS.map((l) => (
              <FilterTab key={l.value} level={l.value} sort={sort} active={level === l.value}>
                {l.label}
              </FilterTab>
            ))}
          </ul>
        </nav>

        <nav aria-label="並び順" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm lg:mt-8 lg:flex-col lg:gap-y-2">
          {SORT_ORDER.map((s) => (
            <Link
              key={s}
              to="/"
              search={{ level, sort: sortParam(s) }}
              replace
              className={s === sort ? 'font-bold text-ink' : 'text-muted hover:text-ink'}
              aria-current={s === sort ? 'true' : undefined}
            >
              {SORT_LABELS[s]}
            </Link>
          ))}
        </nav>
      </aside>

      <section aria-label="ランキング" className="min-w-0">
        {query.isPending ? (
          <p className="py-12 text-muted">読み込み中…</p>
        ) : query.isError && !query.data ? (
          <p className="py-12 text-danger">
            ランキングを読み込めませんでした。
            <button type="button" className="underline" onClick={() => query.refetch()}>
              再読み込み
            </button>
          </p>
        ) : items.length === 0 ? (
          <EmptyState level={level} sort={sort} />
        ) : (
          <ol className="mt-4 lg:mt-0">
            {items.map((song, i) => (
              <RankingRow key={song.id} song={song} rank={sort === 'new' ? null : i + 1} />
            ))}
          </ol>
        )}

        {query.isFetchNextPageError && (
          <p role="alert" className="mt-6 text-sm text-danger">
            続きを読み込めませんでした。
            <button type="button" className="underline" onClick={() => query.fetchNextPage()}>
              もう一度読み込む
            </button>
          </p>
        )}

        {query.hasNextPage && !query.isFetchNextPageError && (
          <button
            type="button"
            className="mt-6 w-full rounded-full border border-line py-2.5 text-sm font-bold"
            disabled={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? '読み込み中…' : 'さらに表示'}
          </button>
        )}
      </section>
    </main>
  )
}

function FilterTab({
  level,
  sort,
  active,
  children,
}: {
  level: number | undefined
  sort: Sort
  active: boolean
  children: React.ReactNode
}) {
  return (
    <li className="shrink-0">
      <Link
        to="/"
        search={{ level, sort: sortParam(sort) }}
        replace
        aria-current={active ? 'true' : undefined}
        className={`-mb-px block border-b-[3px] px-3 py-2 text-sm whitespace-nowrap lg:mb-0 lg:-ml-px lg:border-b-0 lg:border-l-[3px] lg:px-4 lg:text-base ${
          active ? 'border-pick font-bold text-ink' : 'border-transparent text-muted hover:text-ink'
        }`}
      >
        {children}
      </Link>
    </li>
  )
}

const RankingRow = memo(function RankingRow({ song, rank }: { song: SongSummary; rank: number | null }) {
  return (
    <li className="border-b border-line">
      <Link
        to="/songs/$songId"
        params={{ songId: String(song.id) }}
        className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-3"
      >
        <span className="flex items-center gap-3">
          {rank !== null && (
            <span className="w-7 text-right font-display text-lg leading-none text-muted tabular-nums">{rank}</span>
          )}
          <Artwork url={song.artworkUrl} />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-bold">{song.title}</span>
          <span className="block truncate text-sm text-muted">{song.artist}</span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="flex items-center gap-2">
            {song.likeCount > 0 && (
              <span className="flex items-center gap-0.5 text-sm font-bold tabular-nums">
                <PickIcon filled className="size-3.5 text-pick" />
                <span className="sr-only">いいね</span>
                {song.likeCount}
              </span>
            )}
            {song.avgLevel !== null && <FretMeter avg={song.avgLevel} />}
          </span>
          <span className="text-xs text-muted">
            {song.avgLevel === null ? '難易度は未評価' : `${levelLabel(song.avgLevel)} ${song.voteCount}票`}
          </span>
        </span>
      </Link>
    </li>
  )
})

function EmptyState({ level, sort }: { level: number | undefined; sort: Sort }) {
  // 新着以外は「いいね」か「票」がある曲だけを並べるので、曲が登録済みでも空になりうる
  const title =
    level !== undefined
      ? 'この難易度の曲はまだありません'
      : sort === 'new'
        ? 'まだ曲が登録されていません'
        : 'まだいいねや票が入った曲がありません'
  return (
    <div className="py-12">
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-muted">好きな曲にいいねしたり、弾き語りした曲の難しさを選んだりしてください。</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Link to="/add" className="inline-block rounded-full bg-pick px-5 py-2 font-bold text-pick-ink">
          曲を追加
        </Link>
        {sort !== 'new' && (
          <Link to="/" search={{ level, sort: 'new' }} className="underline">
            新着の曲を見る
          </Link>
        )}
      </div>
    </div>
  )
}
