import { useEffect, useId, useRef, useState } from 'react'
import { loadTurnstile, TURNSTILE_ACTION } from '../lib/turnstile'

/**
 * 投票・いいねの前に1回だけ出す確認ダイアログ。Turnstile のトークンを受け取ったら onToken を呼ぶ。
 * 確認が済むと署名付きの投票者 ID が発行され、以後は出ない。
 */
export function VerifyGate({
  siteKey,
  onToken,
  onCancel,
  error,
}: {
  siteKey: string
  onToken: (token: string) => void
  onCancel: () => void
  error: string | null
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const widgetRef = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState(false)

  // ウィジェットの描画。onToken は最新を参照する
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken
  useEffect(() => {
    let widgetId: string | null = null
    let cancelled = false
    loadTurnstile()
      .then((ts) => {
        if (cancelled || !widgetRef.current) return
        widgetId = ts.render(widgetRef.current, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          language: 'ja',
          theme: 'auto',
          callback: (token) => onTokenRef.current(token),
          'error-callback': () => setLoadError(true),
        })
      })
      .catch(() => setLoadError(true))
    return () => {
      cancelled = true
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId)
    }
  }, [siteKey])

  // フォーカスをダイアログに移し、閉じたら元の要素へ戻す。Esc で閉じる
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-sm rounded-[6px] bg-paper p-5 text-ink shadow-lg outline-none"
      >
        <h2 id={titleId} className="font-bold">
          投票の前に、ロボットでないことを確認します
        </h2>
        <p className="mt-1 text-sm text-muted">
          自動投票を防ぐための確認です。通常は最初の1回だけですが、接続環境によってはときどき表示されます。
        </p>
        <div ref={widgetRef} className="mt-4 min-h-[65px]" />
        {(error || loadError) && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error ?? '確認を読み込めませんでした。通信状況を確認して、もう一度お試しください。'}
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-4 py-1.5 text-sm text-muted hover:text-ink"
          >
            やめる
          </button>
        </div>
      </div>
    </div>
  )
}
