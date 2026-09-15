import { useCombobox } from "downshift"
import { useId, useState } from "react"
import { Chip } from "./Chip.js"
import { Caret, ComboboxMenu, suggestionsFor } from "./combobox.js"
import { controlClass, labelClass } from "./TextField.js"

type Props = {
  readonly label: string
  readonly selected: ReadonlyArray<string>
  readonly options: ReadonlyArray<string>
  readonly onChange: (next: ReadonlyArray<string>) => void
  readonly placeholder?: string
  readonly allowCreate?: boolean
}

const MAX_SUGGESTIONS = 50

const VALID_TAG = /^[^\s,]{1,32}$/

export const TagPicker = ({
  label,
  selected,
  options,
  onChange,
  placeholder,
  allowCreate = false,
}: Props) => {
  const inputId = useId()
  const [draft, setDraft] = useState("")

  const available = options.filter((option) => !selected.includes(option))
  const matched = suggestionsFor(available, draft, (option) => option, MAX_SUGGESTIONS)
  const candidate = draft.trim().toLowerCase()
  const creatable =
    allowCreate &&
    VALID_TAG.test(candidate) &&
    !selected.includes(candidate) &&
    !matched.includes(candidate)
  const items = creatable ? [candidate, ...matched] : matched

  const {
    isOpen,
    highlightedIndex,
    selectItem,
    getLabelProps,
    getInputProps,
    getToggleButtonProps,
    getMenuProps,
    getItemProps,
  } = useCombobox<string>({
    inputId,
    items: [...items],
    inputValue: draft,
    itemToString: (item) => item ?? "",
    // Downshift commits the highlighted item on blur, so Tab would apply an option never chosen.
    stateReducer: (state, { type, changes }) => {
      if (type === useCombobox.stateChangeTypes.InputBlur)
        return { ...changes, selectedItem: state.selectedItem, inputValue: state.inputValue }
      if (
        type === useCombobox.stateChangeTypes.ItemClick ||
        type === useCombobox.stateChangeTypes.InputKeyDownEnter
      )
        return { ...changes, inputValue: "" }
      return changes
    },
    onSelectedItemChange: ({ selectedItem }) => {
      if (selectedItem == null) return
      if (!selected.includes(selectedItem)) onChange([...selected, selectedItem])
      setDraft("")
      selectItem(null)
    },
    onInputValueChange: ({ inputValue, type }) => {
      if (type === useCombobox.stateChangeTypes.InputKeyDownEscape) {
        setDraft("")
        return
      }
      setDraft(inputValue)
    },
  })

  return (
    <div className="min-w-0">
      <label {...getLabelProps()} htmlFor={inputId} className={labelClass}>
        {label}
      </label>
      <div className="relative mt-1">
        <input
          className={`${controlClass} mt-0 pr-12`}
          placeholder={placeholder}
          {...getInputProps({ onBlur: () => setDraft("") })}
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
      {selected.length === 0 ? null : (
        <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[0.72rem]">
          {selected.map((tag) => (
            <Chip
              key={tag}
              onRemove={() => onChange(selected.filter((kept) => kept !== tag))}
              removeLabel={`Remove ${tag}`}
            >
              {tag}
            </Chip>
          ))}
        </div>
      )}
    </div>
  )
}
