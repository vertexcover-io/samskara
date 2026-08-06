import { useEffect, useId, useState } from "react"
import {
  RANGES,
  RANGE_LABEL,
  type Range,
  SORTS,
  SORT_LABEL,
  type SessionFilters,
  type Sort,
  withQuery,
} from "../sessions/filters.js"

const asRange = (value: string): Range => RANGES.find((range) => range === value) ?? "all"
const asSort = (value: string): Sort => SORTS.find((sort) => sort === value) ?? "recent"

// Native controls do not inherit type, so the font stack is set explicitly.
export const controlClass =
  "mt-1 h-9 w-full min-w-0 rounded-xs border border-rule bg-panel-2 px-2 font-mono text-[0.78rem] leading-none text-ink transition-colors hover:border-ink-soft focus-visible:border-custody"

const selectClass = `${controlClass} cursor-pointer appearance-none bg-[length:0.7rem] bg-[right_0.5rem_center] bg-no-repeat pr-7 bg-[url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath fill='none' stroke='%235b6270' stroke-width='1.6' d='M1 1.5 6 6.5l5-5'/%3E%3C/svg%3E")]`

const labelClass = "block text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft"

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
    <div className="min-w-0 flex-1">
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
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
    </div>
  )
}

const withAny = (options: ReadonlyArray<Option>, anyLabel: string): ReadonlyArray<Option> => [
  { value: "", label: anyLabel },
  ...options,
]

const SEARCH_DEBOUNCE_MS = 300

// Local draft state keeps the box responsive to every keystroke; `onChange` (which writes the
// URL and refetches) only fires after typing pauses, and `withQuery` is what decides whether
// this keystroke also flips the sort to relevance.
const SearchBox = ({
  filters,
  onChange,
}: {
  filters: SessionFilters
  onChange: (filters: SessionFilters) => void
}) => {
  const id = useId()
  const [draft, setDraft] = useState(filters.q ?? "")

  useEffect(() => setDraft(filters.q ?? ""), [filters.q])

  // biome-ignore lint/correctness/useExhaustiveDependencies: filters/onChange re-identify every render in the caller; keying off draft alone stops an unrelated parent re-render from resetting the debounce timer.
  useEffect(() => {
    if (draft === (filters.q ?? "")) return
    const timer = setTimeout(() => onChange(withQuery(filters, draft)), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  return (
    <div className="min-w-0 flex-[2]">
      <label className={labelClass} htmlFor={id}>
        Search
      </label>
      <input
        id={id}
        type="search"
        value={draft}
        placeholder="Search sessions…"
        className={`${controlClass} mt-1`}
        onChange={(event) => setDraft(event.target.value)}
      />
    </div>
  )
}

// Choosing a custom window replaces the range select in place rather than
// appending a control, so the bar never reflows.
const RangeControl = ({
  filters,
  onChange,
}: {
  filters: SessionFilters
  onChange: (filters: SessionFilters) => void
}) => {
  const id = useId()

  if (filters.range !== "custom") {
    return (
      <Choice
        label="Last active"
        value={filters.range}
        options={RANGES.map((range) => ({ value: range, label: RANGE_LABEL[range] }))}
        onChange={(range) => onChange({ ...filters, range: asRange(range) })}
      />
    )
  }

  return (
    <div className="min-w-0 flex-[2]">
      <div className="flex items-baseline justify-between gap-2">
        <label className={labelClass} htmlFor={id}>
          Last active
        </label>
        <button
          type="button"
          onClick={() => onChange({ ...filters, range: "all", from: null, to: null })}
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
            onChange({ ...filters, from: event.target.value === "" ? null : event.target.value })
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
            onChange({ ...filters, to: event.target.value === "" ? null : event.target.value })
          }
        />
      </div>
    </div>
  )
}

type Props = {
  readonly filters: SessionFilters
  readonly projects: ReadonlyArray<Option>
  readonly users: ReadonlyArray<string>
  readonly onChange: (filters: SessionFilters) => void
}

export const FilterBar = ({ filters, projects, users, onChange }: Props) => (
  <section
    aria-label="Session filters"
    className="flex flex-wrap items-end gap-3 border border-rule bg-panel p-3"
  >
    <SearchBox filters={filters} onChange={onChange} />
    <Choice
      label="Project"
      value={filters.project ?? ""}
      options={withAny(projects, "All projects")}
      onChange={(project) => onChange({ ...filters, project: project === "" ? null : project })}
    />
    <Choice
      label="User"
      value={filters.user ?? ""}
      options={withAny(
        users.map((user) => ({ value: user, label: user })),
        "All users",
      )}
      onChange={(user) => onChange({ ...filters, user: user === "" ? null : user })}
    />
    <RangeControl filters={filters} onChange={onChange} />

    <Choice
      label="Sort by"
      value={filters.sort}
      options={SORTS.map((sort) => ({ value: sort, label: SORT_LABEL[sort] }))}
      onChange={(sort) => onChange({ ...filters, sort: asSort(sort) })}
    />
  </section>
)
