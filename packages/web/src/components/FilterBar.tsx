import { useEffect, useId, useState } from "react"
import type { SessionFilterOptions } from "../api/types.js"
import {
  changedFilters,
  RANGE_LABEL,
  RANGES,
  type Range,
  type SessionFilters,
  SORT_LABEL,
  SORTS,
  type Sort,
} from "../sessions/filters.js"
import { controlClass, labelClass, TextField } from "./TextField.js"

const asRange = (value: string): Range => RANGES.find((range) => range === value) ?? "all"
const asSort = (value: string): Sort => SORTS.find((sort) => sort === value) ?? "recent"

const selectClass = `${controlClass} mt-0 cursor-pointer appearance-none pr-7`
const buttonClass =
  "h-9 rounded-xs border border-ink bg-ink px-4 text-[0.78rem] font-semibold text-panel-2 transition-colors hover:bg-ink-2"

const Caret = () => (
  <svg
    viewBox="0 0 12 8"
    aria-hidden="true"
    className="pointer-events-none absolute right-2 top-1/2 h-2 w-3 -translate-y-1/2 fill-none stroke-current stroke-[1.6] text-ink-soft"
  >
    <path d="M1 1.5 6 6.5l5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export type Option = { readonly value: string; readonly label: string }

type ChoiceProps = {
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<Option>
  readonly onChange: (value: string) => void
}

const Choice = ({ label, value, options, onChange }: ChoiceProps) => {
  const id = useId()
  return (
    <div className="min-w-0">
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      <div className="relative mt-1">
        <select
          id={id}
          className={selectClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Caret />
      </div>
    </div>
  )
}

const withAny = (options: ReadonlyArray<Option>, anyLabel: string): ReadonlyArray<Option> => [
  { value: "", label: anyLabel },
  ...options,
]

const TextFilter = ({
  label,
  value,
  placeholder,
  hint,
  onSubmit,
}: {
  readonly label: string
  readonly value: string | null
  readonly placeholder: string
  readonly hint?: string
  readonly onSubmit: (value: string | null) => void
}) => {
  const [draft, setDraft] = useState(value ?? "")
  useEffect(() => setDraft(value ?? ""), [value])

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(draft === "" ? null : draft)
      }}
    >
      <TextField
        label={label}
        value={draft}
        onChange={setDraft}
        placeholder={placeholder}
        hint={hint}
        trailing={
          <button
            type="submit"
            className="shrink-0 rounded-xs border border-rule bg-panel-2 px-2 font-mono text-[0.72rem] font-semibold hover:border-ink"
          >
            Apply
          </button>
        }
      />
    </form>
  )
}

const RangeControl = ({
  filters,
  onChange,
}: {
  readonly filters: SessionFilters
  readonly onChange: (filters: SessionFilters) => void
}) => {
  const id = useId()
  if (filters.range !== "custom") {
    return (
      <Choice
        label="Last active"
        value={filters.range}
        options={RANGES.map((range) => ({ value: range, label: RANGE_LABEL[range] }))}
        onChange={(range) =>
          onChange(changedFilters(filters, { range: asRange(range), from: null, to: null }))
        }
      />
    )
  }

  return (
    <div className="min-w-0 min-[560px]:col-span-2">
      <div className="flex items-baseline justify-between gap-2">
        <label className={labelClass} htmlFor={id}>
          Last active
        </label>
        <button
          type="button"
          onClick={() => onChange(changedFilters(filters, { range: "all", from: null, to: null }))}
          className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-custody hover:underline"
        >
          Reset
        </button>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <input
          id={id}
          type="date"
          value={filters.from ?? ""}
          max={filters.to ?? undefined}
          aria-label="From date"
          className={`${controlClass} mt-0`}
          onChange={(event) =>
            onChange(changedFilters(filters, { from: event.target.value || null }))
          }
        />
        <span aria-hidden="true" className="shrink-0 font-mono text-[0.72rem] text-faded">
          →
        </span>
        <input
          type="date"
          value={filters.to ?? ""}
          min={filters.from ?? undefined}
          aria-label="To date"
          className={`${controlClass} mt-0`}
          onChange={(event) =>
            onChange(changedFilters(filters, { to: event.target.value || null }))
          }
        />
      </div>
    </div>
  )
}

