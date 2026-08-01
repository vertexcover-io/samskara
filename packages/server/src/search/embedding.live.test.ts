import { describe, expect, test } from "vitest"
import { EMBEDDING_DIMENSIONS } from "./constants.js"
import { createHttpEmbeddingClient } from "./embedding.js"

/**
 * The only test in the suite that talks to a real embedding provider (D23's golden set, in its
 * smallest honest form). Everything else drives the deterministic fake, because a fake can prove
 * the plumbing but cannot prove the one thing semantic search actually rests on: that a real model
 * places related text near each other in vector space.
 *
 * Skipped -- not failed -- when no provider is reachable, so CI and credential-less machines stay
 * green. Run it locally with:
 *   ollama serve && ollama pull mxbai-embed-large
 */
const BASE_URL = process.env.EMBEDDING_BASE_URL ?? "http://localhost:11434/v1"
const MODEL = process.env.EMBEDDING_MODEL ?? "mxbai-embed-large"
const QUERY_PREFIX =
  process.env.EMBEDDING_QUERY_PREFIX ?? "Represent this sentence for searching relevant passages: "

const client = createHttpEmbeddingClient({
  baseURL: BASE_URL,
  apiKey: process.env.EMBEDDING_API_KEY ?? "ollama",
  model: MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
  queryPrefix: QUERY_PREFIX,
})

const reachable = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: ["ping"] }),
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok
  } catch {
    return false
  }
}

const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [i, ai] of a.entries()) {
    const bi = b[i] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Resolved at module load so the guard is `describe.skipIf`, not an early `return` inside each
 * test. An early return reports the test as PASSED when no provider is reachable -- a green tick
 * proving nothing, which is worse than no test at all. `skipIf` reports it as skipped.
 */
const live = await reachable()
if (!live) {
  console.warn(`[live] no embedding provider at ${BASE_URL} -- golden queries SKIPPED, not passed`)
}

describe.skipIf(!live)("live embedding provider (D23 golden queries)", () => {
  test("D10: a real provider returns exactly EMBEDDING_DIMENSIONS floats, matching the vector column", async () => {
    const [vector] = await client.embedDocuments(["a turn about a failing database migration"])
    expect(vector).toBeDefined()
    expect(vector?.length).toBe(EMBEDDING_DIMENSIONS)
    expect(vector?.every((n) => Number.isFinite(n))).toBe(true)
  }, 60_000)

  test("a query outranks an unrelated document on a session it shares no words with", async () => {
    // Deliberately shares no vocabulary with the query -- this is the whole point of the
    // semantic half. Keyword search cannot connect "postgres schema upgrade broke" to either.
    const documents = [
      "the drizzle migration failed to apply and the table was never created",
      "we rewrote the sidebar navigation styling to use the new spacing tokens",
    ]
    const [related, unrelated] = await client.embedDocuments(documents)
    const query = await client.embedQuery("postgres schema upgrade broke")

    expect(related).toBeDefined()
    expect(unrelated).toBeDefined()
    if (!related || !unrelated) return

    const relatedScore = cosine(query, related)
    const unrelatedScore = cosine(query, unrelated)

    // Ordering is what matters, not the absolute values -- the ranking is comparative.
    expect(relatedScore).toBeGreaterThan(unrelatedScore)
  }, 60_000)

  test("the query prefix changes the query vector, confirming the asymmetry actually reaches the model", async () => {
    const bare = createHttpEmbeddingClient({
      baseURL: BASE_URL,
      apiKey: process.env.EMBEDDING_API_KEY ?? "ollama",
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
    })

    const withPrefix = await client.embedQuery("postgres schema upgrade broke")
    const withoutPrefix = await bare.embedQuery("postgres schema upgrade broke")

    // Near-identical would mean the prefix is being ignored and D11b is decorative here.
    expect(cosine(withPrefix, withoutPrefix)).toBeLessThan(0.999)
  }, 60_000)
})
