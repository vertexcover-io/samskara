import { describe, expect, test } from "vitest"
import { serveHeadersFor } from "./artifact-serving.js"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF_MAGIC = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(2, 0x20)])

const riff = (fourCc: string): Buffer =>
  Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from(fourCc, "latin1"),
  ])

const mp4 = (): Buffer =>
  Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypisom", "latin1")])

describe("serveHeadersFor", () => {
  test("S42: plain text is served as text/plain regardless of what the upload claimed", () => {
    const headers = serveHeadersFor(Buffer.from("console.log('hi')\n", "utf8"), false)

    expect(headers.contentType).toBe("text/plain; charset=utf-8")
  })

  test("S42: binary bytes matching no inert signature fall through to an octet-stream attachment", () => {
    const headers = serveHeadersFor(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), true)

    expect(headers.contentType).toBe("application/octet-stream")
    expect(headers.disposition).toBe("attachment")
  })

  test("S43: a PNG signature is sniffed and served inline as image/png", () => {
    const headers = serveHeadersFor(PNG_MAGIC, true)

    expect(headers.contentType).toBe("image/png")
    expect(headers.disposition).toBe("inline")
  })

  test("S43: JPEG, GIF, WebP, and MP4 signatures each serve inline as their sniffed type", () => {
    expect(serveHeadersFor(JPEG_MAGIC, true)).toMatchObject({
      contentType: "image/jpeg",
      disposition: "inline",
    })
    expect(serveHeadersFor(GIF_MAGIC, true)).toMatchObject({
      contentType: "image/gif",
      disposition: "inline",
    })
    expect(serveHeadersFor(riff("WEBP"), true)).toMatchObject({
      contentType: "image/webp",
      disposition: "inline",
    })
    expect(serveHeadersFor(mp4(), true)).toMatchObject({
      contentType: "video/mp4",
      disposition: "inline",
    })
  })

  test("S43: a RIFF container that is not WebP is not served as an image", () => {
    // `RIFF....WAVE` shares its first four bytes with WebP; matching on those alone would
    // serve an arbitrary WAV -- or a crafted RIFF -- as image/webp.
    expect(serveHeadersFor(riff("WAVE"), true).contentType).toBe("application/octet-stream")
  })

  test("S44: HTML is served inline as text/html with its script body unmodified", () => {
    const headers = serveHeadersFor(
      Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>", "utf8"),
      false,
    )

    expect(headers.contentType).toBe("text/html; charset=utf-8")
    expect(headers.disposition).toBe("inline")
  })

  test("S45: SVG takes the markup path rather than being served as an image", () => {
    const headers = serveHeadersFor(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        "utf8",
      ),
      false,
    )

    expect(headers.contentType).not.toContain("svg")
    expect(headers.contentType).toBe("text/html; charset=utf-8")
  })

  test("S45: an XML-prologued SVG is detected by content, not by its declaration", () => {
    const headers = serveHeadersFor(
      Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8"),
      false,
    )

    expect(headers.contentType).toBe("text/html; charset=utf-8")
  })

  test("S45: bytes flagged binary that begin with <svg still take the markup path", () => {
    // isBinary is derived from the upload's encoding, so an SVG sent base64 arrives flagged
    // binary. It must not reach the sniffed image allow-list on that basis.
    const headers = serveHeadersFor(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', "utf8"),
      true,
    )

    expect(headers.contentType).toBe("text/html; charset=utf-8")
  })

  test("S42: text that merely mentions html is not promoted to the HTML path", () => {
    const headers = serveHeadersFor(
      Buffer.from("This document explains <html> tags in prose.\n", "utf8"),
      false,
    )

    expect(headers.contentType).toBe("text/plain; charset=utf-8")
    expect(headers.disposition).toBe("attachment")
  })
})

describe("serveHeadersFor path-named markup", () => {
  test("S46: an html fragment with no doctype is served inline as html when its path says html", () => {
    const headers = serveHeadersFor(
      Buffer.from('<title>Artifact Diff Capture</title>\n<link rel="stylesheet">', "utf8"),
      false,
      "scratchpad/pr37-review.html",
    )

    expect(headers.contentType).toBe("text/html; charset=utf-8")
    expect(headers.disposition).toBe("inline")
  })

  test("S46: .htm and .svg are markup by name too, whatever case the path uses", () => {
    expect(serveHeadersFor(Buffer.from("<div/>", "utf8"), false, "a/REPORT.HTM")).toMatchObject({
      contentType: "text/html; charset=utf-8",
      disposition: "inline",
    })
    expect(serveHeadersFor(Buffer.from("<g/>", "utf8"), false, "chart.svg")).toMatchObject({
      contentType: "text/html; charset=utf-8",
      disposition: "inline",
    })
  })

  test("S46: a non-markup extension keeps the plain-text attachment path", () => {
    const headers = serveHeadersFor(Buffer.from("<title>hi</title>", "utf8"), false, "notes.txt")

    expect(headers.contentType).toBe("text/plain; charset=utf-8")
    expect(headers.disposition).toBe("attachment")
  })

  test("S46: a png named .html is still sniffed as an image, not framed as markup", () => {
    const headers = serveHeadersFor(PNG_MAGIC, true, "sneaky.html")

    expect(headers.contentType).toBe("image/png")
    expect(headers.disposition).toBe("inline")
  })
})
