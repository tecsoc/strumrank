import type { RankingResponse, RegisterSongInput, ResolveResponse, SongResponse, SongSummary } from '../../shared/api'
import type { Sort } from '../../shared/levels'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    // 投票直後の再取得で古いランキングが返らないよう、ブラウザの HTTP キャッシュは都度検証する
    cache: 'no-cache',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, body.error ?? 'unknown')
  }
  return res.json() as Promise<T>
}

export const api = {
  ranking: (q: { level?: number; sort: Sort; cursor: number }) => {
    const params = new URLSearchParams({ sort: q.sort, cursor: String(q.cursor) })
    if (q.level !== undefined) params.set('level', String(q.level))
    return request<RankingResponse>(`/ranking?${params}`)
  },
  song: (id: number) => request<SongResponse>(`/songs/${id}`),
  suggest: (q: string, signal?: AbortSignal) =>
    request<SongSummary[]>(`/songs/suggest?${new URLSearchParams({ q })}`, { signal }),
  vote: (id: number, level: number) =>
    request<SongResponse>(`/songs/${id}/vote`, { method: 'PUT', body: JSON.stringify({ level }) }),
  like: (id: number) => request<SongResponse>(`/songs/${id}/like`, { method: 'PUT' }),
  unlike: (id: number) => request<SongResponse>(`/songs/${id}/like`, { method: 'DELETE' }),
  register: (input: RegisterSongInput) =>
    request<{ id: number; created: boolean }>('/songs', { method: 'POST', body: JSON.stringify(input) }),
  resolve: (items: { itunesTrackId: number; title: string; artist: string }[]) =>
    request<ResolveResponse>('/songs/resolve', { method: 'POST', body: JSON.stringify({ items }) }),
}
