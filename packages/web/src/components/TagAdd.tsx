import { useCombobox } from "downshift"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ComboboxMenu, suggestionsFor } from "./combobox.js"

const MAX_SUGGESTIONS = 50
const VALID_TAG = /^[^\s,]{1,32}$/

type Props = {
  readonly selected: ReadonlyArray<string>
  readonly options: ReadonlyArray<string>
  readonly onAdd: (tag: string) => void
}

type EditorProps = {
  readonly selected: ReadonlyArray<string>
  readonly options: ReadonlyArray<string>
  readonly onAdd: (tag: string) => void
  readonly onClose: () => void
}

const TagInput = ({ selected, options, onAdd, onClose }: EditorProps) => {
  const [draft, setDraft] = useState("")
  const inputId = useId()

  const available = options.filter((option) => !selected.includes(option))
  const matched = suggestionsFor(available, draft, (option) => option, MAX_SUGGESTIONS)
  const candidate = draft.trim().toLowerCase()
  const creatable =
    VALID_TAG.test(candidate) && !selected.includes(candidate) && !matched.includes(candidate)
  const items = creatable ? [candidate, ...matched] : matched

  const commit = (value: string): void => {
    const tag = value.trim().toLowerCase()
    setDraft("")
    if (!VALID_TAG.test(tag) || selected.includes(tag)) return
    onAdd(tag)
  }

  const { isOpen, highlightedIndex, getInputProps, getMenuProps, getItemProps } =
    useCombobox<string>({
      inputId,
      isOpen: true,
      items: [...items],
      inputValue: draft,
      itemToString: (item) => item ?? "",
      stateReducer: (_state, { type, changes }) => {
        if (
          type === useCombobox.stateChangeTypes.ItemClick ||
          type === useCombobox.stateChangeTypes.InputKeyDownEnter
        )
          return { ...changes, inputValue: "" }
        return changes
      },
      onSelectedItemChange: ({ selectedItem }) => {
        if (selectedItem != null) commit(selectedItem)
      },
      onInputValueChange: ({ inputValue }) => setDraft(inputValue),
    })

  useEffect(() => {
    document.getElementById(inputId)?.focus()
  }, [inputId])

  return (
    <span className="relative inline-block w-44 origin-left animate-pill-in">
      <input
        {...getInputProps({
          "aria-label": "Add a tag",
          placeholder: "Add a tag",
          className:
            "h-6 w-full min-w-0 rounded-pill border border-rule bg-panel-2 px-2 font-mono text-[0.72rem] leading-none text-ink transition-colors hover:border-ink-soft focus-visible:border-custody",
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              onClose()
              return
            }
            if (event.key === "Enter") {
              event.preventDefault()
              const chosen = highlightedIndex >= 0 ? items[highlightedIndex] : draft
              if (chosen !== undefined) commit(chosen)
            }
          },
        })}
      />
      <ComboboxMenu
        open={isOpen}
        items={items}
        highlightedIndex={highlightedIndex}
        labelOf={(item) => item}
        keyOf={(item) => item}
        getMenuProps={getMenuProps}
        getItemProps={getItemProps}
      />
    </span>
  )
}

/**
 * The add affordance for a session's tags: a dashed `+ Add tag` pill that sits with the tags and,
 * when clicked, expands into the tag input with its suggestion menu.
 */
export const TagAdd = ({ selected, options, onAdd }: Props) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const focusOnClose = useRef(false)

  const close = useCallback((): void => {
    focusOnClose.current = true
    setOpen(false)
  }, [])

  useEffect(() => {
    if (open || !focusOnClose.current) return
    focusOnClose.current = false
    buttonRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) close()
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open, close])

  return (
    <span ref={rootRef} className="relative inline-flex">
      {open ? (
        <TagInput selected={selected} options={options} onAdd={onAdd} onClose={close} />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          aria-label="Add tag"
          onClick={() => setOpen(true)}
          className="rounded-pill border border-dashed border-rule px-2 py-0.5 text-ink-soft transition-colors hover:border-ink-soft hover:text-ink"
        >
          + Add tag
        </button>
      )}
    </span>
  )
}
