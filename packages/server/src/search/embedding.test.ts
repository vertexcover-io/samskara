import { afterEach, describe, expect, test, vi } from "vitest"
import { createHttpEmbeddingClient, resolveEmbeddingClient } from "./embedding.js"

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("createHttpEmbeddingClient", () => {
  test("D11b: embedDocuments sends input_type 'document'; embedQuery sends input_type 'query'", async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string))
        return jsonResponse({ data: [{ index: 0, embedding: [0, 0] }] })
      }),
    )
    const client = createHttpEmbeddingClient({
      baseURL: "https://embed.example/v1",
      apiKey: "key",
      model: "test-model",
      dimensions: 2,
    })

    await client.embedDocuments(["doc text"])
    await client.embedQuery("query text")

    expect(bodies[0]).toMatchObject({ input_type: "document", input: ["doc text"] })
    expect(bodies[1]).toMatchObject({ input_type: "query", input: ["query text"] })
  })

  test("D11b: queryPrefix is prepended to the query side only, never to documents", async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string))
        return jsonResponse({ data: [{ index: 0, embedding: [0, 0] }] })
      }),
    )
    const client = createHttpEmbeddingClient({
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
      model: "mxbai-embed-large",
      dimensions: 2,
      queryPrefix: "Represent this sentence for searching relevant passages: ",
    })

    await client.embedDocuments(["a turn about migrations"])
    await client.embedQuery("database schema change")

    // The document side must stay bare: prefixing it would embed the instruction into the corpus.
    expect(bodies[0]).toMatchObject({ input: ["a turn about migrations"] })
    expect(bodies[1]).toMatchObject({
      input: ["Represent this sentence for searching relevant passages: database schema change"],
    })
  })

  test("no queryPrefix leaves the query untouched, so Voyage-style providers are unaffected", async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string))
        return jsonResponse({ data: [{ index: 0, embedding: [0, 0] }] })
      }),
    )
    const client = createHttpEmbeddingClient({
      baseURL: "https://api.voyageai.com/v1",
      apiKey: "key",
      model: "voyage-4-large",
      dimensions: 2,
    })

    await client.embedQuery("database schema change")

    expect(bodies[0]).toMatchObject({ input: ["database schema change"], input_type: "query" })
  })

  test("a response whose embedding width differs from config.dimensions throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] })),
    )
    const client = createHttpEmbeddingClient({
      baseURL: "https://embed.example/v1",
      apiKey: "key",
      model: "test-model",
      dimensions: 4,
    })

    await expect(client.embedQuery("text")).rejects.toThrow()
  })

  test("results return in input order even when data[] arrives with shuffled index fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 2, embedding: [3, 3] },
            { index: 0, embedding: [1, 1] },
            { index: 1, embedding: [2, 2] },
          ],
        }),
      ),
    )
    const client = createHttpEmbeddingClient({
      baseURL: "https://embed.example/v1",
      apiKey: "key",
      model: "test-model",
      dimensions: 2,
    })

    const result = await client.embedDocuments(["a", "b", "c"])

    expect(result).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ])
  })

  test("D11: pointing baseURL and model at a second provider changes no call site", async () => {
    const calledUrls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calledUrls.push(url)
        return jsonResponse({ data: [{ index: 0, embedding: [0, 0, 0, 0] }] })
      }),
    )
    const voyage = createHttpEmbeddingClient({
      baseURL: "https://api.voyageai.com/v1",
      apiKey: "key",
      model: "voyage-4-large",
      dimensions: 4,
    })
    const openai = createHttpEmbeddingClient({
      baseURL: "https://api.openai.com/v1",
      apiKey: "key",
      model: "text-embedding-3-large",
      dimensions: 4,
    })

    await voyage.embedQuery("hello")
    await openai.embedQuery("hello")

    expect(calledUrls).toEqual([
      "https://api.voyageai.com/v1/embeddings",
      "https://api.openai.com/v1/embeddings",
    ])
  })
})

describe("resolveEmbeddingClient", () => {
  const full = {
    embeddingBaseUrl: "http://localhost:11434/v1",
    embeddingApiKey: "ollama",
    embeddingModel: "mxbai-embed-large",
  }

  test("a fully configured deployment gets a client", () => {
    expect(resolveEmbeddingClient(full)).toBeDefined()
  })

  test.each([
    ["no base url", { ...full, embeddingBaseUrl: undefined }],
    ["no api key", { ...full, embeddingApiKey: undefined }],
    ["no model", { ...full, embeddingModel: undefined }],
    ["nothing configured", {}],
  ])("%s yields no client, so the worker never starts", (_label, env) => {
    // Not merely "doesn't throw": returning a half-built client would start a worker that polls
    // forever against a provider it can never reach. Search degrades to keyword-only instead.
    expect(resolveEmbeddingClient(env)).toBeUndefined()
  })

  test("the query prefix reaches the constructed client", async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string))
        return jsonResponse({ data: [{ index: 0, embedding: Array(1024).fill(0) }] })
      }),
    )

    const client = resolveEmbeddingClient({ ...full, embeddingQueryPrefix: "PREFIX: " })
    await client?.embedQuery("schema change")

    expect(bodies[0]).toMatchObject({ input: ["PREFIX: schema change"] })
  })
})
