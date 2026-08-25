import { randomUUID } from "node:crypto"
import type { ArtifactUploadPayload, IngestPayload } from "@samskara/core"

/** `detail` is what the server (or the network) said, so a failure log can name the cause. */
export type SinkResult = {
  readonly status: number
  readonly detail?: string
  readonly reqId?: string
}

export interface Sink {
  send(payload: IngestPayload): Promise<SinkResult>
}

export type HttpSinkDeps = {
  readonly apiBase: string
  /**
   * Read per request, never captured at construction: the daemon outlives a token, and a
   * `samskara login` in another terminal must land without restarting it.
   */
  readonly readToken: () => Promise<string | null>
  readonly fetch: typeof globalThis.fetch
}

const DETAIL_CAP = 500

const NO_TOKEN = "no stored credentials -- run `samskara login` to pair this CLI"

const failureDetail = async (res: Response): Promise<string | undefined> => {
  if (res.ok) return undefined
  try {
    return (await res.text()).trim().slice(0, DETAIL_CAP) || undefined
  } catch {
    return undefined
  }
}

const post = async (
  { apiBase, readToken, fetch }: HttpSinkDeps,
  path: string,
  payload: unknown,
): Promise<SinkResult> => {
  const token = await readToken()
  if (!token) return { status: 401, detail: NO_TOKEN }

  // Minted here rather than read off the response: a network failure has no response, and that
  // is exactly the case that most needs an id to trace.
  const reqId = randomUUID()
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-request-id": reqId,
      },
      body: JSON.stringify(payload),
    })
    const detail = await failureDetail(res)
    return detail === undefined
      ? { status: res.status, reqId }
      : { status: res.status, detail, reqId }
  } catch (error) {
    return { status: 0, detail: error instanceof Error ? error.message : String(error), reqId }
  }
}

export const createHttpSink = (deps: HttpSinkDeps): Sink => ({
  send: (payload) => post(deps, "/api/ingest", payload),
})

/**
 * A separate endpoint from `/api/ingest`, so an artifact failure never blocks transcript sync.
 * A network error surfaces as status 0, which the worker treats as retryable.
 */
export const createArtifactSink = (deps: HttpSinkDeps) => ({
  send: (payload: ArtifactUploadPayload): Promise<SinkResult> =>
    post(deps, "/api/artifacts", payload),
})

export type InMemorySink = Sink & {
  readonly received: ReadonlyArray<IngestPayload>
  readonly requestIds: ReadonlyArray<string>
}

export const createInMemorySink = (
  statusFor: (payload: IngestPayload) => number = () => 200,
  detailFor: (payload: IngestPayload) => string | undefined = () => undefined,
): InMemorySink => {
  const received: IngestPayload[] = []
  const requestIds: string[] = []
  return {
    received,
    requestIds,
    send: async (payload) => {
      received.push(payload)
      const reqId = randomUUID()
      requestIds.push(reqId)
      const detail = detailFor(payload)
      const status = statusFor(payload)
      return detail === undefined ? { status, reqId } : { status, detail, reqId }
    },
  }
}
