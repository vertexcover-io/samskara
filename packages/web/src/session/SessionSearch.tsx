import { useId, useRef, useState } from "react"
import { getJson } from "../api/client.js"
import { parseSessionSearchChunks } from "../api/parse.js"
import type { ApiError, SessionSearchChunk } from "../api/types.js"
import { controlClass } from "../components/FilterBar.js"
import { HighlightedSnippet } from "../sessions/HighlightedSnippet.js"

type State =
  | { readonly phase: "idle" }
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly chunks: ReadonlyArray<SessionSearchChunk> }
  | { readonly phase: "failed"; readonly error: ApiError }

type Props = {
  readonly sessionId: string
  readonly onSelect: (anchorMessageId: string) => void
}

/** In-session search: the same engine as global search, scoped to this session's chunks. */
export const SessionSearch = ({ sessionId, onSelect }: Props) => {
  const id = useId()
  const [query, setQuery] = useState("")
  const [state, setState] = useState<State>({ phase: "idle" })

  // Two submissions can be in flight at once, and nothing guarantees they resolve in order --
  // a slower earlier query would otherwise overwrite a newer one's results. Global search solves
  // the same problem with an `active` flag in its effect; this surface submits rather than
  // reacting, so it counts requests and ignores every answer but the latest.
  const latestRequest = useRef(0)

  const runSearch = async (raw: string): Promise<void> => {
    const q = raw.trim()
    if (q === "") return

    const request = latestRequest.current + 1
    latestRequest.current = request

    setState({ phase: "loading" })
    const result = await getJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/search?q=${encodeURIComponent(q)}`,
      parseSessionSearchChunks,
    )
    if (request !== latestRequest.current) return

    setState(
      result.ok
        ? { phase: "ready", chunks: result.data }
        : { phase: "failed", error: result.error },
    )
  }

  return (
    <div className="mt-4">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void runSearch(query)
        }}
        className="flex items-end gap-2"
      >
        <div className="min-w-0 flex-1">
          <label
            className="block text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft"
            htmlFor={id}
          >
            Search this session
          </label>
          <input
            id={id}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this session…"
            className={`${controlClass} mt-1`}
          />
        </div>
        <button
          type="submit"
          className="h-9 shrink-0 rounded-xs border border-ink bg-ink px-3 text-[0.78rem] text-panel-2"
        >
          Search
        </button>
      </form>

      {state.phase === "failed" && <p className="mt-2 text-err">{state.error.message}</p>}

      {state.phase === "ready" &&
        (state.chunks.length === 0 ? (
          <p className="mt-2 italic text-ink-soft">No matches in this session.</p>
        ) : (
          <ul aria-label="Search results" className="mt-2 grid gap-1.5">
            {state.chunks.map((chunk, index) => (
              <li key={`${chunk.anchorMessageId ?? "no-anchor"}-${index}`}>
                <button
                  type="button"
                  disabled={chunk.anchorMessageId === null}
                  onClick={() => {
                    if (chunk.anchorMessageId !== null) onSelect(chunk.anchorMessageId)
                  }}
                  className="block w-full truncate border border-rule bg-panel-2 px-3 py-2 text-left text-[0.8rem] transition-colors enabled:hover:border-ink-soft disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <HighlightedSnippet snippet={chunk.snippet} />
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}
