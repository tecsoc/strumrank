// データセンター・VPN 事業者の ASN 一覧から src/worker/asn-list.ts を生成する。
// 使い方: node scripts/gen-asn-list.mjs [コミットSHA]
// 出典: https://github.com/bountyyfi/bad-asn-list （README に MIT と明記）
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = 'bountyyfi/bad-asn-list'
const ref = process.argv[2] ?? 'main'
const url = `https://raw.githubusercontent.com/${REPO}/${ref}/all.txt`

const res = await fetch(url)
if (!res.ok) throw new Error(`取得に失敗しました: ${res.status} ${url}`)
const text = await res.text()

// 1行1件「AS12345 組織名」。この形でない行は使わない
const asns = new Set()
let skipped = 0
for (const line of text.split(/\r?\n/)) {
  const m = /^AS(\d{1,10})(?:\s|$)/.exec(line.trim())
  if (!m) {
    if (line.trim()) skipped++
    continue
  }
  const n = Number(m[1])
  if (Number.isSafeInteger(n) && n > 0 && n <= 4294967295) asns.add(n)
}
if (asns.size < 100) throw new Error(`件数が少なすぎます（${asns.size}件）。取得内容を確認してください`)

const sorted = [...asns].sort((a, b) => a - b)
const lines = []
for (let i = 0; i < sorted.length; i += 12) lines.push(`  ${sorted.slice(i, i + 12).join(', ')},`)

const out = `// このファイルは scripts/gen-asn-list.mjs で生成する。手で編集しない。
// 出典: https://github.com/${REPO} （${ref}、MIT License）
// データセンター・VPN・ホスティング事業者の ASN（${sorted.length}件）。
// 遮断には使わず、投票の前に Turnstile の再確認を求める判定にだけ使う。
export const DATACENTER_ASNS: ReadonlySet<number> = new Set([
${lines.join('\n')}
])
`
const dest = fileURLToPath(new URL('../src/worker/asn-list.ts', import.meta.url))
writeFileSync(dest, out)
console.log(`${sorted.length}件を書き出しました（形式外の行 ${skipped}件は除外）: ${dest}`)
