import { memo } from 'react'
import { LEVELS, levelLabel, MAX_LEVEL } from '../../shared/levels'

/**
 * 難易度を指板の上の押さえる位置で表す。ナット（左端）が初心者向け、右へ行くほど難しい。
 * 平均値は小数のまま位置に反映するので、同じレベル内の差も見える。
 */
export const FretMeter = memo(function FretMeter({ avg, size = 'sm' }: { avg: number | null; size?: 'sm' | 'lg' }) {
  const lg = size === 'lg'
  if (avg === null) {
    // 票がないときは指板を出さない（暗い帯だけが見えて「何もない」ことが伝わらないため）
    return (
      <div
        className={`flex items-center justify-center rounded-[3px] border border-dashed border-line text-muted ${
          lg ? 'h-11 w-full text-sm' : 'h-5 w-24 shrink-0 text-[11px]'
        }`}
      >
        {lg ? 'まだ票がありません' : '票なし'}
      </div>
    )
  }
  const position = ((avg - 0.5) / MAX_LEVEL) * 100
  return (
    <div className={lg ? 'w-full' : 'w-24 shrink-0'}>
      <div
        role="img"
        aria-label={`平均 ${avg.toFixed(1)}、${levelLabel(avg)}`}
        className={`relative overflow-hidden rounded-[3px] bg-board shadow-[inset_0_2px_0_var(--color-board-edge),inset_0_-2px_0_var(--color-board-edge)] ${
          lg ? 'h-11' : 'h-5'
        }`}
      >
        <Fingerboard />
        <span
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-pick ring-white ${
            lg ? 'size-6 ring-[3px]' : 'size-3.5 ring-2'
          }`}
          style={{ left: `${position}%` }}
        />
      </div>
      {lg && <LevelLabels />}
    </div>
  )
})

/** 4段階のラベル行。指板の各フレット間の真下に置く。 */
export function LevelLabels({ selected }: { selected?: number | null }) {
  return (
    <div className="mt-1.5 grid grid-cols-4 text-center text-xs text-muted">
      {LEVELS.map((l) => (
        <span key={l.value} className={selected === l.value ? 'font-bold text-ink' : undefined}>
          {l.label}
        </span>
      ))}
    </div>
  )
}

// 上ほど細い弦（実際のギターの1弦側を上に見立てる）
const STRINGS = [
  { top: '25%', h: 'h-px' },
  { top: '50%', h: 'h-[1.5px]' },
  { top: '75%', h: 'h-[2px]' },
]

/** ナット・フレット・弦の描画。投票用の指板と共用する。 */
export function Fingerboard() {
  return (
    <>
      <span aria-hidden className="absolute inset-y-0 left-0 w-[5px] bg-nut" />
      {LEVELS.slice(1).map((l) => (
        <span
          key={l.value}
          aria-hidden
          className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-fret"
          style={{ left: `${((l.value - 1) / MAX_LEVEL) * 100}%` }}
        />
      ))}
      {STRINGS.map((s) => (
        <span
          key={s.top}
          aria-hidden
          className={`absolute inset-x-0 -translate-y-1/2 bg-string/80 ${s.h}`}
          style={{ top: s.top }}
        />
      ))}
    </>
  )
}