type Props = {
  readonly filters: SessionFilters
  readonly options: SessionFilterOptions
  readonly onChange: (filters: SessionFilters) => void
  readonly onClear: () => void
}

export const FilterBar = ({ filters, options, onChange, onClear }: Props) => {
  const [query, setQuery] = useState(filters.q ?? "")
  const searchId = useId()
  const sorts = filters.q === null ? SORTS.filter((sort) => sort !== "relevance") : SORTS
  useEffect(() => setQuery(filters.q ?? ""), [filters.q])

  return (
    <section aria-label="Search and filter sessions" className="border border-rule bg-panel p-3">
      <form
        className="grid grid-cols-1 items-end gap-2 min-[600px]:grid-cols-[minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault()
          const q = query.trim() || null
          onChange(
            changedFilters(filters, {
              q,
              sort:
                q === null && filters.sort === "relevance"
                  ? "recent"
                  : filters.sort === "recent" && q !== null
                    ? "relevance"
                    : filters.sort,
            }),
          )
        }}
      >
        <div className="min-w-0">
          <label className={labelClass} htmlFor={searchId}>
            Search session evidence
          </label>
          <div className="relative mt-1">
            <input
              id={searchId}
              type="search"
              className={`${controlClass} mt-0 h-10 pl-9 pr-14`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Terms, phrases, or OR"
              aria-describedby={`${searchId}-help`}
            />
            <svg
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-soft"
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4" />
            </svg>
            {query === "" ? null : (
              <button
                type="button"
                onClick={() => {
                  setQuery("")
                  onChange(
                    changedFilters(filters, {
                      q: null,
                      sort: filters.sort === "relevance" ? "recent" : filters.sort,
                    }),
                  )
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[0.68rem] font-semibold text-custody hover:underline"
                aria-label="Clear search"
              >
                Clear
              </button>
            )}
          </div>
          <span id={`${searchId}-help`} className="sr-only">
            Search titles, messages, pull requests, tool calls, and tool results you are authorized
            to read.
          </span>
        </div>
        <button type="submit" className={buttonClass}>
          Search
        </button>
      </form>

      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-rule pt-3">
        <span className={labelClass}>Narrow the case file</span>
        <button
          type="button"
          onClick={onClear}
          className="text-[0.68rem] font-semibold text-custody hover:underline"
        >
          Reset search &amp; filters
        </button>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 min-[1000px]:grid-cols-4">
        <Choice
          label="Project"
          value={filters.project ?? ""}
          options={withAny(options.projects, "All projects")}
          onChange={(project) => onChange(changedFilters(filters, { project: project || null }))}
        />
        <Choice
          label="User"
          value={filters.user ?? ""}
          options={withAny(options.authors, "All users")}
          onChange={(user) => onChange(changedFilters(filters, { user: user || null }))}
        />
        <Choice
          label="Repository"
          value={filters.repo ?? ""}
          options={withAny(options.repositories, "All repositories")}
          onChange={(repo) => onChange(changedFilters(filters, { repo: repo || null }))}
        />
        <Choice
          label="Branch"
          value={filters.branch ?? ""}
          options={withAny(
            options.branches.map((branch) => ({ value: branch, label: branch })),
            "All branches",
          )}
          onChange={(branch) => onChange(changedFilters(filters, { branch: branch || null }))}
        />
        <TextFilter
          label="PR number"
          value={filters.pr}
          placeholder="e.g. 42"
          hint="Enter a canonical positive pull request number."
          onSubmit={(pr) => onChange(changedFilters(filters, { pr }))}
        />
        <TextFilter
          label="Commit SHA"
          value={filters.commit}
          placeholder="7–40 hex characters"
          hint="Use a full SHA or an unambiguous seven to forty character hexadecimal prefix."
          onSubmit={(commit) =>
            onChange(changedFilters(filters, { commit: commit?.trim().toLowerCase() ?? null }))
          }
        />
        <RangeControl filters={filters} onChange={onChange} />
        <Choice
          label="Sort by"
          value={filters.sort}
          options={sorts.map((sort) => ({ value: sort, label: SORT_LABEL[sort] }))}
          onChange={(sort) => onChange(changedFilters(filters, { sort: asSort(sort) }))}
        />
      </div>
    </section>
  )
}
