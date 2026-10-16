export function Artwork({ url, size = 48 }: { url: string | null | undefined; size?: number }) {
  return url ? (
    <img src={url} alt="" width={size} height={size} loading="lazy" className="shrink-0 rounded-[3px] bg-line" />
  ) : (
    <span style={{ width: size, height: size }} className="block shrink-0 rounded-[3px] bg-line" />
  )
}
