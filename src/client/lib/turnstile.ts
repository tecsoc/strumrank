// Turnstile のスクリプトを必要になったときに1回だけ読み込む

type RenderOptions = {
  sitekey: string
  /** サーバーが siteverify の応答と照合する用途名 */
  action?: string
  callback: (token: string) => void
  'error-callback'?: () => void
  'expired-callback'?: () => void
  language?: string
  theme?: 'auto' | 'light' | 'dark'
}

type TurnstileApi = {
  render: (el: HTMLElement, opts: RenderOptions) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

/** サーバー（src/worker/voter.ts の TURNSTILE_ACTION）と同じ値にする */
export const TURNSTILE_ACTION = 'vote'

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | null = null

export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!loading) {
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_URL
      script.async = true
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile_unavailable')))
      script.onerror = () => {
        loading = null // 次回やり直せるようにする
        script.remove()
        reject(new Error('turnstile_load_failed'))
      }
      document.head.appendChild(script)
    })
  }
  return loading
}
