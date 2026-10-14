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

const utf8 = (text: string): Buffer => Buffer.from(text, "utf8")

const HTML = "text/html; charset=utf-8"
const TEXT = "text/plain; charset=utf-8"
const OCTET = "application/octet-stream"

describe("serveHeadersFor", () => {
  test.each([
    [
      "S42: plain text, whatever the upload claimed",
      utf8("console.log('hi')\n"),
      false,
      "",
      TEXT,
      "attachment",
    ],
    [
      "S42: binary bytes matching no inert signature",
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]),
      true,
      "",
      OCTET,
      "attachment",
    ],
    [
      "S42: text that merely mentions html",
      utf8("This document explains <html> tags in prose.\n"),
      false,
      "",
      TEXT,
      "attachment",
    ],
    ["S43: a PNG signature", PNG_MAGIC, true, "", "image/png", "inline"],
    ["S43: a JPEG signature", JPEG_MAGIC, true, "", "image/jpeg", "inline"],
    ["S43: a GIF signature", GIF_MAGIC, true, "", "image/gif", "inline"],
    ["S43: a WebP signature", riff("WEBP"), true, "", "image/webp", "inline"],
    ["S43: an MP4 signature", mp4(), true, "", "video/mp4", "inline"],
    // `RIFF....WAVE` shares its first four bytes with WebP; matching on those alone would
    // serve an arbitrary WAV -- or a crafted RIFF -- as image/webp.
    ["S43: a RIFF container that is not WebP", riff("WAVE"), true, "", OCTET, "attachment"],
    [
      "S44: HTML, script body unmodified",
      utf8("<!doctype html><html><body><script>alert(1)</script></body></html>"),
      false,
      "",
      HTML,
      "inline",
    ],
    [
      "S45: SVG, which takes the markup path rather than the image one",
      utf8('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      false,
      "",
      HTML,
      "inline",
    ],
    [
      "S45: an XML-prologued SVG, detected by content",
      utf8('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
      false,
      "",
      HTML,
      "inline",
    ],
    // isBinary is derived from the upload's encoding, so an SVG sent base64 arrives flagged
    // binary. It must not reach the sniffed image allow-list on that basis.
    [
      "S45: an SVG flagged binary",
      utf8('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      true,
      "",
      HTML,
      "inline",
    ],
    [
      "S46: an html fragment with no doctype whose path says html",
      utf8('<title>Artifact Diff Capture</title>\n<link rel="stylesheet">'),
      false,
      "scratchpad/pr37-review.html",
      HTML,
      "inline",
    ],
    ["S46: an upper-case .HTM path", utf8("<div/>"), false, "a/REPORT.HTM", HTML, "inline"],
    ["S46: an .svg path", utf8("<g/>"), false, "chart.svg", HTML, "inline"],
    [
      "S46: a non-markup extension",
      utf8("<title>hi</title>"),
      false,
      "notes.txt",
      TEXT,
      "attachment",
    ],
    [
      "S46: a png named .html, still sniffed as an image",
      PNG_MAGIC,
      true,
      "sneaky.html",
      "image/png",
      "inline",
    ],
  ])(
    "%s gets the expected content type and disposition",
    (_case, bytes, isBinary, path, contentType, disposition) => {
      expect(serveHeadersFor(bytes, isBinary, path)).toEqual({ contentType, disposition })
    },
  )
})
