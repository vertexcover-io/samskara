export type ServeHeaders = {
  readonly contentType: string
  readonly disposition: "inline" | "attachment"
}

const TEXT_PLAIN = "text/plain; charset=utf-8"
const TEXT_HTML = "text/html; charset=utf-8"
const OCTET_STREAM = "application/octet-stream"

const startsWith = (bytes: Buffer, signature: ReadonlyArray<number>): boolean =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)

const ascii = (text: string): ReadonlyArray<number> => [...text].map((c) => c.charCodeAt(0))

type Sniffer = {
  readonly contentType: string
  readonly matches: (bytes: Buffer) => boolean
}

/**
 * A fixed allow-list of formats a browser renders without executing script. Anything not on it is
 * an attachment: sniffing is here to *narrow* what may be displayed inline, never to widen it.
 */
const INERT: ReadonlyArray<Sniffer> = [
  { contentType: "image/png", matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  { contentType: "image/jpeg", matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { contentType: "image/gif", matches: (b) => startsWith(b, ascii("GIF8")) },
  {
    contentType: "image/webp",
    // The `WEBP` form at offset 8 is what distinguishes a WebP from any other RIFF container.
    matches: (b) => startsWith(b, ascii("RIFF")) && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  { contentType: "video/mp4", matches: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" },
]

/**
 * Detected by content rather than by the claimed mime type, so an SVG renders as the page it is
 * however it was uploaded -- including base64, which arrives flagged binary.
 */
const MARKUP =
  /^\s*(?:<\?xml[^>]*\?>\s*(?:<!--[\s\S]*?-->\s*)*)?(?:<!doctype\s+html|<html\b|<svg\b)/i

const isMarkup = (bytes: Buffer): boolean => MARKUP.test(bytes.subarray(0, 512).toString("utf8"))

export const serveHeadersFor = (bytes: Buffer, isBinary: boolean): ServeHeaders => {
  if (isMarkup(bytes)) return { contentType: TEXT_HTML, disposition: "inline" }

  if (!isBinary) return { contentType: TEXT_PLAIN, disposition: "attachment" }

  const inert = INERT.find((sniffer) => sniffer.matches(bytes))
  if (inert) return { contentType: inert.contentType, disposition: "inline" }

  return { contentType: OCTET_STREAM, disposition: "attachment" }
}
