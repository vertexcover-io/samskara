import type { ArtifactUploadPayload, IngestPayload } from "@samskara/core"

export type SinkResult = { readonly status: number }

export interface Sink {
  send(payload: IngestPayload): Promise<SinkResult>
}

export type HttpSinkDeps = {
  readonly apiBase: string
  readonly token: string
  readonly fetch: typeof globalThis.fetch
}

export const createHttpSink = ({ apiBase, token, fetch }: HttpSinkDeps): Sink => ({
  send: async (payload) => {
    const res = await fetch(`${apiBase}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    return { status: res.status }
  },
})

/**
 * A separate endpoint from `/api/ingest`, so an artifact failure never blocks transcript sync.
 * A network error surfaces as status 0, which the worker treats as retryable.
 */
export const createArtifactSink = ({ apiBase, token, fetch }: HttpSinkDeps) => ({
  send: async (payload: ArtifactUploadPayload): Promise<SinkResult> => {
    const res = await fetch(`${apiBase}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    return { status: res.status }
  },
})

export type InMemorySink = Sink & {
  readonly received: ReadonlyArray<IngestPayload>
}

export const createInMemorySink = (
  statusFor: (payload: IngestPayload) => number = () => 200,
): InMemorySink => {
  const received: IngestPayload[] = []
  return {
    received,
    send: async (payload) => {
      received.push(payload)
      return { status: statusFor(payload) }
    },
  }
}
