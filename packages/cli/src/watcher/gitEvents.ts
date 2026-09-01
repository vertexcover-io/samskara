import type {
  CommitEvent,
  GitEvent,
  NormalizedMessage,
  ParsedRecord,
  PullRequestEvent,
  RepoIdentity,
} from "@samskara/core"
import { isGitCommitCommand, isPrCreateCommand } from "@samskara/core"

/**
 * Both scan rather than anchor: real output puts hook and npm noise above the commit line and
 * `create mode` lines below it. The branch group takes `/` and `+` because branches are
 * `feat/local-source-graph`, and the sha spans 7-40 because git prints an abbreviated sha whose
 * full form cannot be recovered without the repo.
 */
const SHA_RE = /\[([\w./+-]+?)(?:\s+\(root-commit\))?\s+([0-9a-f]{7,40})\]\s*(.*)/
const STAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

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

type PullRequestFacts = Omit<PullRequestEvent, "kind" | "callId">

/**
 * Scans the result rather than the command: the created PR's repo comes from its own URL, never
 * from the call's cwd -- `gh pr create` can target a repo no cwd in the session ever pointed at.
 */
const pullRequestFacts = (output: unknown): ReadonlyArray<PullRequestFacts> => {
  const byKey = new Map<string, PullRequestFacts>()
  for (const [, host, owner, repoName, digits] of textOf(output).matchAll(PR_RE)) {
    if (!host || !owner || !repoName || !digits) continue
    const number = Number(digits)
    byKey.set(`${host}/${owner}/${repoName}#${number}`, { host, owner, repoName, number })
  }
  return [...byKey.values()]
}

type PendingCall = { readonly command: string; readonly repo?: RepoIdentity }

/** A shell call is whatever the plugin marked as one; no tool name is known here. */
const pendingOf = (
  message: Extract<NormalizedMessage, { msgType: "toolCall" }>,
): PendingCall | null => {
  const metadata = message.details.metadata
  if (metadata?.type !== "shell") return null
  return { command: metadata.command, ...(message.repo ? { repo: message.repo } : {}) }
}

/**
 * A commit's sha lives only in the tool result while the command proving intent lives only in
 * the call, and they are separate messages -- so the call is remembered until its result arrives.
 *
 * Results are gated on "not a failure" rather than "is a success": no transcript carries an
 * explicit `status`, and over half omit `is_error` too, which normalizes to `unknown`. Requiring
 * `success` would drop those. A failed commit is excluded anyway by printing no `[branch sha]`
 * line at all.
 *
 * Coverage is intentionally limited to what a captured Bash call's output proves: `git commit
 * --quiet`, jj, and GUI clients (VS Code, GitHub Desktop, ...) print no matching line and leave
 * no row, and any HEAD drift from git run outside an observed Bash call -- another terminal, a
 * hook, a rebase mid-flight -- is invisible too. This tool records what the session did through
 * the Bash tool, not the repo's true history.
 *
 * A result whose call is not in `records` -- flushed in an earlier chunk or cycle -- still ships
 * whatever its output alone proves, as a candidate. The command gating here is only a traffic
 * filter: the server trusts no event and re-verifies each against the stored call before keeping
 * it, so a candidate from a grep or a non-Bash tool is dropped there.
 */
export const collectGitEvents = (records: ReadonlyArray<ParsedRecord>): ReadonlyArray<GitEvent> => {
  const calls = new Map<string, PendingCall>()
  const seen = new Set<string>()
  const events: GitEvent[] = []

  for (const message of records.flatMap((record) => record.messages)) {
    if (message.msgType === "toolCall") {
      seen.add(message.details.callId)
      const pending = pendingOf(message)
      if (pending) calls.set(message.details.callId, pending)
      continue
    }
    if (message.msgType !== "toolResult" || message.details.status === "failure") continue

    const callId = message.details.callId
    const call = calls.get(callId)

    if (call) {
      if (isGitCommitCommand(call.command)) {
        const facts = commitFacts(message.details.output)
        if (facts) {
          events.push({
            kind: "commit",
            ...facts,
            ...(call.repo ? { repo: call.repo } : {}),
            callId,
          })
        }
      }
      if (isPrCreateCommand(call.command)) {
        for (const facts of pullRequestFacts(message.details.output)) {
          events.push({ kind: "pullRequest", ...facts, callId })
        }
      }
      continue
    }

    // A call seen in this batch but absent from `calls` is a known non-git tool -- suppressed.
    // A call never seen was flushed in an earlier chunk or cycle: ship what the output alone
    // proves and let the server verify it against the stored call.
    if (seen.has(callId)) continue
    const facts = commitFacts(message.details.output)
    if (facts) events.push({ kind: "commit", ...facts, callId })
    for (const pr of pullRequestFacts(message.details.output)) {
      events.push({ kind: "pullRequest", ...pr, callId })
    }
  }

  return events
}
