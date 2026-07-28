import type { GitEvent, NormalizedMessage, ParsedRecord, RepoIdentity } from "@samskara/core"
import { createLogger } from "@samskara/core"
import { describe, expect, test } from "vitest"
import { collectGitEvents } from "./gitEvents.js"

const log = createLogger({ service: "samskara-cli-test" }, { level: "silent" })

const message = (over: Partial<NormalizedMessage> & { readonly subIndex: number }) =>
  ({
    sessionId: "sess-1",
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    ...over,
  }) as NormalizedMessage

const bashCall = (
  subIndex: number,
  callId: string,
  command: string,
  repo?: RepoIdentity,
): NormalizedMessage =>
  message({
    subIndex,
    msgType: "toolCall",
    details: { callId, name: "Bash", input: { command } },
    ...(repo ? { repo } : {}),
  })

type ResultStatus = "success" | "failure" | "unknown"

const bashResult = (
  subIndex: number,
  callId: string,
  output: unknown,
  status: ResultStatus = "success",
): NormalizedMessage =>
  message({ subIndex, msgType: "toolResult", details: { callId, output, status } })

const recordOf = (messages: ReadonlyArray<NormalizedMessage>): ParsedRecord => {
  const [first, ...rest] = messages
  if (!first) throw new Error("a record needs at least one message")
  return {
    lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    lineNumber: 1,
    raw: {},
    messages: [first, ...rest],
  }
}

/** Each message lands on its own record, as a real transcript writes call and result apart. */
const collect = (messages: ReadonlyArray<NormalizedMessage>): ReadonlyArray<GitEvent> =>
  collectGitEvents(
    messages.map((each) => recordOf([each])),
    log,
  )

const commitOf = (
  command: string,
  output: unknown,
  status: ResultStatus = "success",
  repo?: RepoIdentity,
): GitEvent | undefined =>
  collect([bashCall(0, "call-1", command, repo), bashResult(1, "call-1", output, status)])[0]

describe("collectGitEvents", () => {
  test("S8: a commit's sha, branch, subject and stats come out of real git output", () => {
    const event = commitOf(
      'git commit -m "docs: enrich clients"',
      [
        "[master 37f3101] docs: enrich clients, projects, and services with expanded detail",
        " 51 files changed, 1993 insertions(+), 417 deletions(-)",
        " create mode 100644 docs/clients.md",
        " create mode 100644 docs/projects.md",
      ].join("\n"),
    )

    expect(event).toEqual({
      kind: "commit",
      sha: "37f3101",
      branch: "master",
      subject: "docs: enrich clients, projects, and services with expanded detail",
      filesChanged: 51,
      insertions: 1993,
      deletions: 417,
      callId: "call-1",
    })
  })

  test("S9: hook and npm noise printed before the commit line does not hide it", () => {
    const event = commitOf(
      "git commit -m 'build: make container start command overridable'",
      [
        'npm warn Unknown project config "scripts-prepend-node-path".',
        "ℹ No staged files match any configured task.",
        "[feat/workspace-compose-host-mode e285f783b] build: make container start command overridable",
        " 2 files changed, 11 insertions(+), 27 deletions(-)",
        "Your branch is ahead of 'origin/master' by 1 commit.",
      ].join("\n"),
    )

    expect(event).toMatchObject({
      sha: "e285f783b",
      branch: "feat/workspace-compose-host-mode",
      subject: "build: make container start command overridable",
      filesChanged: 2,
      insertions: 11,
      deletions: 27,
    })
  })

  test("S10: a slashed branch and a short sha are stored exactly as git printed them", () => {
    const event = commitOf(
      "git commit --amend --no-edit",
      [
        "[feat/local-source-graph 2314a2e44] fixup! refactor: collapse @refrens deep imports",
        " 3 files changed, 8 insertions(+)",
      ].join("\n"),
    )

    expect(event).toMatchObject({
      sha: "2314a2e44",
      branch: "feat/local-source-graph",
      subject: "fixup! refactor: collapse @refrens deep imports",
      filesChanged: 3,
      insertions: 8,
    })
    expect(event).not.toHaveProperty("deletions")
  })

  test("S11: a commit that failed, or found nothing to commit, records nothing", () => {
    expect(
      commitOf(
        "git commit -m 'nothing here'",
        "On branch master\nnothing to commit, working tree clean",
        "failure",
      ),
    ).toBeUndefined()

    // A zero-status run that still committed nothing prints no `[branch sha]` line at all.
    expect(
      commitOf(
        "git commit -m 'nothing here'",
        "On branch master\nnothing to commit, working tree clean",
      ),
    ).toBeUndefined()
  })

  test("a result whose status is unknown is still extracted, because most transcripts carry no is_error at all", () => {
    // Requiring "success" here would silently drop the majority of real commits: no transcript
    // line carries an explicit status, and over half omit is_error too.
    expect(
      commitOf(
        "git commit -m 'feat: no is_error on this line'",
        "[main 7c3d9a1] feat: no is_error on this line\n 1 file changed, 4 insertions(+)",
        "unknown",
      ),
    ).toMatchObject({ sha: "7c3d9a1", branch: "main" })
  })

  test("S12: a command that only mentions git commit in a search pattern records nothing", () => {
    expect(
      commitOf(
        "grep -rn 'git commit' packages/",
        "docs/guide.md:12: run git commit\n[master 37f3101] a line quoted from a transcript",
      ),
    ).toBeUndefined()
  })

  test("S13a: a commit carries the repo of the message that called it, not the collector's cwd", () => {
    const subRepo: RepoIdentity = {
      host: "github.com",
      owner: "acme",
      ownerType: "org",
      repoName: "serana",
    }
    const event = commitOf(
      "git commit -m 'feat: sub-repo work'",
      "[main abc1234] feat: sub-repo work\n 1 file changed, 2 insertions(+)",
      "success",
      subRepo,
    )

    expect(event).toMatchObject({ sha: "abc1234", repo: subRepo })
  })

  test("S13b: two commits in one batch each keep the repo of their own call", () => {
    const serana: RepoIdentity = {
      host: "github.com",
      owner: "acme",
      ownerType: "org",
      repoName: "serana",
    }
    const andromeda: RepoIdentity = { ...serana, repoName: "andromeda" }

    const events = collect([
      bashCall(0, "call-a", "git commit -m one", serana),
      bashResult(1, "call-a", "[main aaa1111] one\n 1 file changed, 1 insertion(+)"),
      bashCall(2, "call-b", "git commit -m two", andromeda),
      bashResult(3, "call-b", "[main bbb2222] two\n 1 file changed, 1 insertion(+)"),
    ])

    expect(events.map((event) => [event.sha, event.repo?.repoName])).toEqual([
      ["aaa1111", "serana"],
      ["bbb2222", "andromeda"],
    ])
  })

  test("a result with no matching Bash call, and a non-Bash tool, both record nothing", () => {
    expect(collect([bashResult(0, "orphan", "[main abc1234] stray output")])).toEqual([])
    expect(
      collect([
        message({
          subIndex: 0,
          msgType: "toolCall",
          details: { callId: "c1", name: "Read", input: { command: "git commit -m x" } },
        }),
        bashResult(1, "c1", "[main abc1234] not a bash commit"),
      ]),
    ).toEqual([])
  })
})
