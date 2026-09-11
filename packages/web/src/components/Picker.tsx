import { useCombobox } from "downshift"
import { useEffect, useId, useRef, useState } from "react"
import type { FilterOption } from "../api/types.js"
import { Caret, ComboboxMenu, optionFor, suggestionsFor } from "./combobox.js"
import { controlClass, labelClass } from "./TextField.js"

/** Typing searches; only a choice from the menu applies a filter, because the stored value is an
 * opaque id the typed text never is. `Autocomplete` cannot express that: its `value` is the text. */
type Props = {
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<FilterOption>
  readonly onChange: (value: string) => void
  readonly placeholder?: string
}

const MAX_SUGGESTIONS = 50

export const Picker = ({ label, value, options, onChange, placeholder }: Props) => {
  const inputId = useId()
  const selected = optionFor(options, value)
  const display = selected?.label ?? value
  const [draft, setDraft] = useState(display)

  // A new applied value replaces the box; the same value merely acquiring a label does not, being
  // a response landing mid-type. The ref can only add a sync, so a remount cannot strand the box.
  const synced = useRef(value)
  useEffect(() => {
    const applied = synced.current !== value
    synced.current = value
    if (applied || document.activeElement?.id !== inputId) setDraft(display)
  }, [display, value, inputId])

  // Text still equal to the applied filter is not a search: the whole vocabulary stays on offer.
  const items = suggestionsFor(
    options,
    draft === display ? "" : draft,
    (option) => option.label,
    MAX_SUGGESTIONS,
  )

  const {
    isOpen,
    highlightedIndex,
    selectItem,
    getLabelProps,
    getInputProps,
    getToggleButtonProps,
    getMenuProps,
    getItemProps,
  } = useCombobox<FilterOption>({
    inputId,
    items: [...items],
    inputValue: draft,
    itemToString: (item) => item?.label ?? "",
    // Downshift commits the highlighted item on blur, so Tab would apply an option never chosen.
    stateReducer: (state, { type, changes }) =>
      type === useCombobox.stateChangeTypes.InputBlur
        ? { ...changes, selectedItem: state.selectedItem, inputValue: state.inputValue }
        : changes,
    onSelectedItemChange: ({ selectedItem }) => {
      // Compared by value: the caller rebuilds its option objects on every render.
      if (selectedItem != null && selectedItem.value !== value) onChange(selectedItem.value)
    },
    onInputValueChange: ({ inputValue, type }) => {
      if (type === useCombobox.stateChangeTypes.InputKeyDownEscape) {
        setDraft(display)
        return
      }
      setDraft(inputValue)
      // Downshift writes the input itself on selection; only InputChange is the reader typing, and
      // an already-unfiltered box reporting a clear would reset the page.
      if (inputValue === "" && value !== "" && type === useCombobox.stateChangeTypes.InputChange)
        onChange("")
    },
  })

  // Downshift reports a choice only when the selection changes, so its selection has to follow the
  // applied filter or re-choosing after a clear does nothing. Controlling `selectedItem` instead
  // makes it echo the outgoing label back on history navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the applied value alone
  useEffect(() => {
    if (selected === null && value !== "") return
    selectItem(selected)
  }, [value])

  return (
    <div className="min-w-0">
      <label {...getLabelProps()} htmlFor={inputId} className={labelClass}>
        {label}
      </label>
      <div className="relative mt-1">
        <input
          className={`${controlClass} mt-0 pr-12`}
          placeholder={placeholder}
          {...getInputProps({ onBlur: () => setDraft(display) })}
        />
        {draft === "" ? null : (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => {
              setDraft("")
              if (value !== "") onChange("")
            }}
            className="absolute right-7 top-1/2 -translate-y-1/2 text-ink-soft hover:text-ink"
          >
            <svg
              viewBox="0 0 12 12"
              aria-hidden="true"
              className="h-2.5 w-2.5 fill-none stroke-current stroke-[1.6]"
            >
              <path d="M1 1l10 10M11 1 1 11" strokeLinecap="round" />
            </svg>
          </button>
        )}
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
          labelOf={(item) => item.label}
          keyOf={(item) => item.value}
          getMenuProps={getMenuProps}
          getItemProps={getItemProps}
        />
      </div>
    </div>
  )
}
