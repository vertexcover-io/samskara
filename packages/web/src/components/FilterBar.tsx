import { useId } from "react"
import { RANGES, type Range, type SessionFilters } from "../sessions/filters.js"

const RANGE_LABELS: Readonly<Record<Range, string>> = {
  all: "All time",
  today: "Today",
  week: "Past week",
  month: "Past month",
}

const asRange = (value: string): Range => {
  const found = RANGES.find((range) => range === value)
  return found ?? "all"
}

const selectClass =
  "w-full border border-rule bg-panel-2 px-2 py-1.5 font-mono text-[0.78rem] text-ink"

const labelClass = "text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft"

type ChoiceProps = {
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<readonly [string, string]>
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
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  )
}

const withAny = (
  values: ReadonlyArray<string>,
  anyLabel: string,
): ReadonlyArray<readonly [string, string]> => [
  ["", anyLabel],
  ...values.map((value) => [value, value] as const),
]

type Props = {
  readonly filters: SessionFilters
  readonly projects: ReadonlyArray<string>
  readonly users: ReadonlyArray<string>
  readonly onChange: (filters: SessionFilters) => void
}

export const FilterBar = ({ filters, projects, users, onChange }: Props) => (
  <section
    aria-label="Session filters"
    className="flex flex-wrap gap-3 border border-rule bg-panel p-3"
  >
    <Choice
      label="Project"
      value={filters.project ?? ""}
      options={withAny(projects, "All projects")}
      onChange={(project) => onChange({ ...filters, project: project === "" ? null : project })}
    />
    <Choice
      label="User"
      value={filters.user ?? ""}
      options={withAny(users, "All users")}
      onChange={(user) => onChange({ ...filters, user: user === "" ? null : user })}
    />
    <Choice
      label="Date range"
      value={filters.range}
      options={RANGES.map((range) => [range, RANGE_LABELS[range]] as const)}
      onChange={(range) => onChange({ ...filters, range: asRange(range) })}
    />
  </section>
)
