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

const stamp = (iso: string): string => {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? "--" : parsed.toISOString().replace("T", " ").slice(0, 19)
}

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
          <time className="font-mono text-[0.6875rem] text-ink-soft">
            {stamp(commit.recordedAt)}
          </time>
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
          <time className="font-mono text-[0.6875rem] text-ink-soft">{stamp(pr.recordedAt)}</time>
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
