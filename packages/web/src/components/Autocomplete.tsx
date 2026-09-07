import { useCombobox } from "downshift"
import { useId } from "react"
import { Caret, ComboboxMenu, suggestionsFor } from "./combobox.js"
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

export const Autocomplete = ({ label, value, options, onChange, placeholder }: Props) => {
  const inputId = useId()
  const items = suggestionsFor(options, value, (option) => option)
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
        <ComboboxMenu
          open={isOpen}
          items={items}
          highlightedIndex={highlightedIndex}
          labelOf={(item) => item}
          keyOf={(item) => item}
          getMenuProps={getMenuProps}
          getItemProps={getItemProps}
        />
      </div>
    </div>
  )
}
