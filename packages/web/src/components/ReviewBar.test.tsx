import { render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { ReviewBar } from "./ReviewBar.js"

const bar = (count: number, starting = false) =>
  render(<ReviewBar count={count} starting={starting} onStart={vi.fn()} onClear={vi.fn()} />)

/** The bar's first line: "N selected". */
const summary = (): string =>
  screen.getByRole("region", { name: "Selected sessions" }).querySelector("p")?.textContent ?? ""

const startButton = () => screen.getByRole("button", { name: "Review" })

test("SC19: with nothing picked the bar reads 0 selected and its button is off", () => {
  bar(0)
  expect(summary()).toBe("0 selected")
  expect(startButton()).toBeDisabled()
})

test("SC23: the bar shows no time estimate and one Review button", () => {
  bar(4)
  expect(summary()).toBe("4 selected")
  expect(screen.queryByText(/about .* min/)).toBeNull()
  expect(startButton()).toBeEnabled()
})

test("SC19: while a start request is in flight the button is off", () => {
  bar(2, true)
  expect(startButton()).toBeDisabled()
})
