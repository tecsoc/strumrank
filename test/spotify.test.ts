import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '../src/worker/db/client'
import { songs } from '../src/worker/db/schema'
import { type Deps, enrichSong, mergeSong, spotifyTrackUrl } from '../src/worker/musicbrainz'
import { registerSong } from '../src/worker/songs'

const db = createDb(env.DB)
let seq = 0
const uniqueArtist = () => `spotify-artist-${++seq}-${Math.random().toString(36).slice(2, 8)}`
const register = async (title: string, artist: string) =>
  (await registerSong(db, { itunesTrackId: Math.floor(Math.random() * 1e9) + 1, title, artist })).id
const getRow = (id: number) => db.select().from(songs).where(eq(songs.id, id)).get()

const TRACK = '6MCjmGYlw6mQVWRFVgBRvB'

/** recording の lookup で、指定した relations を返す MusicBrainz のモック。lookup の URL も記録する */
function mb(relationsByRecording: Record<string, unknown[]>, lookups: string[] = []): Deps {
  return {
    sleep: async () => {},
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/recording?')) {
        return Response.json({ recordings: Object.keys(relationsByRecording).map((id) => ({ id, score: 100 })) })
      }
      lookups.push(url)
      const id = url.split('/recording/')[1]?.split('?')[0] ?? ''
      return Response.json({ relations: relationsByRecording[id] ?? [] })
    }) as typeof fetch,
  }
}

describe('spotifyTrackUrl: url-rels から Spotify の曲ページを取り出す', () => {
  it.each([
    [`https://open.spotify.com/track/${TRACK}`, `https://open.spotify.com/track/${TRACK}`],
    [`https://open.spotify.com/track/${TRACK}?si=abc`, `https://open.spotify.com/track/${TRACK}`],
    [`https://open.spotify.com/intl-ja/track/${TRACK}`, `https://open.spotify.com/track/${TRACK}`],
  ])('%s → %s', (resource, expected) => {
    expect(spotifyTrackUrl([{ url: { resource } }])).toBe(expected)
  })

  it.each([
    ['アルバムのページ', `https://open.spotify.com/album/${TRACK}`],
    ['ID の長さが違う', 'https://open.spotify.com/track/abc'],
    ['別のドメイン', `https://open.spotify.com.evil.example/track/${TRACK}`],
    ['javascript スキーム', `javascript:alert(1)//open.spotify.com/track/${TRACK}`],
  ])('%s は捨てる', (_label, resource) => {
    expect(spotifyTrackUrl([{ url: { resource } }])).toBeNull()
  })
})

describe('名寄せのついでに Spotify の曲ページを保存する', () => {
  it('work と同じ recording に付いていれば保存し、lookup に url-rels を含める', async () => {
    const id = await register('夜に駆ける', uniqueArtist())
    const lookups: string[] = []
    await enrichSong(
      db,
      id,
      mb(
        { rec1: [{ work: { id: 'w-yoru' } }, { url: { resource: `https://open.spotify.com/track/${TRACK}` } }] },
        lookups,
      ),
    )
    expect((await getRow(id))?.spotifyUrl).toBe(`https://open.spotify.com/track/${TRACK}`)
    expect(lookups[0]).toContain('inc=work-rels+url-rels')
  })

  it('work が無い recording に付いていた Spotify も採用する（問い合わせは増やさない）', async () => {
    const id = await register('ドライフラワー', uniqueArtist())
    const lookups: string[] = []
    await enrichSong(
      db,
      id,
      mb(
        { a: [{ url: { resource: `https://open.spotify.com/track/${TRACK}` } }], b: [{ work: { id: 'w-dry' } }] },
        lookups,
      ),
    )
    expect(lookups).toHaveLength(2)
    expect((await getRow(id))?.spotifyUrl).toBe(`https://open.spotify.com/track/${TRACK}`)
  })

  it('work が見つからなくても Spotify は保存する', async () => {
    const id = await register('未登録の曲', uniqueArtist())
    await enrichSong(db, id, mb({ a: [{ url: { resource: `https://open.spotify.com/track/${TRACK}` } }] }))
    const row = await getRow(id)
    expect(row?.mbStatus).toBe('not_found')
    expect(row?.spotifyUrl).toBe(`https://open.spotify.com/track/${TRACK}`)
  })
})

describe('統合で Spotify の曲ページを引き継ぐ', () => {
  it('統合先に無ければ統合元のものを引き継ぐ', async () => {
    const artist = uniqueArtist()
    const older = await register('蕾', artist)
    const newer = await register('蕾(つぼみ)', artist)
    await db
      .update(songs)
      .set({ spotifyUrl: `https://open.spotify.com/track/${TRACK}` })
      .where(eq(songs.id, newer))
    await mergeSong(db, newer, older)
    expect((await getRow(older))?.spotifyUrl).toBe(`https://open.spotify.com/track/${TRACK}`)
  })

  it('統合先に既にあれば上書きしない', async () => {
    const artist = uniqueArtist()
    const older = await register('糸', artist)
    const newer = await register('糸（独唱）', artist)
    const own = 'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA'
    await db.update(songs).set({ spotifyUrl: own }).where(eq(songs.id, older))
    await db
      .update(songs)
      .set({ spotifyUrl: `https://open.spotify.com/track/${TRACK}` })
      .where(eq(songs.id, newer))
    await mergeSong(db, newer, older)
    expect((await getRow(older))?.spotifyUrl).toBe(own)
  })
})
