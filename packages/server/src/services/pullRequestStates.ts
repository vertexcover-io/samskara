import type {
  BranchAnswer,
  BranchRef,
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

type GithubBranchPullRequest = GithubPullRequest & {
  readonly number: number
  readonly title: string
  readonly baseRefName: string
  readonly headRefName: string
}

type GraphqlBody<T> = {
  readonly data?: Record<string, T | null> | null
  readonly errors?: ReadonlyArray<{ readonly type?: string; readonly message?: string }>
}

type GraphqlRequest = {
  readonly query: string
  readonly variables: Record<string, string | number>
}

const STATES: Record<GithubPullRequest["state"], PullRequestState> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
}

/** Owner, name and number go as variables, never spliced into the query text. */
const batchRequest = (batch: ReadonlyArray<PullRequestRef>): GraphqlRequest => {
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

const stateOf = (pr: GithubPullRequest) => {
  const state = STATES[pr.state]
  const at = pr.mergedAt ?? pr.closedAt
  return { state, closedAt: state === "open" || at === null ? null : new Date(at) }
}

const answerOf = (id: string, pr: GithubPullRequest | null | undefined): PullRequestAnswer =>
  pr === null || pr === undefined ? { id, state: null, closedAt: null } : { id, ...stateOf(pr) }

type Failed = { readonly ok: false; readonly message: string; readonly rateLimited: boolean }

type Asked<A> = { readonly ok: true; readonly answers: ReadonlyArray<A> } | Failed

const failed = (message: string, rateLimited = false): Failed => ({
  ok: false,
  message,
  rateLimited,
})

/**
 * Posts one GraphQL request with the token and timeout every call here uses, and returns the
 * response's fields by alias, or why there are none. `what` names the call in that message.
 */
const postQuery = async <T>(
  token: string,
  fetchFn: typeof fetch,
  request: GraphqlRequest,
  what: string,
): Promise<{ readonly ok: true; readonly data: Record<string, T | null> } | Failed> => {
  const res = await fetchFn(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "samskara",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // GitHub answers a spent primary or secondary rate limit with 403 or 429.
  if (!res.ok)
    return failed(`${what} failed (${res.status})`, res.status === 403 || res.status === 429)
  const body = (await res.json()) as GraphqlBody<T>
  // A rate limit or a bad token comes back as 200 with errors and no data.
  const data = body.data
  if (data === null || data === undefined)
    return failed(
      `${what} failed: ${body.errors?.[0]?.message ?? "no data"}`,
      body.errors?.some((error) => error.type === "RATE_LIMITED") ?? false,
    )
  return { ok: true, data }
}

/**
 * Asks about `items` `LOOKUP_BATCH` at a time, one request after another. Never throws: a failed
 * request is reported in `failures` and the rest go on, except after a rate limit, when the
 * requests not yet sent are reported as failed instead.
 */
const inBatches = async <I, A>(
  items: ReadonlyArray<I>,
  ask: (batch: ReadonlyArray<I>) => Promise<Asked<A>>,
): Promise<{ readonly answers: ReadonlyArray<A>; readonly failures: ReadonlyArray<string> }> => {
  const batches = Array.from({ length: Math.ceil(items.length / LOOKUP_BATCH) }, (_, i) =>
    items.slice(i * LOOKUP_BATCH, (i + 1) * LOOKUP_BATCH),
  )
  const answers: A[] = []
  const failures: string[] = []
  for (const [i, batch] of batches.entries()) {
    const result = await ask(batch).catch((error: unknown) =>
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

const askStates = async (
  token: string,
  fetchFn: typeof fetch,
  batch: ReadonlyArray<PullRequestRef>,
): Promise<Asked<PullRequestAnswer>> => {
  const result = await postQuery<{ readonly pullRequest: GithubPullRequest | null }>(
    token,
    fetchFn,
    batchRequest(batch),
    "github pull request check",
  )
  if (!result.ok) return result
  return {
    ok: true,
    answers: batch.map((pr, i) => answerOf(pr.id, result.data[`pr${i}`]?.pullRequest)),
  }
}

/**
 * Asks GitHub for each pull request's state (see `inBatches`). Undefined without a token, so the
 * caller cannot ask GitHub without one.
 */
export const createPullRequestLookup = (
  token: string | undefined,
  fetchFn: typeof fetch = fetch,
): PullRequestLookup | undefined =>
  token === undefined ? undefined : (prs) => inBatches(prs, (b) => askStates(token, fetchFn, b))

/** Pull requests asked for per branch; a branch rarely has more than one or two. */
export const PULL_REQUESTS_PER_BRANCH = 20

export type BranchPullRequestLookup = (branches: ReadonlyArray<BranchRef>) => Promise<{
  readonly answers: ReadonlyArray<BranchAnswer>
  /** One message per request that failed; its branches have no answer. */
  readonly failures: ReadonlyArray<string>
}>

/** Owner, name and branch go as variables, never spliced into the query text. */
const branchRequest = (batch: ReadonlyArray<BranchRef>): GraphqlRequest => {
  const params = batch.map((_, i) => `$o${i}: String!, $n${i}: String!, $h${i}: String!`).join(", ")
  const field = (i: number): string =>
    `b${i}: repository(owner: $o${i}, name: $n${i}) {` +
    ` pullRequests(headRefName: $h${i}, first: ${PULL_REQUESTS_PER_BRANCH},` +
    ` states: [OPEN, CLOSED, MERGED]) {` +
    ` nodes { number title baseRefName headRefName state mergedAt closedAt } } }`
  const fields = batch.map((_, i) => field(i)).join("\n")
  const variables = Object.fromEntries(
    batch.flatMap((branch, i) => [
      [`o${i}`, branch.owner],
      [`n${i}`, branch.repo],
      [`h${i}`, branch.branch],
    ]),
  )
  return { query: `query(${params}) {\n${fields}\n}`, variables }
}

type BranchField = {
  readonly pullRequests: { readonly nodes: ReadonlyArray<GithubBranchPullRequest | null> } | null
}

const askBranches = async (
  token: string,
  fetchFn: typeof fetch,
  batch: ReadonlyArray<BranchRef>,
): Promise<Asked<BranchAnswer>> => {
  const result = await postQuery<BranchField>(
    token,
    fetchFn,
    branchRequest(batch),
    "github branch lookup",
  )
  if (!result.ok) return result
  // A repo the token cannot read comes back null: that branch has no pull request we can see.
  const answers = batch.map((branch, i) => ({
    branch,
    pullRequests: (result.data[`b${i}`]?.pullRequests?.nodes ?? [])
      .filter((pr): pr is GithubBranchPullRequest => pr !== null)
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        baseBranch: pr.baseRefName,
        headBranch: pr.headRefName,
        ...stateOf(pr),
      })),
  }))
  return { ok: true, answers }
}

/**
 * Asks GitHub, for each branch, for every pull request with it as head, in any state (see
 * `inBatches`): one aliased field per branch, so the sessions sharing a branch cost one question.
 * Shares the state check's token, timeout, batching and rate-limit stop. Undefined without a
 * token.
 */
export const createBranchPullRequestLookup = (
  token: string | undefined,
  fetchFn: typeof fetch = fetch,
): BranchPullRequestLookup | undefined =>
  token === undefined
    ? undefined
    : (branches) => inBatches(branches, (b) => askBranches(token, fetchFn, b))
