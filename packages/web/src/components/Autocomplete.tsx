import { useCombobox } from "downshift"
import { useId } from "react"
import { controlClass, labelClass } from "./TextField.js"

/**
 * The filter reads as free text and as a picker at once: the reader may type any fragment, and the
 * menu offers only the values actually present on the page, so a filter that matches nothing is
 * something they chose rather than something they mistyped.
 */
type Props = {
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<string>
  readonly onChange: (value: string) => void
  readonly placeholder?: string
}

const suggestionsFor = (options: ReadonlyArray<string>, term: string): ReadonlyArray<string> => {
  const needle = term.trim().toLowerCase()
  if (needle === "") return options
  return options.filter((option) => option.toLowerCase().includes(needle))
}

const menuClass =
  "absolute left-0 top-full z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xs border border-rule bg-panel-2 py-1 shadow-lg"

const itemClass = "cursor-pointer px-2 py-1 font-mono text-[0.78rem]"

const Caret = () => (
  <svg
    viewBox="0 0 12 8"
    aria-hidden="true"
    className="h-2 w-3 fill-none stroke-current stroke-[1.6]"
  >
    <path d="M1 1.5 6 6.5l5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const Autocomplete = ({ label, value, options, onChange, placeholder }: Props) => {
  const inputId = useId()
  const items = suggestionsFor(options, value)
  const {
    isOpen,
    highlightedIndex,
    getLabelProps,
    getInputProps,
    getToggleButtonProps,
    getMenuProps,
    getItemProps,
  } = useCombobox<string>({
    inputId,
    items: [...items],
    inputValue: value,
    itemToString: (item) => item ?? "",
    onInputValueChange: ({ inputValue }) => onChange(inputValue),
  })

  const open = isOpen && items.length > 0

  return (
    <div className="min-w-0">
      <label {...getLabelProps()} htmlFor={inputId} className={labelClass}>
        {label}
      </label>
      <div className="relative mt-1">
        <input
          className={`${controlClass} mt-0 pr-7`}
          placeholder={placeholder}
          {...getInputProps()}
        />
        <button
          type="button"
          aria-label={`Show ${label} suggestions`}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-soft hover:text-ink"
          {...getToggleButtonProps()}
        >
          <Caret />
        </button>
        <ul {...getMenuProps()} className={open ? menuClass : "hidden"}>
          {open
            ? items.map((item, index) => (
                <li
                  key={item}
                  className={`${itemClass} ${highlightedIndex === index ? "bg-ink text-panel-2" : ""}`}
                  {...getItemProps({ item, index })}
                >
                  {item}
                </li>
              ))
            : null}
        </ul>
      </div>
    </div>
  )
}
