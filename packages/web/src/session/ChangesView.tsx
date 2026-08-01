import type { SessionCommit, SessionPullRequest, SessionRepo } from "../api/types.js"
import { absoluteTime, relativeTime } from "../time.js"

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

const Empty = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-xs border border-dashed border-rule bg-panel-2 px-4 py-6">
    <p className="text-[0.82rem] font-semibold">{title}</p>
    <p className="mt-1 text-[0.78rem] text-ink-soft">{children}</p>
  </div>
)

/**
 * A transcript is read soon after it is written, so "2 hours ago" places a commit against the
 * session far better than a timestamp does. The exact time stays one hover away.
 */
const Stamp = ({ iso }: { iso: string }) => (
  <time
    dateTime={iso}
    title={absoluteTime(iso)}
    className="font-mono text-[0.6875rem] text-ink-soft"
  >
    {relativeTime(iso)}
  </time>
)

/** Only github.com is addressable from here; anything else is shown without a link. */
const webUrl = (repo: SessionRepo, path: string): string | null =>
  repo.host === "github.com" ? `https://github.com/${repo.owner}/${repo.repoName}/${path}` : null

const Row = ({ children }: { children: React.ReactNode }) => (
  <li className="border-rule border-b py-3 last:border-b-0">{children}</li>
)

/** What the row is reads first; everything below it is the evidence for that claim. */
const Subject = ({ children }: { children: React.ReactNode }) => (
  <p className="max-w-[104ch] text-[0.875rem] font-semibold leading-snug">{children}</p>
)

/**
 * One mono line carrying the record's provenance -- identifier, branch, diffstat, repo, when.
 * Filed as a single line because these are read together or not at all; as three stacked rows they
 * pushed the subject into fifth place on a narrow screen.
 */
const Custody = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.6875rem] text-ink-soft">
    {children}
  </div>
)

const Sep = () => (
  <span aria-hidden="true" className="text-rule">
    ·
  </span>
)

const Chip = ({ children }: { children: React.ReactNode }) => (
  <span className="rounded-pill border border-rule px-2 py-0.5">{children}</span>
)

const RepoName = ({ repo }: { repo: SessionRepo }) => (
  <span className="text-faded">
    {repo.owner}/{repo.repoName}
  </span>
)

const JumpToMessage = ({ onJump }: { onJump: () => void }) => (
  <button
    type="button"
    onClick={onJump}
    className="rounded-xs border border-rule px-2 py-0.5 text-ink-soft transition-colors hover:border-ink-soft hover:bg-panel"
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
  return <span className="text-faded">{parts.join(" · ")}</span>
}

const CommitRow = ({
  commit,
  onJump,
}: { commit: SessionCommit; onJump: (messageId: string) => void }) => {
  const url = webUrl(commit.repo, `commit/${commit.sha}`)
  const messageId = commit.messageId
  return (
    <Row>
      <Subject>{commit.subject ?? <Unavailable />}</Subject>
      <Custody>
        {url === null ? (
          <span className="font-semibold text-custody">{commit.sha}</span>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-custody underline decoration-dotted"
          >
            {commit.sha}
          </a>
        )}
        {commit.branch === null ? null : <Chip>{commit.branch}</Chip>}
        <DiffStat commit={commit} />
        <Sep />
        <RepoName repo={commit.repo} />
        <span className="ml-auto flex items-center gap-2">
          {messageId === null ? null : <JumpToMessage onJump={() => onJump(messageId)} />}
          <Stamp iso={commit.recordedAt} />
        </span>
      </Custody>
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
      <Subject>{pr.title ?? <Unavailable />}</Subject>
      <Custody>
        {url === null ? (
          <span className="font-semibold text-custody">#{pr.number}</span>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-custody underline decoration-dotted"
          >
            #{pr.number}
          </a>
        )}
        <span className="text-faded">opened here</span>
        {pr.headBranch === null && pr.baseBranch === null ? null : (
          <Chip>
            {pr.headBranch ?? "?"} → {pr.baseBranch ?? "?"}
          </Chip>
        )}
        <Sep />
        <RepoName repo={pr.repo} />
        <span className="ml-auto flex items-center gap-2">
          {messageId === null ? null : <JumpToMessage onJump={() => onJump(messageId)} />}
          <Stamp iso={pr.recordedAt} />
        </span>
      </Custody>
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
