import { EMBEDDING_DIMENSIONS } from "./constants.js"
import type { EmbeddingClient } from "./embedding.js"

/**
 * A deterministic vector derived purely from `text` -- same input, same output, every run. Not a
 * real embedding model: it carries no semantic meaning, only reproducibility, which is all a fake
 * needs to give fusion and the worker something stable to rank and store.
 */
const hashToUnitVector = (text: string, dimensions: number): ReadonlyArray<number> => {
  let seed = 0
  for (let i = 0; i < text.length; i += 1) seed = (seed * 31 + text.charCodeAt(i)) >>> 0

  let state = seed || 1
  const raw: number[] = []
  for (let i = 0; i < dimensions; i += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0
    raw.push(state / 0x7fffffff - 1)
  }

  const magnitude = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1
  return raw.map((v) => v / magnitude)
}

/**
 * Every automated test and the credential-less dev/e2e stack use this instead of
 * `createHttpEmbeddingClient` -- no test may call a real provider. Lives in `src/`, not a test
 * folder, because the worker's own integration tests and the e2e stack both need it too.
 */
export const createFakeEmbeddingClient = (
  dimensions: number = EMBEDDING_DIMENSIONS,
): EmbeddingClient => ({
  embedDocuments: async (texts) => texts.map((text) => hashToUnitVector(text, dimensions)),
  embedQuery: async (text) => hashToUnitVector(text, dimensions),
})
