import type { UseComboboxPropGetters } from "downshift"
import type { FilterOption } from "../api/types.js"

/** The chrome the free-text `Autocomplete` and the value-picking `Picker` share. */
export const menuClass =
  "absolute left-0 top-full z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xs border border-rule bg-panel-2 py-1 shadow-lg"

export const itemClass = "cursor-pointer px-2 py-1 font-mono text-[0.78rem]"

export const Caret = ({ className = "" }: { readonly className?: string }) => (
  <svg
    viewBox="0 0 12 8"
    aria-hidden="true"
    className={`h-2 w-3 fill-none stroke-current stroke-[1.6] ${className}`}
  >
    <path d="M1 1.5 6 6.5l5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Null while the vocabulary cannot name the value, as on a cold load. Callers show `label ?? value`. */
export const optionFor = (
  options: ReadonlyArray<FilterOption>,
  value: string,
): FilterOption | null => options.find((option) => option.value === value) ?? null

/** `limit` is per-caller: the sessions filters cap an unbounded vocabulary, Sync Status does not. */
export const suggestionsFor = <T,>(
  options: ReadonlyArray<T>,
  term: string,
  labelOf: (option: T) => string,
  limit?: number,
): ReadonlyArray<T> => {
  const needle = term.trim().toLowerCase()
  if (needle === "") return limit === undefined ? options : options.slice(0, limit)
  // Stops at the cap: a broad term must not lowercase thousands of branches per keystroke.
  const matches: Array<T> = []
  for (const option of options) {
    if (!labelOf(option).toLowerCase().includes(needle)) continue
    matches.push(option)
    if (matches.length === limit) break
  }
  return matches
}

type MenuProps<T> = {
  readonly open: boolean
  readonly items: ReadonlyArray<T>
  readonly highlightedIndex: number
  readonly labelOf: (item: T) => string
  readonly keyOf: (item: T) => string
  readonly getMenuProps: UseComboboxPropGetters<T>["getMenuProps"]
  readonly getItemProps: UseComboboxPropGetters<T>["getItemProps"]
}

export const ComboboxMenu = <T,>({
  open: isOpen,
  items,
  highlightedIndex,
  labelOf,
  keyOf,
  getMenuProps,
  getItemProps,
}: MenuProps<T>) => {
  const open = isOpen && items.length > 0
  return (
    <ul {...getMenuProps()} className={open ? menuClass : "hidden"}>
      {open
        ? items.map((item, index) => (
            <li
              key={keyOf(item)}
              className={`${itemClass} ${highlightedIndex === index ? "bg-ink text-panel-2" : ""}`}
              {...getItemProps({ item, index })}
            >
              {labelOf(item)}
            </li>
          ))
        : null}
    </ul>
  )
}
