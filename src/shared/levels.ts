export const LEVELS = [
  { value: 1, label: '初心者向け' },
  { value: 2, label: '中級者向け' },
  { value: 3, label: '上級者向け' },
  { value: 4, label: '超上級者向け' },
] as const

export type Level = (typeof LEVELS)[number]['value']
export const MIN_LEVEL = 1
export const MAX_LEVEL = LEVELS.length

export const SORTS = ['likes', 'easy', 'hard', 'votes', 'new'] as const
export type Sort = (typeof SORTS)[number]

/** 平均値から表示上のレベルを求める。ランキングの絞り込みもこの区切りを使う。 */
export function levelOf(avg: number): Level {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(avg))) as Level
}

export function levelLabel(avg: number): string {
  return LEVELS[levelOf(avg) - 1]?.label ?? ''
}
