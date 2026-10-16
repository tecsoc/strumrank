import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { memo, useEffect, useId, useRef, useState } from 'react'
import type { SongSummary } from '../../shared/api'
import { levelLabel } from '../../shared/levels'
import { ApiError, api } from '../lib/api'
import { type Candidate, searchItunes } from '../lib/itunes'
import { useDebounced } from '../lib/useDebounced'
import { Artwork } from './Artwork'

// iTunes は 1分あたり約20回まで。打鍵ごとに叩かないよう長めに待つ
const LOCAL_DEBOUNCE_MS = 200
const ITUNES_DEBOUNCE_MS = 600
const ITUNES_MIN_LENGTH = 2
// 制限に当たったら、しばらく外部検索を止めて制限が延びるのを防ぐ
const RATE_LIMIT_COOLDOWN_MS = 60_000

type Option =
  | { kind: 'song'; id: string; song: SongSummary }
  | { kind: 'candidate'; id: string; candidate: Candidate; registeredId: number | undefined }

/** 入力補完つきの曲検索。登録済みの曲を先に、iTunes の候補をその下に出す。 */
export function SongSearch() {
  const listId = useId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const [cooldownUntil, setCooldownUntil] = useState(0)
  // 日本語入力の変換中は検索語を確定させない（未確定の文字列で検索しない）
  const [committed, setCommitted] = useState('')
  const [composing, setComposing] = useState(false)
  // 添字だと非同期で候補が入れ替わったときに別の曲を指すため、候補の id で持つ
  const [activeId, setActiveId] = useState<string | null>(null)
  const term = committed.trim()
  const localTerm = useDebounced(term, LOCAL_DEBOUNCE_MS)
  const itunesTerm = useDebounced(term, ITUNES_DEBOUNCE_MS)

  const local = useQuery({
    queryKey: ['suggest', localTerm],
    queryFn: ({ signal }) => api.suggest(localTerm, signal),
    enabled: localTerm.length > 0,
    placeholderData: keepPreviousData,
  })
  const itunes = useQuery({
    queryKey: ['itunes', itunesTerm],
    queryFn: ({ signal }) => searchItunes(itunesTerm, signal),
    enabled: itunesTerm.length >= ITUNES_MIN_LENGTH && cooldownUntil === 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    placeholderData: keepPreviousData,
  })
  const candidates = itunes.data ?? []
  const rateLimited = itunes.error?.message === 'rate_limited'
  useEffect(() => {
    if (rateLimited) setCooldownUntil(Date.now() + RATE_LIMIT_COOLDOWN_MS)
  }, [rateLimited])
  useEffect(() => {
    if (cooldownUntil === 0) return
    const t = setTimeout(() => setCooldownUntil(0), Math.max(0, cooldownUntil - Date.now()))
    return () => clearTimeout(t)
  }, [cooldownUntil])
  const resolved = useQuery({
    queryKey: ['resolve', candidates.map((c) => c.itunesTrackId)],
    queryFn: () =>
      api.resolve(candidates.map(({ itunesTrackId, title, artist }) => ({ itunesTrackId, title, artist }))),
    enabled: candidates.length > 0,
    placeholderData: keepPreviousData,
  })

  const register = useMutation({
    mutationFn: (c: Candidate) =>
      api.register({
        itunesTrackId: c.itunesTrackId,
        title: c.title,
        artist: c.artist,
        artworkUrl: c.artworkUrl,
        appleMusicUrl: c.appleMusicUrl,
        durationMs: c.durationMs,
      }),
    onSuccess: ({ id }) => {
      // 追加した曲がランキングの新着や検索候補にすぐ出るようにする
      for (const key of ['ranking', 'suggest', 'resolve']) queryClient.invalidateQueries({ queryKey: [key] })
      navigate({ to: '/songs/$songId', params: { songId: String(id) } })
    },
  })

  const showLists = term.length > 0
  const localSongs = showLists ? (local.data ?? []) : []
  const localIds = new Set(localSongs.map((s) => s.id))
  const options: Option[] = [
    ...localSongs.map((song) => ({ kind: 'song' as const, id: `s${song.id}`, song })),
    ...(showLists && term.length >= ITUNES_MIN_LENGTH ? candidates : [])
      .map((candidate) => ({
        kind: 'candidate' as const,
        id: `c${candidate.itunesTrackId}`,
        candidate,
        registeredId: resolved.data?.[String(candidate.itunesTrackId)],
      }))
      // 登録済みの曲として上に出ているものは重ねて出さない
      .filter((o) => o.registeredId === undefined || !localIds.has(o.registeredId)),
  ]

  const choose = (o: Option) => {
    if (register.isPending) return // 追加中に別の候補を選んでも二重に登録しない
    if (o.kind === 'song') navigate({ to: '/songs/$songId', params: { songId: String(o.song.id) } })
    else if (o.registeredId !== undefined)
      navigate({ to: '/songs/$songId', params: { songId: String(o.registeredId) } })
    else register.mutate(o.candidate)
  }

  const active = options.findIndex((o) => o.id === activeId)
  const moveActive = (delta: number) => {
    if (options.length === 0) return setActiveId(null)
    const next =
      active === -1 ? (delta > 0 ? 0 : options.length - 1) : (active + delta + options.length) % options.length
    setActiveId(options[next]?.id ?? null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || composing) return // 日本語入力の変換確定 Enter では選ばない
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      const o = options[active]
      if (o) choose(o)
    } else if (e.key === 'Escape') {
      setValue('')
      setCommitted('')
      setActiveId(null)
    }
  }

  const activeOption = options[active]
  const songOptions = options.filter((o) => o.kind === 'song')
  const candidateOptions = options.filter((o) => o.kind === 'candidate')
  const status = statusMessage({
    term,
    searching: term.length >= ITUNES_MIN_LENGTH && (itunesTerm !== term || itunes.isFetching),
    searched: itunes.isSuccess && itunesTerm === term,
    failed: itunes.isError && !rateLimited && itunesTerm === term,
    coolingDown: cooldownUntil !== 0,
    candidateCount: candidates.length,
    optionCount: options.length,
  })

  return (
    <div>
      <input
        type="search"
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
        aria-label="曲名かアーティスト名"
        placeholder="例：マリーゴールド、あいみょん"
        autoComplete="off"
        enterKeyHint="search"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          if (!composing) setCommitted(e.target.value)
          setActiveId(null)
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(e) => {
          setComposing(false)
          setCommitted(e.currentTarget.value)
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-[4px] border-2 border-ink bg-transparent px-4 py-3 text-lg placeholder:text-muted/70 focus-visible:border-pick focus-visible:outline-none"
      />

      {register.isError && (
        <p className="mt-2 text-sm text-danger">
          {register.error instanceof ApiError && register.error.status === 422
            ? 'カラオケ版やインストゥルメンタルは追加できません。歌入りの録音を選んでください。'
            : '曲を追加できませんでした。もう一度選んでください。'}
        </p>
      )}

      <div id={listId} role="listbox" aria-label="候補" className="mt-3">
        {[
          { key: 'songs', heading: '登録済みの曲', items: songOptions },
          { key: 'candidates', heading: '新しく追加', items: candidateOptions },
        ].map(
          (group) =>
            group.items.length > 0 && (
              // biome-ignore lint/a11y/useSemanticElements: listbox 内の見出し付きグループは ARIA の group が正しい（fieldset はフォーム用）
              <div key={group.key} role="group" aria-labelledby={`${listId}-${group.key}`} className="mt-4 first:mt-0">
                <div id={`${listId}-${group.key}`} role="presentation" className="mb-1 text-sm font-bold text-muted">
                  {group.heading}
                </div>
                {group.items.map((o) => (
                  <SuggestionItem
                    key={o.id}
                    option={o}
                    domId={`${listId}-${o.id}`}
                    active={o.id === activeOption?.id}
                    busy={register.isPending && o.kind === 'candidate' && register.variables === o.candidate}
                    onChoose={choose}
                  />
                ))}
              </div>
            ),
        )}
      </div>
      {/* 検索状態と候補件数を読み上げる。live region は常に置いておく */}
      <output aria-live="polite" className="mt-3 block text-sm text-muted">
        {status}
        {term.length > 0 && <span className="sr-only">候補 {options.length} 件</span>}
      </output>
    </div>
  )
}

