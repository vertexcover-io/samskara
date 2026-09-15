import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test, vi } from "vitest"
import { TagAdd } from "./TagAdd.js"

const OPTIONS = ["harness", "demo", "spike"]

const input = (): HTMLInputElement => {
  const element = screen.getByRole("combobox", { name: "Add a tag" })
  if (!(element instanceof HTMLInputElement)) throw new Error("Add a tag is not a typeahead")
  return element
}

const open = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Add tag" }))
  return input()
}

test("ST9: the + opens suggestions of known tags, minus the ones already applied", async () => {
  render(<TagAdd selected={["harness"]} options={OPTIONS} onAdd={vi.fn()} />)

  await open()

  expect(screen.queryByRole("option", { name: "harness" })).toBeNull()
  expect(screen.getByRole("option", { name: "demo" })).toBeInTheDocument()
  expect(screen.getByRole("option", { name: "spike" })).toBeInTheDocument()
})

test("ST9: pressing Enter adds the typed tag and clears the box", async () => {
  const onAdd = vi.fn()
  render(<TagAdd selected={[]} options={OPTIONS} onAdd={onAdd} />)

  await open()
  await userEvent.type(input(), "NewTag{Enter}")

  expect(onAdd).toHaveBeenCalledWith("newtag")
  expect(input().value).toBe("")
})

test("ST9: clicking a suggestion adds it", async () => {
  const onAdd = vi.fn()
  render(<TagAdd selected={[]} options={OPTIONS} onAdd={onAdd} />)

  await open()
  await userEvent.click(screen.getByRole("option", { name: "demo" }))

  expect(onAdd).toHaveBeenCalledWith("demo")
})

test("ST9: an already-applied tag is not added again", async () => {
  const onAdd = vi.fn()
  render(<TagAdd selected={["harness"]} options={OPTIONS} onAdd={onAdd} />)

  await open()
  await userEvent.type(input(), "harness{Enter}")

  expect(onAdd).not.toHaveBeenCalled()
})

test("ST9: an invalid tag is not added", async () => {
  const onAdd = vi.fn()
  render(<TagAdd selected={[]} options={OPTIONS} onAdd={onAdd} />)

  await open()
  await userEvent.type(input(), "has space{Enter}")

  expect(onAdd).not.toHaveBeenCalled()
})

test("ST9: Escape closes the editor and returns focus to the add pill", async () => {
  render(<TagAdd selected={[]} options={OPTIONS} onAdd={vi.fn()} />)

  await open()
  await userEvent.keyboard("{Escape}")

  expect(screen.queryByRole("combobox", { name: "Add a tag" })).toBeNull()
  expect(screen.getByRole("button", { name: "Add tag" })).toHaveFocus()
})

test("ST9: a click outside closes the popover", async () => {
  render(<TagAdd selected={[]} options={OPTIONS} onAdd={vi.fn()} />)

  await open()
  await userEvent.click(document.body)

  expect(screen.queryByRole("combobox", { name: "Add a tag" })).toBeNull()
})
