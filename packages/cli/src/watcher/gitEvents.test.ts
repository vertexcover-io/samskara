import type {
  CommitEvent,
  GitEvent,
  NormalizedMessage,
  ParsedRecord,
  PullRequestEvent,
  RepoIdentity,
} from "@samskara/core"
import { describe, expect, test } from "vitest"
import { collectGitEvents } from "./gitEvents.js"

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
    details: {
      callId,
      name: "Bash",
      input: { command },
      metadata: { type: "shell", command },
    },
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
  collectGitEvents(messages.map((each) => recordOf([each])))

const commitsIn = (events: ReadonlyArray<GitEvent>): ReadonlyArray<CommitEvent> =>
  events.flatMap((event) => (event.kind === "commit" ? [event] : []))

const prsIn = (events: ReadonlyArray<GitEvent>): ReadonlyArray<PullRequestEvent> =>
  events.flatMap((event) => (event.kind === "pullRequest" ? [event] : []))

const commitOf = (
  command: string,
  output: unknown,
  status: ResultStatus = "success",
  repo?: RepoIdentity,
): CommitEvent | undefined =>
  commitsIn(
    collect([bashCall(0, "call-1", command, repo), bashResult(1, "call-1", output, status)]),
  )[0]

const prsOf = (command: string, output: unknown): ReadonlyArray<PullRequestEvent> =>
  prsIn(collect([bashCall(0, "call-pr", command), bashResult(1, "call-pr", output)]))

