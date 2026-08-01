import type { SessionCommit, SessionPullRequest, SessionRepo } from "../api/types.js"

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

const Empty = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-xs border border-dashed border-rule bg-panel-2 px-4 py-6">
    <p className="text-[0.82rem] font-semibold">{title}</p>
    <p className="mt-1 text-[0.78rem] text-ink-soft">{children}</p>
  </div>
)

const exact = (iso: string): string => {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? "--" : `${parsed.toISOString().slice(0, 19)}Z`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * A transcript is read soon after it is written, so "2 hours ago" places a commit against the
 * session far better than a timestamp does. The exact time stays one hover away.
 */
export const timeAgo = (iso: string, now: number = Date.now()): string => {
  const parsed = new Date(iso).getTime()
  if (Number.isNaN(parsed)) return "--"

  const elapsed = now - parsed
  if (elapsed < 0) return "just now"
  if (elapsed < MINUTE) return "just now"

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"} ago`
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), "minute")
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour")
  if (elapsed < 30 * DAY) return plural(Math.floor(elapsed / DAY), "day")
  return exact(iso).slice(0, 10)
}

const Stamp = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={exact(iso)} className="font-mono text-[0.6875rem] text-ink-soft">
    {timeAgo(iso)}
  </time>
)

/** Only github.com is addressable from here; anything else is shown without a link. */
const webUrl = (repo: SessionRepo, path: string): string | null =>
  repo.host === "github.com" ? `https://github.com/${repo.owner}/${repo.repoName}/${path}` : null

const Row = ({ children }: { children: React.ReactNode }) => (
  <li className="border-rule border-b py-3 last:border-b-0">{children}</li>
)

const RepoName = ({ repo }: { repo: SessionRepo }) => (
  <span className="font-mono text-[0.6875rem] text-faded">
    {repo.owner}/{repo.repoName}
  </span>
)

const JumpToMessage = ({ onJump }: { onJump: () => void }) => (
  <button
    type="button"
    onClick={onJump}
    className="rounded-xs border border-rule px-2 py-0.5 font-mono text-[0.6875rem] text-ink-soft hover:bg-panel"
  >
    Jump to transcript
  </button>
)

/**
 * Zero deletions reach us as null, indistinguishable from "not captured", so a diffstat is shown
 * only for the counts that are actually present rather than filled in with zeroes.
 */
const DiffStat = ({ commit }: { commit: SessionCommit }) => {
  const parts = [
    commit.filesChanged === null
      ? null
      : `${commit.filesChanged} file${commit.filesChanged === 1 ? "" : "s"}`,
    commit.insertions === null ? null : `+${commit.insertions}`,
    commit.deletions === null ? null : `-${commit.deletions}`,
  ].filter((part): part is string => part !== null)

  if (parts.length === 0) return null
  return <span className="font-mono text-[0.6875rem] text-faded">{parts.join(" · ")}</span>
}

const CommitRow = ({
  commit,
  onJump,
}: { commit: SessionCommit; onJump: (messageId: string) => void }) => {
  const url = webUrl(commit.repo, `commit/${commit.sha}`)
  const messageId = commit.messageId
  return (
    <Row>
      <div className="flex flex-wrap items-baseline gap-2">
        {url === null ? (
          <span className="font-mono text-[0.78rem] font-semibold">{commit.sha}</span>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[0.78rem] font-semibold underline decoration-dotted"
          >
            {commit.sha}
          </a>
        )}
        {commit.branch === null ? null : (
          <span className="rounded-pill border border-rule px-2 py-0.5 font-mono text-[0.6875rem] text-ink-soft">
            {commit.branch}
          </span>
        )}
        <DiffStat commit={commit} />
        <span className="ml-auto flex items-center gap-2">
          {messageId === null ? null : <JumpToMessage onJump={() => onJump(messageId)} />}
          <Stamp iso={commit.recordedAt} />
        </span>
      </div>
      <p className="mt-1 max-w-[104ch] text-[0.82rem]">{commit.subject ?? <Unavailable />}</p>
      <p className="mt-1">
        <RepoName repo={commit.repo} />
      </p>
    </Row>
  )
}

export const CommitsView = ({
  commits,
  onJump,
}: {
  readonly commits: ReadonlyArray<SessionCommit>
  readonly onJump: (messageId: string) => void
}) =>
  commits.length === 0 ? (
    <Empty title="No commits recorded for this session">
      Commits are filed as the session makes them, so a session that committed nothing — or ran
      before capture was watching this repo — lists none.
    </Empty>
  ) : (
    <ul>
      {commits.map((commit) => (
        <CommitRow key={commit.sha} commit={commit} onJump={onJump} />
      ))}
    </ul>
  )

const PullRequestRow = ({
  pr,
  onJump,
}: { pr: SessionPullRequest; onJump: (messageId: string) => void }) => {
  const url = webUrl(pr.repo, `pull/${pr.number}`)
  const messageId = pr.messageId
  return (
    <Row>
      <div className="flex flex-wrap items-baseline gap-2">
        {url === null ? (
          <span className="font-mono text-[0.78rem] font-semibold">#{pr.number}</span>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[0.78rem] font-semibold underline decoration-dotted"
          >
            #{pr.number}
          </a>
        )}
        <span className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-faded">
          Opened here
        </span>
        <span className="ml-auto flex items-center gap-2">
          {messageId === null ? null : <JumpToMessage onJump={() => onJump(messageId)} />}
          <Stamp iso={pr.recordedAt} />
        </span>
      </div>
      <p className="mt-1 max-w-[104ch] text-[0.82rem]">{pr.title ?? <Unavailable />}</p>
      <p className="mt-1">
        <RepoName repo={pr.repo} />
      </p>
    </Row>
  )
}

export const PullRequestsView = ({
  pullRequests,
  onJump,
}: {
  readonly pullRequests: ReadonlyArray<SessionPullRequest>
  readonly onJump: (messageId: string) => void
}) =>
  pullRequests.length === 0 ? (
    <Empty title="No pull requests recorded for this session">
      Capture files a pull request only when a session opens one, so a session that opened none
      lists none.
    </Empty>
  ) : (
    <ul>
      {pullRequests.map((pr) => (
        <PullRequestRow key={pr.number} pr={pr} onJump={onJump} />
      ))}
    </ul>
  )
