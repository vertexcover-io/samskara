import type {
  CommitEvent,
  GitEvent,
  NormalizedMessage,
  ParsedRecord,
  PullRequestEvent,
  RepoIdentity,
} from "@samskara/core"
import type pino from "pino"
import { z } from "zod"

const bashInput = z.object({ command: z.string().min(1) })

/**
 * Both scan rather than anchor: real output puts hook and npm noise above the commit line and
 * `create mode` lines below it. The branch group takes `/` and `+` because branches are
 * `feat/local-source-graph`, and the sha spans 7-40 because git prints an abbreviated sha whose
 * full form cannot be recovered without the repo.
 */
const SHA_RE = /\[([\w./+-]+?)(?:\s+\(root-commit\))?\s+([0-9a-f]{7,40})\]\s*(.*)/
const STAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

/**
 * `git commit` as a command the caller ran, not as a substring: a grep whose pattern contains
 * the words, or a heredoc quoting them, invokes nothing.
 */
const GIT_COMMIT_RE = /(^|[\s;&|])git\s+(-\S+\s+)*commit\b/

const textOf = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output ?? "")

const count = (group: string | undefined, key: string): Record<string, number> =>
  group === undefined ? {} : { [key]: Number(group) }

type CommitFacts = Omit<CommitEvent, "kind" | "repo" | "callId">

const commitFacts = (output: unknown): CommitFacts | null => {
  const text = textOf(output)
  const identity = SHA_RE.exec(text)
  if (!identity) return null

  const [, branch, sha, subject] = identity
  if (!sha) return null

  const stats = STAT_RE.exec(text)
  const [, filesChanged, insertions, deletions] = stats ?? []
  return {
    sha,
    ...(branch ? { branch } : {}),
    ...(subject ? { subject: subject.trim() } : {}),
    ...count(filesChanged, "filesChanged"),
    ...count(insertions, "insertions"),
    ...count(deletions, "deletions"),
  }
}

/**
 * `-/merge_requests` keeps GitLab working, and the host is captured rather than assumed so the
 * `repos.host` column stays meaningful. The trailing `\d+` is what rejects a numberless URL.
 */
const PR_RE = /https?:\/\/([\w.-]+)\/([^/\s"]+)\/([^/\s"]+)\/(?:pull|-\/merge_requests)\/(\d+)/g

/**
 * A real invocation, not a substring: a grep whose *pattern* is `gh pr create` printed hundreds
 * of PR URLs in the captured corpus, and a substring test would have recorded every one of them
 * as newly opened.
 */
const PR_CREATE_RE = /(^|[\s;&|])gh\s+pr\s+create\b/

const prTitleSchema = z.object({ url: z.string().min(1), title: z.string().min(1) })

const prKey = (host: string, owner: string, repoName: string, number: number): string =>
  `${host}/${owner}/${repoName}#${number}`

const keyOfUrl = (url: string): string | null => {
  const match = new RegExp(PR_RE.source).exec(url)
  if (!match) return null
  const [, host, owner, repoName, digits] = match
  if (!host || !owner || !repoName || !digits) return null
  return prKey(host, owner, repoName, Number(digits))
}

/**
 * `gh pr list --json` prints an array of PRs; anything else parses to nothing and the URL scan
 * alone supplies the facts. Titles are opportunistic -- most references carry none.
 *
 * Keyed by the repo the entry's own `url` names rather than by number alone: one call routinely
 * prints PRs from several repos, and two of them sharing a number would otherwise trade titles.
 */
const titlesByPr = (text: string): ReadonlyMap<string, string> => {
  const start = text.indexOf("[")
  if (start === -1) return new Map()
  try {
    const parsed: unknown = JSON.parse(text.slice(start, text.lastIndexOf("]") + 1))
    if (!Array.isArray(parsed)) return new Map()
    return new Map(
      parsed.flatMap((entry) => {
        const pr = prTitleSchema.safeParse(entry)
        if (!pr.success) return []
        const key = keyOfUrl(pr.data.url)
        return key ? [[key, pr.data.title] as const] : []
      }),
    )
  } catch {
    return new Map()
  }
}

