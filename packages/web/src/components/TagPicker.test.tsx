import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { expect, test, vi } from "vitest"
import { TagPicker } from "./TagPicker.js"

const OPTIONS = ["harness", "demo", "spike"]

const input = (): HTMLInputElement => {
  const element = screen.getByRole("combobox", { name: "Tags" })
  if (!(element instanceof HTMLInputElement)) throw new Error("Tags is not a typeahead")
  return element
}

const renderApplied = (initial: ReadonlyArray<string> = []) => {
  const seen: Array<ReadonlyArray<string>> = []
  const Host = () => {
    const [selected, setSelected] = useState<ReadonlyArray<string>>(initial)
    return (
      <TagPicker
        label="Tags"
        selected={selected}
        options={OPTIONS}
        onChange={(next) => {
          seen.push(next)
          setSelected(next)
        }}
      />
    )
  }
  render(<Host />)
  return seen
}

test("ST7: picking two tags accumulates them rather than replacing", async () => {
  const seen = renderApplied()

  await userEvent.click(screen.getByRole("button", { name: "Show Tags suggestions" }))
  await userEvent.click(await screen.findByRole("option", { name: "harness" }))
  await userEvent.click(screen.getByRole("button", { name: "Show Tags suggestions" }))
  await userEvent.click(await screen.findByRole("option", { name: "demo" }))

  expect(seen).toEqual([["harness"], ["harness", "demo"]])
})

test("ST7: an already-selected tag is not offered again", async () => {
  renderApplied(["harness"])

  await userEvent.click(screen.getByRole("button", { name: "Show Tags suggestions" }))

  expect(screen.queryByRole("option", { name: "harness" })).toBeNull()
  expect(screen.getByRole("option", { name: "demo" })).toBeInTheDocument()
})

test("ST7: removing a chip drops just that tag", async () => {
  const seen = renderApplied(["harness", "demo"])

  await userEvent.click(screen.getByRole("button", { name: "Remove harness" }))

  expect(seen).toEqual([["demo"]])
})

test("ST7: tabbing away does not commit the highlighted option", async () => {
  const onChange = vi.fn()
  render(<TagPicker label="Tags" selected={[]} options={OPTIONS} onChange={onChange} />)

  await userEvent.type(input(), "har")
  await userEvent.tab()

  expect(onChange).not.toHaveBeenCalled()
})

test("ST7: choosing a tag leaves the search box empty, ready for the next one", async () => {
  renderApplied()

  await userEvent.click(screen.getByRole("button", { name: "Show Tags suggestions" }))
  await userEvent.click(await screen.findByRole("option", { name: "harness" }))

  expect(input().value).toBe("")
})
