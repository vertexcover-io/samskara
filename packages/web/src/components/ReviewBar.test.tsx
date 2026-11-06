import { render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { ReviewBar } from "./ReviewBar.js"

const bar = (count: number, blocked = false) =>
  render(
    <ReviewBar
      count={count}
      starting={false}
      blocked={blocked}
      onStart={vi.fn()}
      onClear={vi.fn()}
    />,
  )

/** The bar's first line: "N selected", plus "· about X min" once something is picked. */
const summary = (): string =>
  screen.getByRole("region", { name: "Selected sessions" }).querySelector("p")?.textContent ?? ""

const startButton = () => screen.getByRole("button", { name: "Review and find fixes" })

test("SC19: with nothing picked the bar reads 0 selected, shows no estimate and its button is off", () => {
  bar(0)
  expect(summary()).toBe("0 selected")
  expect(startButton()).toBeDisabled()
})

test("SC19: with 2 picked the bar reads 2 selected and about 7 min, and its button is on", () => {
  bar(2)
  expect(summary()).toBe("2 selected · about 7 min")
  expect(startButton()).toBeEnabled()
})

test("SC19: while the previous batch runs the button is off", () => {
  bar(2, true)
  expect(startButton()).toBeDisabled()
})
