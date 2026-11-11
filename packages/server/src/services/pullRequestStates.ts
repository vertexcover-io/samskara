import type {
  PullRequestAnswer,
  PullRequestRef,
  PullRequestState,
} from "../repositories/pullRequests.repo.js"

const GRAPHQL_URL = "https://api.github.com/graphql"

/** Pull requests per GraphQL request: one query reads each by alias. */
export const LOOKUP_BATCH = 50

/** A request that takes longer is abandoned; the claim pass waits on it. */
const REQUEST_TIMEOUT_MS = 15_000

export type PullRequestLookupResult = {
  readonly answers: ReadonlyArray<PullRequestAnswer>
  /** One message per request that failed; its pull requests have no answer. */
  readonly failures: ReadonlyArray<string>
}

export type PullRequestLookup = (
  prs: ReadonlyArray<PullRequestRef>,
) => Promise<PullRequestLookupResult>

type GithubPullRequest = {
  readonly state: "OPEN" | "CLOSED" | "MERGED"
  readonly mergedAt: string | null
  readonly closedAt: string | null
}

type GraphqlBody = {
  readonly data?: Record<string, { readonly pullRequest: GithubPullRequest | null } | null> | null
  readonly errors?: ReadonlyArray<{ readonly type?: string; readonly message?: string }>
}

const STATES: Record<GithubPullRequest["state"], PullRequestState> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
}

/** Owner, name and number go as variables, never spliced into the query text. */
const batchRequest = (batch: ReadonlyArray<PullRequestRef>) => {
  const params = batch.map((_, i) => `$o${i}: String!, $n${i}: String!, $p${i}: Int!`).join(", ")
  const field = (i: number): string =>
    `pr${i}: repository(owner: $o${i}, name: $n${i}) {` +
    ` pullRequest(number: $p${i}) { state mergedAt closedAt } }`
  const fields = batch.map((_, i) => field(i)).join("\n")
  const variables = Object.fromEntries(
    batch.flatMap((pr, i) => [
      [`o${i}`, pr.owner],
      [`n${i}`, pr.repo],
      [`p${i}`, pr.number],
    ]),
  )
  return { query: `query(${params}) {\n${fields}\n}`, variables }
}

const answerOf = (id: string, pr: GithubPullRequest | null | undefined): PullRequestAnswer => {
  if (pr === null || pr === undefined) return { id, state: null, closedAt: null }
  const state = STATES[pr.state]
  const at = pr.mergedAt ?? pr.closedAt
  return { id, state, closedAt: state === "open" || at === null ? null : new Date(at) }
}

type BatchResult =
  | { readonly ok: true; readonly answers: ReadonlyArray<PullRequestAnswer> }
  | { readonly ok: false; readonly message: string; readonly rateLimited: boolean }

const failed = (message: string, rateLimited = false): BatchResult => ({
  ok: false,
  message,
  rateLimited,
})

const askBatch = async (
  token: string,
  fetchFn: typeof fetch,
  batch: ReadonlyArray<PullRequestRef>,
): Promise<BatchResult> => {
  const res = await fetchFn(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "samskara",
    },
    body: JSON.stringify(batchRequest(batch)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // GitHub answers a spent primary or secondary rate limit with 403 or 429.
  if (!res.ok)
    return failed(
      `github pull request check failed (${res.status})`,
      res.status === 403 || res.status === 429,
    )
  const body = (await res.json()) as GraphqlBody
  // A rate limit or a bad token comes back as 200 with errors and no data.
  const data = body.data
  if (data === null || data === undefined)
    return failed(
      `github pull request check failed: ${body.errors?.[0]?.message ?? "no data"}`,
      body.errors?.some((error) => error.type === "RATE_LIMITED") ?? false,
    )
  return { ok: true, answers: batch.map((pr, i) => answerOf(pr.id, data[`pr${i}`]?.pullRequest)) }
}

/**
 * Asks GitHub for each pull request's state, `LOOKUP_BATCH` at a time, one request after
 * another. Never throws: a failed request is reported in `failures` and the rest go on, except
 * after a rate limit, when the requests not yet sent are reported as failed instead.
 * Undefined without a token, so the caller cannot ask GitHub without one.
 */
export const createPullRequestLookup = (
  token: string | undefined,
  fetchFn: typeof fetch = fetch,
): PullRequestLookup | undefined => {
  if (token === undefined) return undefined
  return async (prs) => {
    const batches = Array.from({ length: Math.ceil(prs.length / LOOKUP_BATCH) }, (_, i) =>
      prs.slice(i * LOOKUP_BATCH, (i + 1) * LOOKUP_BATCH),
    )
    const answers: PullRequestAnswer[] = []
    const failures: string[] = []
    for (const [i, batch] of batches.entries()) {
      const result = await askBatch(token, fetchFn, batch).catch((error: unknown) =>
        failed(error instanceof Error ? error.message : String(error)),
      )
      if (result.ok) {
        answers.push(...result.answers)
        continue
      }
      failures.push(result.message)
      if (result.rateLimited) {
        const unsent = batches.length - i - 1
        failures.push(...Array.from({ length: unsent }, () => "not sent after a rate limit"))
        break
      }
    }
    return { answers, failures }
  }
}
