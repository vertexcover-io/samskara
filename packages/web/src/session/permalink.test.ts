import { expect, test } from "vitest"
import { messageLink } from "./permalink.js"

test("S61: a permalink carries the view the reader is in, so the tab and the inline-tools flag survive the share", () => {
  const params = new URLSearchParams({ tab: "conversation", tools: "1" })

  expect(messageLink("https://samskara.test", "/sessions/s-1", params, "m-9")).toBe(
    "https://samskara.test/sessions/s-1?tab=conversation&tools=1&m=m-9",
  )
})

test("S62: copying a second link replaces the message already targeted rather than appending a rival one", () => {
  const params = new URLSearchParams({ m: "m-1" })

  expect(messageLink("https://samskara.test", "/sessions/s-1", params, "m-9")).toBe(
    "https://samskara.test/sessions/s-1?m=m-9",
  )
})
