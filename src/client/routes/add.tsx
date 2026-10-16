import { createFileRoute } from '@tanstack/react-router'
import { SongSearch } from '../components/SongSearch'

export const Route = createFileRoute('/add')({
  component: AddPage,
})

function AddPage() {
  return (
    <main className="mx-auto max-w-[640px] pt-4">
      <h1 className="font-display text-[1.75rem] leading-tight">曲を探して追加</h1>
      <p className="mt-1 mb-6 text-muted">曲名かアーティスト名を入力すると候補が出ます。</p>
      <SongSearch />
      <p className="mt-10 text-xs text-muted">シングル版・アルバム版・ライブ版は同じ曲として扱います。</p>
    </main>
  )
}
