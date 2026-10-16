// テスト用の投票者。本番と同じく署名付きの cookie を使う（未署名の ID は 401 になる）。
import { env, exports } from 'cloudflare:workers'
import { vi } from 'vitest'
import { signVoterId } from '../src/worker/voter'

const MAX_TEST_VOTERS = 50
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const signed = await Promise.all(
  Array.from({ length: MAX_TEST_VOTERS }, (_, i) => signVoterId(env.VOTER_SECRET, idOf(i + 1))),
)

/** 番号ごとに固定の、署名済み投票者の Cookie ヘッダー値 */
export function voter(n: number): string {
  const value = signed[n - 1]
  if (!value) throw new Error(`test voter ${n} is out of range`)
  return `sr_vid=${value}`
}

/**
 * 本番と同じ流れ（POST /api/session で Turnstile を通す）で投票者を発行し、Cookie ヘッダー値を返す。
 * siteverify は成功するようにモックする。
 */
export async function verifiedVoter(origin: string, ip: string): Promise<string> {
  const spy = vi
    .spyOn(globalThis, 'fetch')
    // Response はリクエストの中で作る（テスト側で作った Response は Worker のリクエストをまたいで読めない）
    .mockImplementation(async () => Response.json({ success: true }))
  try {
    const res = await exports.default.fetch(
      new Request(`${origin}/api/session`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ token: 'test-token' }),
      }),
    )
    if (res.status !== 200) throw new Error(`session failed: ${res.status} ${await res.text()}`)
    return res.headers.get('Set-Cookie')?.split(';')[0] ?? ''
  } finally {
    spy.mockRestore()
  }
}
