// 外部サービスへの検索リンク。歌詞・コード譜の本文は自サイトに載せず、リンクだけにする。

export function spotifySearchUrl(title: string, artist: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(`${title} ${artist}`)}`
}

export function ufretSearchUrl(title: string): string {
  return `https://www.ufret.jp/search.php?key=${encodeURIComponent(title)}`
}

/** 楽譜サイトを横断して探せるよう、Google の検索結果へリンクする */
export function googleScoreSearchUrl(title: string, artist: string): string {
  return `https://www.google.com/search?${new URLSearchParams({ q: `${title} ${artist} 弾き語り 楽譜` })}`
}
