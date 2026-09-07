import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode, useState } from "react"
import { expect, test, vi } from "vitest"
import type { FilterOption } from "../api/types.js"
import { Picker } from "./Picker.js"

const PROJECTS: ReadonlyArray<FilterOption> = [
  { value: "samskara", label: "Samskara" },
  { value: "andromeda", label: "Andromeda" },
]

const REPOSITORIES: ReadonlyArray<FilterOption> = [{ value: "repo-1", label: "acme/samskara" }]

const renderPicker = (
  options: ReadonlyArray<FilterOption>,
  value = "",
): { readonly onChange: ReturnType<typeof vi.fn> } => {
  const onChange = vi.fn()
  render(
    <Picker
      label="Project"
      value={value}
      options={options}
      onChange={onChange}
      placeholder="All"
    />,
  )
  return { onChange }
}

const input = (): HTMLInputElement => {
  const element = screen.getByRole("combobox", { name: "Project" })
  if (!(element instanceof HTMLInputElement)) throw new Error("Project is not an input")
  return element
}

/** Applies what the Picker reports, as every real caller does. Drift bugs only show here. */
const renderApplied = (
  options: ReadonlyArray<FilterOption>,
  initial = "",
  rebuildOptions = false,
): { readonly onChange: ReturnType<typeof vi.fn> } => {
  const onChange = vi.fn()
  const Host = () => {
    const [value, setValue] = useState(initial)
    const [, bump] = useState(0)
    return (
      <>
        <Picker
          label="Project"
          value={value}
          options={rebuildOptions ? options.map((option) => ({ ...option })) : options}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
          placeholder="All"
        />
        {/* Repaints without taking focus, so this tests the draft, not the blur rule. */}
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => bump((count) => count + 1)}
        >
          Repaint
        </button>
      </>
    )
  }
  render(<Host />)
  return { onChange }
}

test("SC55: typing narrows the offered options to matching labels, ignoring case", async () => {
  const user = userEvent.setup()
  const { onChange } = renderPicker(PROJECTS)

  await user.type(input(), "and")

  expect(screen.getByRole("option", { name: "Andromeda" })).toBeInTheDocument()
  expect(screen.queryByRole("option", { name: "Samskara" })).not.toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
})

test("SC56: choosing an option reports that option's value, not its label", async () => {
  const user = userEvent.setup()
  const { onChange } = renderPicker(REPOSITORIES)

  await user.type(input(), "acme")
  await user.click(screen.getByRole("option", { name: "acme/samskara" }))

  expect(onChange).toHaveBeenCalledWith("repo-1")
  expect(onChange).toHaveBeenCalledOnce()
})

test("SC57: the input shows the applied value's label rather than the value", () => {
  renderPicker(REPOSITORIES, "repo-1")

  expect(input().value).toBe("acme/samskara")
  expect(document.body.textContent).not.toContain("repo-1")
  expect(screen.queryByDisplayValue("repo-1")).not.toBeInTheDocument()
})

test("SC58: emptying the input clears the filter and the box stays empty", async () => {
  const user = userEvent.setup()
  const { onChange } = renderPicker(REPOSITORIES, "repo-1")

  await user.clear(input())

  expect(onChange).toHaveBeenCalledWith("")
  expect(input().value).toBe("")
})

test("SC59: the clear button appears only once there is text, and empties the filter", async () => {
  const user = userEvent.setup()
  const { onChange } = renderApplied(REPOSITORIES)

  expect(screen.queryByRole("button", { name: "Clear Project" })).not.toBeInTheDocument()

  await user.type(input(), "acme")
  await user.click(screen.getByRole("option", { name: "acme/samskara" }))

  const clear = screen.getByRole("button", { name: "Clear Project" })
  await user.click(clear)

  expect(input().value).toBe("")
  expect(onChange).toHaveBeenLastCalledWith("")
})

test("SC60: text matching nothing leaves the filter alone and reverts when focus leaves", async () => {
  const user = userEvent.setup()
  const { onChange } = renderPicker(REPOSITORIES, "repo-1")

  await user.tripleClick(input())
  await user.paste("zzz")
  await user.tab()

  expect(onChange).not.toHaveBeenCalled()
  expect(input().value).toBe("acme/samskara")
})

test("SC61: a vocabulary larger than the cap renders only the first 50 matches", async () => {
  const user = userEvent.setup()
  const many = Array.from({ length: 200 }, (_, index) => ({
    value: `branch-${index}`,
    label: `feature/search-${index}`,
  }))
  const { onChange } = renderPicker(many)

  await user.type(input(), "feature")

  const offered = screen.getAllByRole("option")
  expect(offered).toHaveLength(50)
  expect(offered[0]).toHaveTextContent("feature/search-0")

  await user.click(screen.getByRole("option", { name: "feature/search-49" }))
  expect(onChange).toHaveBeenCalledWith("branch-49")
})

