// 投票・いいねの API が 401 verification_required を返したら確認ダイアログを出し、
// 投票者 ID の発行が済んだら元の操作を1回だけやり直す。
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VerifyGate } from '../components/VerifyGate'
import { ApiError } from './api'

export class VerificationCancelled extends Error {
  constructor() {
    super('verification_cancelled')
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  verification_failed: '確認できませんでした。もう一度お試しください。',
  too_many_voters: 'この回線からの投票が多すぎます。時間をおいてからお試しください。',
  rate_limited: '操作が多すぎます。少し待ってからやり直してください。',
  too_many_from_network: 'この回線からこの曲への票が上限に達しました。',
}

async function getSiteKey(): Promise<string> {
  const res = await fetch('/api/session', { cache: 'no-store' })
  if (!res.ok) throw new ApiError(res.status, 'session_unavailable')
  return ((await res.json()) as { siteKey: string }).siteKey
}

async function postToken(token: string): Promise<void> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, body.error ?? 'unknown')
  }
}

/** ダイアログを出し、投票者 ID の発行が済んだら resolve する。閉じたら VerificationCancelled。 */
function verifyOnce(): Promise<void> {
  return getSiteKey().then(
    (siteKey) =>
      new Promise<void>((resolve, reject) => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root: Root = createRoot(container)
        let attempt = 0
        let busy = false

        const close = () => {
          root.unmount()
          container.remove()
        }
        const render = (error: string | null) => {
          // トークンは使い捨てなので、失敗したら key を変えてウィジェットを作り直す
          root.render(
            createElement(VerifyGate, {
              key: attempt,
              siteKey,
              error,
              onCancel: () => {
                close()
                reject(new VerificationCancelled())
              },
              onToken: (token: string) => {
                if (busy) return
                busy = true
                postToken(token).then(
                  () => {
                    close()
                    resolve()
                  },
                  (e: unknown) => {
                    busy = false
                    const code = e instanceof ApiError ? e.code : 'unknown'
                    // 上限超過はやり直しても通らないので閉じて呼び出し元に返す
                    if (code === 'too_many_voters' || code === 'rate_limited') {
                      close()
                      reject(e)
                      return
                    }
                    attempt++
                    render(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.verification_failed ?? null)
                  },
                )
              },
            }),
          )
        }
        render(null)
      }),
  )
}

// 同時に複数の操作が 401 になってもダイアログは1つだけ出す
let pending: Promise<void> | null = null

export async function withVerification<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401 && e.code === 'verification_required')) throw e
  }
  if (!pending) pending = verifyOnce().finally(() => (pending = null))
  await pending
  return fn()
}

/** 画面に出すエラーメッセージ。確認ダイアログを閉じた場合は null（何も出さない）。 */
export function verificationErrorMessage(e: unknown): string | null {
  if (e instanceof VerificationCancelled) return null
  if (e instanceof ApiError) return ERROR_MESSAGES[e.code] ?? null
  return null
}

/**
 * 投票・いいねの失敗を画面の文言にする。確認ダイアログを閉じた場合は null（何も出さない）。
 * 既知のエラーでなければ fallback を返す。
 */
export function actionErrorMessage(e: unknown, fallback: string): string | null {
  if (e instanceof VerificationCancelled) return null
  return verificationErrorMessage(e) ?? fallback
}
