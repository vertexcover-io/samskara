export type ServeHeaders = {
  readonly contentType: string
  readonly disposition: "inline" | "attachment"
  readonly csp?: string
}

/**
 * `allow-scripts` without `allow-same-origin` puts the document in an opaque origin: scripts run,
 * so an agent-authored diagram still renders, but the document has no cookies, no localStorage, no
 * `parent`, and no same-origin API access. Granting `allow-same-origin` alongside it would cancel
 * the sandbox outright -- a script inside could strip its own sandbox and reload with full origin
 * access -- so the two must never appear together here or in any iframe rendering this response.
 *
 * Sent as a response header rather than an iframe attribute so it also applies to direct navigation
 * to the raw URL, where no iframe exists. `default-src 'none'` stops the page beaconing data out.
 */
/**
 * `mediaOrigin` widens `img-src`/`media-src` to exactly one origin -- ours -- so a captured report
 * can display the screenshots and recordings it references. `'self'` cannot do this: the document
 * sits in an opaque origin, where `'self'` matches nothing.
 *
 * Naming our own origin rather than `https:` is what keeps it a widening and not a hole. The page
 * gains the ability to issue credential-less GETs to this API and nowhere else, so it cannot beacon
 * to an attacker's server, and the responses it provokes are 401s it is not permitted to read --
 * `connect-src` still falls through to `default-src 'none'`.
 */
const sandboxCsp = (mediaOrigins: ReadonlyArray<string> = []): string => {
  const media = mediaOrigins.length === 0 ? "" : ` ${mediaOrigins.join(" ")}`
  return (
    `sandbox allow-scripts; default-src 'none'; img-src${media} data: blob:; ` +
    `media-src${media || " 'none'"}; style-src 'unsafe-inline'; script-src 'unsafe-inline'`
  )
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
 * Detected by content rather than by the claimed mime type: SVG can carry `<script>`, so it must
 * take the sandbox path however it was uploaded -- including base64, which arrives flagged binary.
 */
const MARKUP =
  /^\s*(?:<\?xml[^>]*\?>\s*(?:<!--[\s\S]*?-->\s*)*)?(?:<!doctype\s+html|<html\b|<svg\b)/i

const isMarkup = (bytes: Buffer): boolean => MARKUP.test(bytes.subarray(0, 512).toString("utf8"))

export const serveHeadersFor = (
  bytes: Buffer,
  isBinary: boolean,
  mediaOrigins?: ReadonlyArray<string>,
): ServeHeaders => {
  if (isMarkup(bytes)) {
    return { contentType: TEXT_HTML, disposition: "inline", csp: sandboxCsp(mediaOrigins) }
  }

  if (!isBinary) return { contentType: TEXT_PLAIN, disposition: "attachment" }

  const inert = INERT.find((sniffer) => sniffer.matches(bytes))
  if (inert) return { contentType: inert.contentType, disposition: "inline" }

  return { contentType: OCTET_STREAM, disposition: "attachment" }
}
