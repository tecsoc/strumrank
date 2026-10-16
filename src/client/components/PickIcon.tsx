/** ギターのピック型。いいねの印に使う（ハートではなく弾き語りの道具で表す）。 */
export function PickIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        d="M12 22c-1.2 0-2-1-3.3-3.1C6.6 15.6 3 10.1 3 6.6 3 3.6 6.5 2 12 2s9 1.6 9 4.6c0 3.5-3.6 9-5.7 12.3C14 21 13.2 22 12 22Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.8}
        strokeLinejoin="round"
      />
    </svg>
  )
}