type PullRequestFacts = Omit<PullRequestEvent, "kind" | "createdHere" | "callId">

/**
 * Scans the result rather than the command, because one call routinely prints PRs in several
 * different repos -- so each PR's repo comes from its own URL, never from the call's cwd.
 */
const pullRequestFacts = (output: unknown): ReadonlyArray<PullRequestFacts> => {
  const text = textOf(output)
  const titles = titlesByPr(text)
  const byKey = new Map<string, PullRequestFacts>()

  for (const [, host, owner, repoName, digits] of text.matchAll(PR_RE)) {
    if (!host || !owner || !repoName || !digits) continue
    const number = Number(digits)
    const key = prKey(host, owner, repoName, number)
    const title = titles.get(key)
    byKey.set(key, {
      host,
      owner,
      repoName,
      number,
      ...(title ? { title } : {}),
    })
  }
  return [...byKey.values()]
}

/**
 * Keyed by command shape rather than tool name, so a second git command joins the table
 * instead of adding a branch. Mirrors `artifacts.ts`'s `WRITE_FAMILY`.
 */
const COMMAND_FAMILY: ReadonlyArray<{
  readonly matches: (command: string) => boolean
  readonly extract: (output: unknown) => CommitFacts | null
}> = [{ matches: (command) => GIT_COMMIT_RE.test(command), extract: commitFacts }]

type PendingCall = { readonly command: string; readonly repo?: RepoIdentity }

const isBashCall = (
  message: NormalizedMessage,
): message is Extract<NormalizedMessage, { msgType: "toolCall" }> =>
  message.msgType === "toolCall" && message.details.name === "Bash"

const pendingOf = (
  message: Extract<NormalizedMessage, { msgType: "toolCall" }>,
): PendingCall | null => {
  const parsed = bashInput.safeParse(message.details.input)
  if (!parsed.success) return null
  return { command: parsed.data.command, ...(message.repo ? { repo: message.repo } : {}) }
}

/**
 * A commit's sha lives only in the tool result while the command proving intent lives only in
 * the call, and they are separate messages -- so the call is remembered until its result arrives.
 *
 * Results are gated on "not a failure" rather than "is a success": no transcript carries an
 * explicit `status`, and over half omit `is_error` too, which normalizes to `unknown`. Requiring
 * `success` would drop those. A failed commit is excluded anyway by printing no `[branch sha]`
 * line at all.
 */
export const collectGitEvents = (
  records: ReadonlyArray<ParsedRecord>,
  log: pino.Logger,
): ReadonlyArray<GitEvent> => {
  const calls = new Map<string, PendingCall>()
  const events: GitEvent[] = []

  for (const message of records.flatMap((record) => record.messages)) {
    if (isBashCall(message)) {
      const pending = pendingOf(message)
      if (pending) calls.set(message.details.callId, pending)
      else log.debug({ callId: message.details.callId }, "bash tool input did not parse; skipping")
      continue
    }
    if (message.msgType !== "toolResult" || message.details.status === "failure") continue

    const call = calls.get(message.details.callId)
    if (!call) continue

    for (const family of COMMAND_FAMILY) {
      if (!family.matches(call.command)) continue
      const facts = family.extract(message.details.output)
      if (!facts) continue
      events.push({
        kind: "commit",
        ...facts,
        ...(call.repo ? { repo: call.repo } : {}),
        callId: message.details.callId,
      })
    }

    const createdHere = PR_CREATE_RE.test(call.command)
    for (const facts of pullRequestFacts(message.details.output)) {
      events.push({ kind: "pullRequest", ...facts, createdHere, callId: message.details.callId })
    }
  }

  return events
}
