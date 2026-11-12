export type ReviewMode = "full" | "newMessages"

export type ReviewChoice = { readonly mode: ReviewMode; readonly label: string }

/**
 * The Review choices for a session, the default first. Empty while a run is waiting or running:
 * the button is then disabled. The header and the empty state both read this, so they agree.
 */
export const reviewChoices = (state: {
  readonly reviewed: boolean
  readonly newMessages: boolean
  readonly running: boolean
}): ReadonlyArray<ReviewChoice> => {
  if (state.running) return []
  if (!state.reviewed) return [{ mode: "full", label: "Review" }]
  if (state.newMessages)
    return [
      { mode: "newMessages", label: "Review new messages" },
      { mode: "full", label: "Full review" },
    ]
  return [{ mode: "full", label: "Full review again" }]
}
