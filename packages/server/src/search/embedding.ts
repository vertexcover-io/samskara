import { EMBEDDING_DIMENSIONS } from "./constants.js"
/**
 * One client for any provider speaking the OpenAI-shaped `/v1/embeddings`: Voyage, OpenAI, Ollama,
 * or a gateway. Nothing branches on provider.
 */
export type EmbeddingClient = {
  embedDocuments(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>>
  embedQuery(text: string): Promise<ReadonlyArray<number>>
}

export type EmbeddingConfig = {
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
  readonly dimensions: number
  /**
   * Prepended to the query side only. Voyage expresses the document/query asymmetry through
   * `input_type`, but open models express it as a literal instruction prefix -- `mxbai-embed-large`
   * expects "Represent this sentence for searching relevant passages:" on queries and bare text on
   * documents. Absent for providers that need no prefix.
   */
  readonly queryPrefix?: string
}

type InputType = "document" | "query"

type EmbeddingApiResponse = {
  readonly data: ReadonlyArray<{
    readonly embedding: ReadonlyArray<number>
    readonly index: number
  }>
}

const requestEmbeddings = async (
  config: EmbeddingConfig,
  input: ReadonlyArray<string>,
  inputType: InputType,
): Promise<ReadonlyArray<ReadonlyArray<number>>> => {
  const res = await fetch(`${config.baseURL}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input,
      output_dimension: config.dimensions,
      input_type: inputType,
    }),
  })
  if (!res.ok) throw new Error(`embedding request failed (${res.status})`)

  const body = (await res.json()) as EmbeddingApiResponse
  // `data[]` ordering is not trusted -- sorted by its own `index` rather than array position.
  const vectors = [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding)

  if (vectors.some((vector) => vector.length !== config.dimensions)) {
    throw new Error(
      `embedding response width does not match config.dimensions=${config.dimensions}`,
    )
  }
  return vectors
}

/**
 * Embedding models rank better when the indexed side and the query side are embedded
 * asymmetrically. Two providers express that asymmetry differently and this client sends
 * both: `input_type` for Voyage, and `queryPrefix` for open models. A provider ignores whichever
 * it does not understand -- verified against Ollama, which returns 200 for Voyage's `input_type`
 * and `output_dimension` rather than rejecting them.
 */
export const createHttpEmbeddingClient = (config: EmbeddingConfig): EmbeddingClient => ({
  embedDocuments: (texts) => requestEmbeddings(config, texts, "document"),
  embedQuery: async (text) => {
    const prefixed = config.queryPrefix === undefined ? text : `${config.queryPrefix}${text}`
    const [vector] = await requestEmbeddings(config, [prefixed], "query")
    if (!vector) throw new Error("embedding response carried no vector")
    return vector
  },
})

/**
 * The production default when no `EMBEDDING_*` config is present (no credentials exist in this
 * environment). Always rejects, which is what drives D21's degrade-to-keyword-only path -- an
 * unconfigured deployment behaves exactly like a provider outage rather than crashing search.
 */
export const unconfiguredEmbeddingClient: EmbeddingClient = {
  embedDocuments: () => Promise.reject(new Error("embedding provider not configured")),
  embedQuery: () => Promise.reject(new Error("embedding provider not configured")),
}

/**
 * The boot-time decision: a client only when the deployment is fully configured for one.
 *
 * Extracted from `index.ts` so it can be executed by a test rather than asserted about. `index.ts`
 * runs its side effects at import time, so anything left inline there is only reachable by reading
 * the file as text — which proves the tokens exist, not that the branch is right.
 *
 * Partial config yields `undefined` rather than a half-built client: an unconfigured worker would
 * poll forever against a provider that can never answer, and search degrades to keyword-only.
 */
export const resolveEmbeddingClient = (env: {
  readonly embeddingBaseUrl?: string
  readonly embeddingApiKey?: string
  readonly embeddingModel?: string
  readonly embeddingQueryPrefix?: string
}): EmbeddingClient | undefined => {
  const { embeddingBaseUrl, embeddingApiKey, embeddingModel, embeddingQueryPrefix } = env
  if (!embeddingBaseUrl || !embeddingApiKey || !embeddingModel) return undefined

  return createHttpEmbeddingClient({
    baseURL: embeddingBaseUrl,
    apiKey: embeddingApiKey,
    model: embeddingModel,
    dimensions: EMBEDDING_DIMENSIONS,
    queryPrefix: embeddingQueryPrefix,
  })
}
