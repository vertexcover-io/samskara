import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test, vi } from "vitest"
import { TextField } from "./TextField.js"

test("the label names the input, so a reader finds it by its label alone", () => {
  render(<TextField label="Project" value="" onChange={() => {}} />)

  expect(screen.getByRole("textbox", { name: "Project" })).toBeInTheDocument()
})

test("every keystroke reports the full value, so a caller can narrow as the reader types", async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()

  render(<TextField label="User" value="" onChange={onChange} />)
  await user.type(screen.getByRole("textbox", { name: "User" }), "ab")

  expect(onChange).toHaveBeenCalledTimes(2)
  expect(onChange).toHaveBeenNthCalledWith(1, "a")
})

test("the trailing slot renders beside the input", () => {
  render(
    <TextField
      label="PR number"
      value=""
      onChange={() => {}}
      trailing={<button type="submit">Apply</button>}
    />,
  )

  expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument()
})

test("a hint is announced to a screen reader and linked to the input", () => {
  render(<TextField label="Commit SHA" value="" onChange={() => {}} hint="Use a full SHA." />)

  const input = screen.getByRole("textbox", { name: "Commit SHA" })
  const hintId = input.getAttribute("aria-describedby")
  expect(hintId).not.toBeNull()
  expect(document.getElementById(hintId ?? "")).toHaveTextContent("Use a full SHA.")
})

test("without a hint the input carries no dangling description", () => {
  render(<TextField label="User" value="" onChange={() => {}} />)

  expect(screen.getByRole("textbox", { name: "User" })).not.toHaveAttribute("aria-describedby")
})
