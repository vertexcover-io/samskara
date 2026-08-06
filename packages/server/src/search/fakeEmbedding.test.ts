import { describe, expect, test } from "vitest"
import { createFakeEmbeddingClient } from "./fakeEmbedding.js"

const magnitude = (vector: ReadonlyArray<number>): number =>
  Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))

describe("createFakeEmbeddingClient", () => {
  test("the same text always embeds to the same vector", async () => {
    const client = createFakeEmbeddingClient()

    const [first] = await client.embedDocuments(["investigate the memory leak"])
    const [second] = await client.embedDocuments(["investigate the memory leak"])

    expect(first).toEqual(second)
  })

  test("different text embeds to a different vector", async () => {
    const client = createFakeEmbeddingClient()

    const [a] = await client.embedDocuments(["alpha"])
    const [b] = await client.embedDocuments(["bravo"])

    expect(a).not.toEqual(b)
  })

  test("every vector is normalized to unit length at the configured dimension count", async () => {
    const client = createFakeEmbeddingClient(16)

    const vector = await client.embedQuery("normalize me")

    expect(vector).toHaveLength(16)
    expect(magnitude(vector)).toBeCloseTo(1)
  })
})
