import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '../src/worker/db/client'
import { songs } from '../src/worker/db/schema'
import { suggestSongs } from '../src/worker/search'

const db = createDb(env.DB)
let seq = 0
/** テスト間で衝突しないよう、アーティスト名に連番を付ける（保存時の正規化済みの形で入れる） */
async function addSong(title: string, titleNorm: string, artistBase: string) {
  const artist = `${artistBase}${++seq}x${Math.random().toString(36).slice(2, 6)}`
  const [row] = await db
    .insert(songs)
    .values({ title, titleNorm, artist, artistNorm: artist.toLowerCase().replace(/\s+/g, '') })
    .returning({ id: songs.id, artistNorm: songs.artistNorm })
  if (!row) throw new Error('insert failed')
  return row
}
const ids = async (q: string) => (await suggestSongs(db, q)).map((s) => s.id)

describe('入力補完（登録済みの曲）', () => {
  it('1文字の曲名でも見つかる', async () => {
    const song = await addSong('糸', '糸', '中島みゆき')
    expect(await ids('糸')).toContain(song.id)
  })

  it('3文字以上は曲名・アーティスト名の部分一致で見つかる', async () => {
    const song = await addSong('死ぬのがいいわ', '死ぬのがいいわ', '藤井風')
    expect(await ids('のがいい')).toContain(song.id)
    expect(await ids(song.artistNorm.slice(0, 4))).toContain(song.id)
  })

  it('「アーティスト 曲名」「曲名 アーティスト」の順、空白なしで続けて打っても見つかる', async () => {
    const song = await addSong('マリーゴールド', 'マリーゴールド', 'あいみょん')
    expect(await ids(`${song.artistNorm} マリーゴ`)).toContain(song.id)
    expect(await ids(`マリーゴ ${song.artistNorm}`)).toContain(song.id)
    expect(await ids(`${song.artistNorm}マリーゴ`)).toContain(song.id)
  })

  it('短い語と長い語を組み合わせて絞り込める', async () => {
    const song = await addSong('蕾', '蕾', 'コブクロ')
    const other = await addSong('桜', '桜', 'コブクロ')
    const found = await ids(`蕾 ${song.artistNorm}`)
    expect(found).toContain(song.id)
    expect(found).not.toContain(other.id)
  })

  it('全角・大文字の違いを吸収する', async () => {
    const song = await addSong('Mela!', 'mela!', '緑黄色社会')
    expect(await ids('ＭＥＬＡ')).toContain(song.id)
  })

  it('% や _ はワイルドカードにならない', async () => {
    const song = await addSong('Mela!', 'mela!', '緑黄色社会')
    expect(await ids('%')).not.toContain(song.id)
    expect(await ids('_')).not.toContain(song.id)
    expect(await ids('"%"')).not.toContain(song.id)
  })

  it('統合済みの曲は出さない', async () => {
    const target = await addSong('白日', '白日', 'kinggnu')
    const merged = await addSong('白日 (Live)', '白日', 'kinggnu')
    await db.update(songs).set({ mergedInto: target.id }).where(eq(songs.id, merged.id))
    expect(await ids('白日')).not.toContain(merged.id)
  })
})