describe("collectGitEvents", () => {
  test.each([
    {
      label: "S8: a commit's sha, branch, subject and stats come out of real git output",
      command: 'git commit -m "docs: enrich clients"',
      output: [
        "[master 37f3101] docs: enrich clients, projects, and services with expanded detail",
        " 51 files changed, 1993 insertions(+), 417 deletions(-)",
        " create mode 100644 docs/clients.md",
        " create mode 100644 docs/projects.md",
      ],
      status: "success",
      expected: {
        sha: "37f3101",
        branch: "master",
        subject: "docs: enrich clients, projects, and services with expanded detail",
        filesChanged: 51,
        insertions: 1993,
        deletions: 417,
      },
    },
    {
      label: "S9: hook and npm noise printed before the commit line does not hide it",
      command: "git commit -m 'build: make container start command overridable'",
      output: [
        'npm warn Unknown project config "scripts-prepend-node-path".',
        "ℹ No staged files match any configured task.",
        "[feat/workspace-compose-host-mode e285f783b] build: make container start command overridable",
        " 2 files changed, 11 insertions(+), 27 deletions(-)",
        "Your branch is ahead of 'origin/master' by 1 commit.",
      ],
      status: "success",
      expected: {
        sha: "e285f783b",
        branch: "feat/workspace-compose-host-mode",
        subject: "build: make container start command overridable",
        filesChanged: 2,
        insertions: 11,
        deletions: 27,
      },
    },
    {
      label:
        "S10: a slashed branch, a short sha and no deletions are stored exactly as git printed them",
      command: "git commit --amend --no-edit",
      output: [
        "[feat/local-source-graph 2314a2e44] fixup! refactor: collapse @refrens deep imports",
        " 3 files changed, 8 insertions(+)",
      ],
      status: "success",
      expected: {
        sha: "2314a2e44",
        branch: "feat/local-source-graph",
        subject: "fixup! refactor: collapse @refrens deep imports",
        filesChanged: 3,
        insertions: 8,
      },
    },
    {
      label:
        "a result whose status is unknown is still extracted, because most transcripts carry no is_error at all",
      command: "git commit -m 'feat: no is_error on this line'",
      output: ["[main 7c3d9a1] feat: no is_error on this line", " 1 file changed, 4 insertions(+)"],
      status: "unknown",
      expected: {
        sha: "7c3d9a1",
        branch: "main",
        subject: "feat: no is_error on this line",
        filesChanged: 1,
        insertions: 4,
      },
    },
  ] as const)("$label", ({ command, output, status, expected }) => {
    expect(commitOf(command, output.join("\n"), status)).toEqual({
      kind: "commit",
      ...expected,
      callId: "call-1",
    })
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

  test("S13b: two commits in one batch each keep the repo of their own call", () => {
    const serana: RepoIdentity = {
      host: "github.com",
      owner: "acme",
      repoName: "serana",
    }
    const andromeda: RepoIdentity = { ...serana, repoName: "andromeda" }

    const events = collect([
      bashCall(0, "call-a", "git commit -m one", serana),
      bashResult(1, "call-a", "[main aaa1111] one\n 1 file changed, 1 insertion(+)"),
      bashCall(2, "call-b", "git commit -m two", andromeda),
      bashResult(3, "call-b", "[main bbb2222] two\n 1 file changed, 1 insertion(+)"),
    ])

    expect(commitsIn(events).map((event) => [event.sha, event.repo?.repoName])).toEqual([
      ["aaa1111", "serana"],
      ["bbb2222", "andromeda"],
    ])
  })

  test("S15: a bare PR url printed by gh pr create is recorded, against the repo the url names", () => {
    expect(
      prsOf("gh pr create --fill", "https://github.com/vertexcover-io/harness-engineering/pull/59"),
    ).toEqual([
      {
        kind: "pullRequest",
        host: "github.com",
        owner: "vertexcover-io",
        repoName: "harness-engineering",
        number: 59,
        callId: "call-pr",
      },
    ])
  })

  test("S16: one call printing PR urls for five repos records four PRs, each against the repo in its own url, and drops the numberless one", () => {
    const prs = prsOf(
      "gh pr create --fill",
      [
        "=== PR: birds ===",
        "https://github.com/refrens/birds/pull/391",
        "=== PR: talos ===",
        "https://github.com/refrens/talos/pull/835",
        "=== PR: disco ===",
        "https://github.com/refrens/disco/pull/1034",
        "=== PR: mudra ===",
        "https://github.com/refrens/mudra/pull/24",
        "=== PR: jupiter ===",
        "https://github.com/refrens/jupiter/pull/",
      ].join("\n"),
    )

    expect(prs.map((pr) => [pr.repoName, pr.number])).toEqual([
      ["birds", 391],
      ["talos", 835],
      ["disco", 1034],
      ["mudra", 24],
    ])
  })

  test.each([
    {
      label: "S12: a command that only mentions git commit in a search pattern",
      command: "grep -rn 'git commit' packages/",
      output: "docs/guide.md:12: run git commit\n[master 37f3101] a line quoted from a transcript",
    },
    {
      label: "S17: a PR url seen through gh pr view rather than created",
      command: "gh pr view 59 --json url",
      output: "https://github.com/vertexcover-io/harness-engineering/pull/59",
    },
    {
      label: "S18: a grep whose search pattern contains the words gh pr create",
      command: "grep -rn 'gh pr create' ~/.claude/projects",
      output:
        "notes.md:4: https://github.com/refrens/birds/pull/391\nnotes.md:9: https://github.com/refrens/talos/pull/835",
    },
  ])("$label records nothing", ({ command, output }) => {
    expect(collect([bashCall(0, "call-1", command), bashResult(1, "call-1", output)])).toEqual([])
  })

  test("a GitLab merge request url is captured with its own host, so repos.host is not assumed to be github.com", () => {
    const [event] = prsOf(
      "glab mr create --fill",
      "https://gitlab.com/acme/serana/-/merge_requests/12",
    )

    expect(event).toMatchObject({
      host: "gitlab.com",
      owner: "acme",
      repoName: "serana",
      number: 12,
    })
  })

  test("the same PR url printed twice by one call records one PR, not two", () => {
    expect(
      prsOf(
        "gh pr create --fill",
        "https://github.com/refrens/birds/pull/391\nhttps://github.com/refrens/birds/pull/391",
      ),
    ).toHaveLength(1)
  })

  test("a result whose call was never seen ships as a candidate, without a repo", () => {
    // The call may have been flushed in an earlier chunk or cycle -- the server verifies the
    // candidate against the stored call before keeping it.
    expect(collect([bashResult(0, "orphan", "[main abc1234] stray output")])).toEqual([
      { kind: "commit", sha: "abc1234", branch: "main", subject: "stray output", callId: "orphan" },
    ])
  })

  test("a shell call is recognised by its metadata, whatever the harness named the tool", () => {
    expect(
      collect([
        message({
          subIndex: 0,
          msgType: "toolCall",
          details: {
            callId: "c1",
            name: "bash",
            input: { command: "git commit -m x" },
            metadata: { type: "shell", command: "git commit -m x" },
          },
        }),
        bashResult(1, "c1", "[main abc1234] x"),
      ]),
    ).toEqual([{ kind: "commit", sha: "abc1234", branch: "main", subject: "x", callId: "c1" }])
  })

  test("a call whose input looks like a shell command but carries no shell metadata is not one", () => {
    expect(
      collect([
        message({
          subIndex: 0,
          msgType: "toolCall",
          details: { callId: "c1", name: "Bash", input: { command: "git commit -m x" } },
        }),
        bashResult(1, "c1", "[main abc1234] x"),
      ]),
    ).toEqual([])
  })
})
