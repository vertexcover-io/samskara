import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test, vi } from "vitest"
import type { SessionFilterOptions } from "../api/types.js"
import { EMPTY_FILTERS, type SessionFilters } from "../sessions/filters.js"
import { FilterBar } from "./FilterBar.js"

const options: SessionFilterOptions = {
  projects: [{ value: "samskara", label: "Samskara" }],
  authors: [{ value: "maya", label: "maya" }],
  repositories: [
    {
      value: "repo-1",
      label: "acme/samskara",
      host: "github.com",
      owner: "acme",
      repoName: "samskara",
    },
  ],
  branches: ["main", "feat/Search"],
}

const renderBar = (filters: SessionFilters = EMPTY_FILTERS) => {
  const onChange = vi.fn()
  const onClear = vi.fn()
  render(<FilterBar filters={filters} options={options} onChange={onChange} onClear={onClear} />)
  return { onChange, onClear }
}

test("submits keyword search intentionally and defaults it to relevance on page one", async () => {
  const user = userEvent.setup()
  const { onChange } = renderBar({ ...EMPTY_FILTERS, page: 3 })

  await user.type(
    screen.getByRole("searchbox", { name: /search session evidence/i }),
    "deployment timeout",
  )
  expect(onChange).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Search" }))

  expect(onChange).toHaveBeenCalledWith({
    ...EMPTY_FILTERS,
    q: "deployment timeout",
    sort: "relevance",
  })
})

test("clear search removes relevance and reset clears every control", async () => {
  const user = userEvent.setup()
  const active = {
    ...EMPTY_FILTERS,
    q: "timeout",
    project: "samskara",
    repo: "repo-1",
    branch: "main",
    sort: "relevance" as const,
    page: 2,
  }
  const { onChange, onClear } = renderBar(active)

  await user.click(screen.getByRole("button", { name: /clear search/i }))
  expect(onChange).toHaveBeenCalledWith({
    ...EMPTY_FILTERS,
    project: "samskara",
    repo: "repo-1",
    branch: "main",
  })

  await user.click(screen.getByRole("button", { name: /reset search & filters/i }))
  expect(onClear).toHaveBeenCalledOnce()
})

test("uses server vocabulary, preserves exact branch case, and deliberately applies PR and commit text", async () => {
  const user = userEvent.setup()
  const { onChange } = renderBar({ ...EMPTY_FILTERS, page: 2 })

  await user.selectOptions(screen.getByRole("combobox", { name: "Repository" }), "repo-1")
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, repo: "repo-1" })

  await user.selectOptions(screen.getByRole("combobox", { name: "Branch" }), "feat/Search")
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, branch: "feat/Search" })

  const [prApply, commitApply] = screen.getAllByRole("button", { name: "Apply" })
  if (prApply === undefined || commitApply === undefined)
    throw new Error("Expected PR and commit Apply buttons")

  await user.type(screen.getByRole("textbox", { name: "PR number" }), "001")
  await user.click(prApply)
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, pr: "001" })

  await user.type(screen.getByRole("textbox", { name: "Commit SHA" }), "ABCDEF1")
  await user.click(commitApply)
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, commit: "abcdef1" })
})

test("only exposes relevance as a sort choice when a keyword is active", () => {
  const { rerender } = render(
    <FilterBar filters={EMPTY_FILTERS} options={options} onChange={vi.fn()} onClear={vi.fn()} />,
  )
  expect(screen.queryByRole("option", { name: "Relevance" })).not.toBeInTheDocument()

  rerender(
    <FilterBar
      filters={{ ...EMPTY_FILTERS, q: "auth", sort: "relevance" }}
      options={options}
      onChange={vi.fn()}
      onClear={vi.fn()}
    />,
  )
  expect(screen.getByRole("option", { name: "Relevance" })).toBeInTheDocument()
})
