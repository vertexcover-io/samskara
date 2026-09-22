import { useEffect, useState } from "react"
import { client, request } from "../api/client.js"
import type { SessionFilterOptions } from "../api/types.js"

const EMPTY: SessionFilterOptions = {
  projects: [],
  authors: [],
  repositories: [],
  branches: [],
  tags: [],
}

/**
 * Fetched once per mount, not on every filter change: the dropdowns' vocabulary does not depend on
 * the filters currently applied, and refetching it on each change would put the 935ms
 * repositories/branches scan back on the interaction path it was carved out of. A failed request
 * leaves the lists empty rather than blocking the surface that asked for them.
 */
export const useFilterOptions = (): SessionFilterOptions => {
  const [options, setOptions] = useState<SessionFilterOptions>(EMPTY)

  useEffect(() => {
    const controller = new AbortController()
    request(() =>
      client.api.sessions.filters.$get({}, { init: { signal: controller.signal } }),
    ).then((result) => {
      if (!controller.signal.aborted && result.ok) setOptions(result.data)
    })
    return () => controller.abort()
  }, [])

  return options
}