function statusMessage(s: {
  term: string
  searching: boolean
  searched: boolean
  failed: boolean
  coolingDown: boolean
  candidateCount: number
  optionCount: number
}): string | null {
  if (s.term.length === 0) return null
  if (s.term.length < ITUNES_MIN_LENGTH) return 'もう1文字入力すると、新しく追加できる曲も探します。'
  if (s.coolingDown) return '検索が混み合っています。1分ほどで、新しく追加できる曲の検索を再開します。'
  if (s.failed) return '曲を検索できませんでした。通信状況を確認してください。'
  if (s.searching && s.candidateCount === 0) return '検索中…'
  // 検索が終わって候補が1件もないときだけ「見つからない」と伝える
  if (s.searched && !s.searching && s.optionCount === 0)
    return '見つかりませんでした。曲名の表記を変えて試してください。'
  return null
}

const SuggestionItem = memo(function SuggestionItem({
  option,
  domId,
  active,
  busy,
  onChoose,
}: {
  option: Option
  domId: string
  active: boolean
  busy: boolean
  onChoose: (o: Option) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // 矢印キーで選んだ候補を画面内に入れる（スマホでキーボード表示中も見えるように）
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const isSong = option.kind === 'song'
  const title = isSong ? option.song.title : option.candidate.title
  const artist = isSong ? option.song.artist : option.candidate.artist
  const artwork = isSong ? option.song.artworkUrl : option.candidate.artworkUrl
  const note = isSong
    ? option.song.avgLevel === null
      ? '票なし'
      : `${levelLabel(option.song.avgLevel)} ${option.song.voteCount}票`
    : option.registeredId !== undefined
      ? '登録済み'
      : busy
        ? '追加中…'
        : '追加'

  return (
    <>
      {/* キーボード操作は入力欄（combobox）側で受ける */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: aria-activedescendant パターンのため */}
      <div
        ref={ref}
        id={domId}
        role="option"
        aria-selected={active}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()} // 入力欄のフォーカスを保つ
        onClick={() => onChoose(option)}
        className={`grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-line px-1 py-2.5 ${
          active ? 'bg-pick/15' : 'hover:bg-line/50'
        }`}
      >
        <Artwork url={artwork} size={44} />
        <span className="min-w-0">
          <span className="block truncate font-bold">{title}</span>
          <span className="block truncate text-sm text-muted">{artist}</span>
        </span>
        <span
          className={`shrink-0 text-sm ${
            !isSong && option.registeredId === undefined
              ? 'rounded-full border-2 border-ink px-3 py-0.5 font-bold'
              : 'text-muted'
          }`}
        >
          {note}
        </span>
      </div>
    </>
  )
})
