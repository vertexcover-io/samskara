import { afterEach, expect, test, vi } from "vitest"
import { fetchAiReview } from "./review.js"

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const stubFetch = (...replies: Response[]): { readonly urls: ReadonlyArray<string> } => {
  const urls: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    urls.push(typeof input === "string" ? input : String(input))
    return replies.shift() ?? response(500, { error: "exhausted" })
  })
  return { urls }
}

afterEach(() => vi.restoreAllMocks())

test("AR1: a running job comes back alongside a null review, so a reload can rejoin it", async () => {
  const job = {
    jobId: "job-1",
    status: "running",
    startedAt: "2026-08-26T20:00:00.000Z",
    lastEvent: { name: "harness_first_byte", at: "2026-08-26T20:00:04.000Z" },
  }
  const { urls } = stubFetch(response(200, { review: null, job }))

  const result = await fetchAiReview("s-1")

  expect(result).toEqual({ ok: true, data: { review: null, job } })
  expect(urls[0]).toContain("/api/sessions/s-1/aireview")
})

test("AR2: a landed review without a running job maps to a null job, keeping the old shape honest", async () => {
  const review = { id: "rev-1", createdAt: "2026-08-26T20:01:00.000Z", outcome: "productive" }
  stubFetch(response(200, { review }))

  const result = await fetchAiReview("s-1")

  expect(result).toEqual({ ok: true, data: { review, job: null } })
})

test("AR3: a 404 noAiReview still means not-yet — null review, null job, no error", async () => {
  stubFetch(response(404, { error: "noAiReview" }))

  const result = await fetchAiReview("s-1")

  expect(result).toEqual({ ok: true, data: { review: null, job: null } })
})
