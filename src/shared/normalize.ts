// 名寄せキーの生成。シングル/アルバム/ライブ等の録音違いは同じ曲として扱う。
// ここで吸収しきれない表記ゆれは MusicBrainz の work ID で後から統合する。

// 曲名末尾の付記のうち、録音違いを表すものだけを除去する。
// 「さくら(独唱)」の「独唱」のように曲名の一部であるカッコ書きは残す。
// 付記の中にこれらの語が1つでもあれば版の違いとみなす。
const VERSION_WORDS = [
  'live',
  'ver',
  'version',
  'remaster',
  'remastered',
  'rerecording',
  're-recording',
  'remix',
  '\\S+ mix', // 「2019 Mix」「Radio Mix」など。単独の mix は曲名の一部のことがある
  'first take',
  'tv size',
  'tv-size',
  'bonus track',
  'mono',
  'stereo',
  'demo',
]

// from / edit などは曲のサブタイトルにも使われる語なので、付記全体がこの形のときだけ除去する
// （「Dreams (From the Heart)」「Stay (Take Me Home)」は別の曲として残す）
const WHOLE_SUFFIXES = [
  'from\\s+["「『“\'].*', // from 「映画名」
  '(?:radio|single|album|extended)\\s+edit',
]

const versionPattern = VERSION_WORDS.join('|')
const wholePattern = WHOLE_SUFFIXES.join('|')
const BRACKETED_VERSION = new RegExp(`\\s*[(\\[][^()\\[\\]]*\\b(?:${versionPattern})\\b[^()\\[\\]]*[)\\]]\\s*$`, 'i')
const DASHED_VERSION = new RegExp(`\\s+-\\s+[^-]*\\b(?:${versionPattern})\\b.*$`, 'i')
const BRACKETED_WHOLE = new RegExp(`\\s*[(\\[]\\s*(?:${wholePattern})\\s*[)\\]]\\s*$`, 'i')
const DASHED_WHOLE = new RegExp(`\\s+-\\s+(?:${wholePattern})\\s*$`, 'i')
// 空白かカッコの直後の feat./ft. だけを除く。「FT Island」のような名前の先頭は対象外
const FEATURING = /(?:\s+|\s*[([]\s*)(?:feat|ft|featuring)\b\.?.*$/i

// 候補から除外する録音（ボーカルなし・カラオケ）。統合ではなく除外する。
const EXCLUDED = /\b(?:instrumental|inst\.?|off\s*vocal|karaoke)\b|カラオケ|ガイド(?:無し|なし)|原曲歌手/i

function base(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function stripFeaturing(s: string): string {
  const m = FEATURING.exec(s)
  return m && m.index > 0 ? s.slice(0, m.index) : s
}

function compact(s: string, fallback: string): string {
  const out = s.replace(/\s+/g, '')
  // 除去しすぎて空になった場合は元の表記で比べる
  return out.length > 0 ? out : fallback.replace(/\s+/g, '')
}

export function normalizeTitle(title: string): string {
  const original = base(title)
  let s = stripFeaturing(original)
  // 「(Live) - Remastered」のように付記が重なる場合に備えて繰り返す
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s
      .replace(BRACKETED_VERSION, '')
      .replace(DASHED_VERSION, '')
      .replace(BRACKETED_WHOLE, '')
      .replace(DASHED_WHOLE, '')
      .trim()
  }
  return compact(s, original)
}

export function normalizeArtist(artist: string): string {
  // 「藤井 風」と「藤井風」を同一視するため空白はすべて除く
  const original = base(artist)
  return compact(stripFeaturing(original), original)
}

export function isExcludedRecording(title: string): boolean {
  return EXCLUDED.test(base(title))
}
