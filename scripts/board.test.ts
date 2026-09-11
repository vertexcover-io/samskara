import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The mission-control board contract: writeup/self-learning/board.csv is the source of
 * truth for the work checklist, and the mission-control page renders it one row per line.
 * This test is what makes "1-1 mapped" a checked fact instead of a hope — a row edited in
 * the CSV without the page following (or vice versa) fails here.
 */

const ROOT = join(import.meta.dir, "..")
const CSV_PATH = join(ROOT, "writeup/self-learning/board.csv")
const PAGE_PATH = join(ROOT, "writeup/self-learning/mission-control.html")

const ALLOWED_STATUSES = new Set(["todo", "doing", "done", "blocked"])
const TAG_BY_STATUS: Record<string, string> = {
  done: "built",
  doing: "blue",
  todo: "planned",
  blocked: "blocked",
}

type BoardRow = {
  readonly id: string
  readonly initiative: string
  readonly item: string
  readonly status: string
  readonly note: string
}

/** Minimal quoted-CSV parser: fields may be double-quoted, quotes doubled inside. */
const parseCsv = (text: string): ReadonlyArray<BoardRow> => {
  const lines = text.trim().split("\n")
  const header = lines[0].split(",")
  const rows: BoardRow[] = []
  for (const line of lines.slice(1)) {
    const fields: string[] = []
    let field = ""
    let inQuotes = false
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = !inQuotes
      } else if (char === "," && !inQuotes) {
        fields.push(field)
        field = ""
      } else field += char
    }
    fields.push(field)
    const record: Record<string, string> = {}
    header.forEach((key, index) => {
      record[key] = fields[index] ?? ""
    })
    rows.push(record as unknown as BoardRow)
  }
  return rows
}

describe("mission-control board", () => {
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8"))
  const page = readFileSync(PAGE_PATH, "utf8")

  test("every CSV row is unique and carries an allowed status", () => {
    const ids = rows.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const row of rows) {
      expect(ALLOWED_STATUSES.has(row.status)).toBe(true)
      expect(row.item.length).toBeGreaterThan(0)
      expect(row.note.length).toBeGreaterThan(0)
    }
  })

  test("every CSV row renders on the page exactly once with a matching status", () => {
    for (const row of rows) {
      const matches = page.match(new RegExp(`data-board-id="${row.id}"`, "g")) ?? []
      expect(matches.length).toBe(1)
      const rowHtml = page.slice(page.indexOf(`data-board-id="${row.id}"`))
      const statusAttr = rowHtml.slice(0, rowHtml.indexOf(">"))
      expect(statusAttr).toContain(`data-board-status="${row.status}"`)
      const rendered = rowHtml.slice(0, rowHtml.indexOf("</div>"))
      expect(rendered).toContain(row.item)
      expect(rendered).toContain(TAG_BY_STATUS[row.status])
    }
  })

  test("the page renders no board row the CSV does not know", () => {
    const renderedIds = [...page.matchAll(/data-board-id="([^"]+)"/g)].map((m) => m[1])
    const csvIds = new Set(rows.map((row) => row.id))
    for (const id of renderedIds) expect(csvIds.has(id)).toBe(true)
    expect(renderedIds.length).toBe(rows.length)
  })
})
