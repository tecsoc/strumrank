// iTunes Search API はブラウザから直接呼ぶ（CORS 可）。
// Workers から呼ぶと共有 IP のため 429 になりやすく、利用者ごとの IP に分散させる狙いもある。
import type { RegisterSongInput } from '../../shared/api'
import { isExcludedRecording, normalizeArtist, normalizeTitle } from '../../shared/normalize'

type ItunesTrack = {
  trackId: number
  trackName: string
  artistName: string
  collectionName?: string
  artworkUrl100?: string
  trackViewUrl?: string
  trackTimeMillis?: number
}

const MAX_CANDIDATES = 12

export type Candidate = RegisterSongInput & { key: string; albums: string[] }

export async function searchItunes(term: string, signal?: AbortSignal): Promise<Candidate[]> {
  const params = new URLSearchParams({
    term,
    country: 'jp',
    lang: 'ja_jp',
    media: 'music',
    entity: 'song',
    limit: '30',
  })
  const res = await fetch(`https://itunes.apple.com/search?${params}`, { signal })
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'rate_limited' : 'search_failed')
  const { results } = (await res.json()) as { results: ItunesTrack[] }

  // シングル/アルバム/ライブ等の録音違いは1件にまとめ、最初に出たものを代表にする
  const byKey = new Map<string, Candidate>()
  for (const t of results) {
    if (isExcludedRecording(t.trackName)) continue
    const key = `${normalizeArtist(t.artistName)}\u0000${normalizeTitle(t.trackName)}`
    const existing = byKey.get(key)
    if (existing) {
      if (t.collectionName && !existing.albums.includes(t.collectionName)) existing.albums.push(t.collectionName)
      continue
    }
    byKey.set(key, {
      key,
      itunesTrackId: t.trackId,
      title: t.trackName,
      artist: t.artistName,
      artworkUrl: t.artworkUrl100?.replace('100x100bb', '200x200bb'),
      appleMusicUrl: t.trackViewUrl,
      durationMs: t.trackTimeMillis,
      albums: t.collectionName ? [t.collectionName] : [],
    })
  }
  // 部分一致で関係の薄い曲も返るため、上位だけに絞る
  return [...byKey.values()].slice(0, MAX_CANDIDATES)
}
