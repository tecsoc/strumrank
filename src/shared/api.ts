// フロントと API で共有するリクエスト/レスポンスの型

export type SongSummary = {
  id: number
  title: string
  artist: string
  artworkUrl: string | null
  voteCount: number
  avgLevel: number | null
  likeCount: number
}

export type RankingResponse = {
  items: SongSummary[]
  nextCursor: number | null
}

export type SongDetail = SongSummary & {
  appleMusicUrl: string | null
  /** distribution[i] は難易度 i+1 の票数 */
  distribution: number[]
  myVote: number | null
  myLike: boolean
}

/** 統合済みの曲を開いたときは統合先の ID を返す */
export type SongResponse = { song: SongDetail } | { mergedInto: number }

export type RegisterSongInput = {
  itunesTrackId: number
  title: string
  artist: string
  artworkUrl?: string
  appleMusicUrl?: string
  durationMs?: number
}

export type ResolveResponse = Record<string, number>