test("SC62: a value the options do not carry renders as itself", () => {
  renderPicker([], "unknown-uuid")

  expect(input().value).toBe("unknown-uuid")
  expect(input().value).not.toBe("")
})

test("SC63: an option can be chosen with the keyboard alone", async () => {
  const user = userEvent.setup()
  const { onChange } = renderPicker(PROJECTS)

  input().focus()
  await user.keyboard("{ArrowDown}{Enter}")

  expect(onChange).toHaveBeenCalledWith("samskara")
  expect(screen.queryByRole("option")).not.toBeInTheDocument()
})

test("SC75: after clearing, choosing the same option again applies it", async () => {
  const user = userEvent.setup()
  const { onChange } = renderApplied(REPOSITORIES)

  await user.type(input(), "acme")
  await user.click(screen.getByRole("option", { name: "acme/samskara" }))
  expect(onChange).toHaveBeenLastCalledWith("repo-1")

  await user.click(screen.getByRole("button", { name: "Clear Project" }))
  expect(onChange).toHaveBeenLastCalledWith("")

  await user.type(input(), "acme")
  await user.click(screen.getByRole("option", { name: "acme/samskara" }))

  expect(onChange).toHaveBeenLastCalledWith("repo-1")
  expect(input().value).toBe("acme/samskara")
})

test("SC76: Escape cancels what was typed without dropping the applied filter", async () => {
  const user = userEvent.setup()
  const { onChange } = renderApplied(REPOSITORIES, "repo-1")

  input().focus()
  await user.keyboard("{Escape}")

  expect(onChange).not.toHaveBeenCalled()
  expect(input().value).toBe("acme/samskara")
})

test("SC77: an exact label typed but never chosen does not survive leaving the box", async () => {
  const user = userEvent.setup()
  const { onChange } = renderApplied(PROJECTS, "samskara")

  await user.tripleClick(input())
  await user.paste("Andromeda")
  await user.tab()

  expect(onChange).not.toHaveBeenCalled()
  expect(input().value).toBe("Samskara")
})

test("SC78: a parent repaint does not wipe text that is still being typed", async () => {
  const user = userEvent.setup()
  renderApplied(PROJECTS, "", true)

  await user.type(input(), "and")
  await user.click(screen.getByRole("button", { name: "Repaint" }))

  expect(input().value).toBe("and")
})

test("SC79: a filter carried in from the URL still shows while the options are on their way", () => {
  // StrictMode mounts twice, as the dev server does: a mount-count guard would let the second
  // pass clear a box that is filtering.
  render(
    <StrictMode>
      <Picker
        label="Project"
        value="release/search"
        options={[]}
        onChange={vi.fn()}
        placeholder="All projects"
      />
    </StrictMode>,
  )

  expect(input().value).toBe("release/search")
})

test("SC80: tabbing away from a highlighted option does not apply it", async () => {
  const user = userEvent.setup()
  const { onChange } = renderApplied(PROJECTS, "samskara")
  await user.click(input())
  // One step: the highlight starts on the applied option, so this lands on a different one.
  await user.keyboard("{ArrowDown}")
  await user.tab()
  expect(onChange).not.toHaveBeenCalled()
  expect(input().value).toBe("Samskara")
})

test("SC81: emptying a box that was never filtering reports nothing", async () => {
  const user = userEvent.setup()
  const { onChange } = renderApplied(PROJECTS)
  await user.type(input(), "x")
  await user.keyboard("{Backspace}")
  expect(onChange).not.toHaveBeenCalled()
})

test("SC82: clearing text that was never applied reports nothing", async () => {
  const user = userEvent.setup()
  const { onChange } = renderApplied(PROJECTS)
  await user.type(input(), "andro")
  await user.click(screen.getByRole("button", { name: "Clear Project" }))
  expect(input().value).toBe("")
  expect(onChange).not.toHaveBeenCalled()
})

test("SC83: options arriving mid-type do not overwrite what is being typed", async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  const view = render(
    <Picker label="Project" value="repo-1" options={[]} onChange={onChange} placeholder="All" />,
  )
  await user.clear(input())
  await user.type(input(), "acm")
  view.rerender(
    <Picker
      label="Project"
      value="repo-1"
      options={REPOSITORIES}
      onChange={onChange}
      placeholder="All"
    />,
  )
  expect(input().value).toBe("acm")
})

test("SC84: a filter changed from outside the box wins over text being typed in it", async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  const view = render(
    <Picker
      label="Project"
      value="samskara"
      options={PROJECTS}
      onChange={onChange}
      placeholder="All"
    />,
  )
  await user.clear(input())
  await user.type(input(), "and")
  // Browser Back reaches the box through the value prop and never blurs it.
  view.rerender(
    <Picker
      label="Project"
      value="orphan-uuid"
      options={PROJECTS}
      onChange={onChange}
      placeholder="All"
    />,
  )
  expect(input().value).toBe("orphan-uuid")
})
