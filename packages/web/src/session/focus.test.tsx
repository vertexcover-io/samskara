import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test } from "vitest"
import { useFocusMode } from "./focus.js"

const Harness = () => {
  const focus = useFocusMode()

  return (
    <div>
      {["a1", "a2"].map((id) => (
        <button
          key={id}
          type="button"
          aria-expanded={focus.focusedId === id}
          onClick={(event) => focus.open(id, event.currentTarget)}
        >
          Open {id}
        </button>
      ))}
      <output>{focus.focusedId ?? "none"}</output>
      <button type="button" onClick={focus.exit}>
        Return to spine
      </button>
    </div>
  )
}

test("S43: Escape while a branch is open returns focus to the trigger that opened it - not to the document body", async () => {
  const user = userEvent.setup()
  render(<Harness />)

  const trigger = screen.getByRole("button", { name: "Open a2" })
  await user.click(trigger)

  expect(screen.getByRole("status")).toHaveTextContent("a2")
  expect(trigger).toHaveAttribute("aria-expanded", "true")

  act(() => screen.getByRole("button", { name: "Return to spine" }).focus())
  await user.keyboard("{Escape}")

  expect(screen.getByRole("status")).toHaveTextContent("none")
  expect(document.activeElement).toBe(trigger)
})

test("S43: exiting via the return control restores focus to the opening trigger, and Escape with nothing open is inert", async () => {
  const user = userEvent.setup()
  render(<Harness />)

  await user.keyboard("{Escape}")
  expect(screen.getByRole("status")).toHaveTextContent("none")

  const trigger = screen.getByRole("button", { name: "Open a1" })
  await user.click(trigger)
  act(() => document.body.focus())

  await user.click(screen.getByRole("button", { name: "Return to spine" }))

  expect(screen.getByRole("status")).toHaveTextContent("none")
  expect(document.activeElement).toBe(trigger)
})

test("S43: opening a second branch while one is open switches to it and restores to the newest trigger on exit", async () => {
  const user = userEvent.setup()
  render(<Harness />)

  await user.click(screen.getByRole("button", { name: "Open a1" }))
  const second = screen.getByRole("button", { name: "Open a2" })
  await user.click(second)

  expect(screen.getByRole("status")).toHaveTextContent("a2")

  await user.keyboard("{Escape}")

  expect(document.activeElement).toBe(second)
})
