import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  notFoundComponent: () => (
    <p className="py-16 text-muted">
      ページが見つかりません。
      <Link to="/" className="underline">
        ランキングに戻る
      </Link>
    </p>
  ),
})

function RootLayout() {
  return (
    <div className="mx-auto max-w-[640px] px-4 pb-24 lg:max-w-[1040px] lg:px-8">
      <header className="flex items-baseline justify-between gap-4 pt-6 pb-2">
        <Link to="/" search={{}} className="font-display text-2xl tracking-tight">
          strumrank
        </Link>
        <Link
          to="/add"
          className="rounded-full bg-pick px-4 py-1.5 text-sm font-bold text-pick-ink"
          activeProps={{ className: 'invisible' }}
        >
          曲を追加
        </Link>
      </header>
      <Outlet />
      <footer className="mt-20 border-t border-line pt-6 text-xs leading-relaxed text-muted">
        <p>strumrank は個人が運営する非公式サイトです。各音楽サービスとは提携していません。</p>
        <p className="mt-1">
          Apple Music は Apple Inc.、Spotify は Spotify AB の商標です。曲の作品情報の一部に{' '}
          <a href="https://musicbrainz.org/" target="_blank" rel="noopener noreferrer" className="underline">
            MusicBrainz
          </a>{' '}
          のデータを利用しています。
        </p>
      </footer>
    </div>
  )
}
