import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test, vi } from "vitest"
import { Fold, isLong } from "./Fold.js"

const lines = (count: number): string => Array.from({ length: count }, () => "a line").join("\n")

test.each([
  { label: "30 lines", text: lines(30), expected: false },
  { label: "31 lines", text: lines(31), expected: true },
  { label: "2500 characters on one line", text: "x".repeat(2500), expected: false },
  { label: "2501 characters on one line", text: "x".repeat(2501), expected: true },
  { label: "an empty string", text: "", expected: false },
])("SC1: $label counts as long: $expected", ({ text, expected }) => {
  expect(isLong(text)).toBe(expected)
})

test("SC2: a long body starts open with two collapse buttons, folds to one expand button with the text still there, and reopens", async () => {
  const user = userEvent.setup()
  render(
    <Fold long linked={false} anchor="m-1">
      <p>the body text</p>
    </Fold>,
  )

  const collapse = screen.getAllByRole("button", { name: "Collapse message" })
  expect(collapse).toHaveLength(2)
  for (const button of collapse) expect(button).toHaveAttribute("aria-expanded", "true")

  const [top] = collapse
  if (top === undefined) throw new Error("no collapse button")
  await user.click(top)
  const expand = screen.getByRole("button", { name: "Show full message" })
  expect(expand).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByRole("button", { name: "Collapse message" })).toBeNull()
  expect(screen.getByText("the body text")).toBeInTheDocument()

  await user.click(expand)
  expect(screen.getAllByRole("button", { name: "Collapse message" })).toHaveLength(2)
})

test("SC3: a short body renders its children and no toggle", () => {
  render(
    <Fold long={false} linked={false} anchor="m-1">
      <p>short</p>
    </Fold>,
  )

  expect(screen.getByText("short")).toBeInTheDocument()
  expect(screen.queryByRole("button")).toBeNull()
})

test("SC4: collapsing scrolls the anchor element to the nearest edge once, and expanding does not scroll", async () => {
  const user = userEvent.setup()
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
  render(
    <article id="m-7">
      <Fold long linked={false} anchor="m-7">
        <p>the body text</p>
      </Fold>
    </article>,
  )

  const [, bottom] = screen.getAllByRole("button", { name: "Collapse message" })
  if (bottom === undefined) throw new Error("no bottom collapse button")
  await user.click(bottom)
  expect(scroll).toHaveBeenCalledTimes(1)
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" })
  expect(scroll.mock.contexts[0]).toBe(document.getElementById("m-7"))

  await user.click(screen.getByRole("button", { name: "Show full message" }))
  expect(scroll).toHaveBeenCalledTimes(1)
  scroll.mockRestore()
})

test("SC5: a collapsed message reopens when it becomes the linked one", async () => {
  const user = userEvent.setup()
  const body = (linked: boolean) => (
    <Fold long linked={linked} anchor="m-1">
      <p>the body text</p>
    </Fold>
  )
  const { rerender } = render(body(false))
  const [top] = screen.getAllByRole("button", { name: "Collapse message" })
  if (top === undefined) throw new Error("no collapse button")
  await user.click(top)
  expect(screen.getByRole("button", { name: "Show full message" })).toBeInTheDocument()

  rerender(body(true))
  expect(screen.getAllByRole("button", { name: "Collapse message" })).toHaveLength(2)
})

test("collapsing from the top button with the keyboard moves focus to the Show full message button, not the page body", async () => {
  const user = userEvent.setup()
  render(
    <Fold long linked={false} anchor="m-1">
      <p>the body text</p>
    </Fold>,
  )

  const [top] = screen.getAllByRole("button", { name: "Collapse message" })
  if (top === undefined) throw new Error("no collapse button")
  top.focus()
  await user.keyboard("{Enter}")

  expect(screen.getByRole("button", { name: "Show full message" })).toHaveFocus()
})

test("a collapsed body is inert, so Tab cannot reach a link clipped out of view, and reopening makes it reachable again", async () => {
  const user = userEvent.setup()
  render(
    <Fold long linked={false} anchor="m-1">
      <a href="#below">a link below the clip</a>
    </Fold>,
  )

  const [top] = screen.getAllByRole("button", { name: "Collapse message" })
  if (top === undefined) throw new Error("no collapse button")
  await user.click(top)
  const expand = screen.getByRole("button", { name: "Show full message" })
  const body = document.getElementById(expand.getAttribute("aria-controls") ?? "")
  expect(body).toHaveAttribute("inert")
  expect(screen.getByText("a link below the clip")).toBeInTheDocument()

  await user.click(expand)
  expect(body).not.toHaveAttribute("inert")
})
