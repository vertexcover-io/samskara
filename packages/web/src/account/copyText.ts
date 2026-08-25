const copyViaSelection = (value: string): boolean => {
  const field = document.createElement("textarea")
  field.value = value
  field.setAttribute("readonly", "")
  field.style.position = "fixed"
  field.style.opacity = "0"
  document.body.appendChild(field)
  field.select()

  const copied = document.execCommand("copy")
  document.body.removeChild(field)
  return copied
}

export const copyText = async (value: string): Promise<boolean> => {
  const written = await navigator.clipboard
    ?.writeText(value)
    .then(() => true)
    .catch(() => false)

  return written ?? copyViaSelection(value)
}
