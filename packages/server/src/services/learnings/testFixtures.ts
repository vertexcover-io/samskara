import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessRunner, Problem } from "@samskara/core"
import type { Db } from "../../db/client.js"
import { messages, orgs } from "../../db/schema.js"
import * as projectsRepo from "../../repositories/projects.repo.js"
import * as problemsRepo from "../../repositories/reviewProblems.repo.js"
import * as reviewsRepo from "../../repositories/reviews.repo.js"
import * as sessionsRepo from "../../repositories/sessions.repo.js"

/**
 * Shared by the learning tests (repository, run, routes): a problem, a project with sessions
 * and problems in it, a harness repo, and both agents faked. Test-only, like `db/testDb.ts`.
 */

/** A problem as a review saves it; its evidence cites msg-1. */
export const problemFixture = (title: string, fields: Partial<Problem> = {}): Problem => ({
  title,
  class: "slow",
  severity: "medium",
  severityReason: "lost time",
  fixType: "skill",
  description: "Expected a wait. It returned early.",
  evidence: [{ from: "msg-1", to: "msg-1", quote: "waiting on jest", why: "returned early" }],
  learning: "Wait for the run to finish.",
  extra: {},
  ...fields,
})

export const seedOrg = async (db: Db, slug: string): Promise<string> => {
  const [org] = await db.insert(orgs).values({ githubSlug: slug }).returning()
  if (!org) throw new Error("seed org failed")
  return org.id
}

/** A project owned by the org, so its members can read it and start runs. */
export const seedProject = async (db: Db, orgId: string, slug: string): Promise<string> =>
  (
    await projectsRepo.upsertOwned(db, {
      identity: { name: slug, slug },
      owner: { kind: "org", orgId },
    })
  ).id

/**
 * A session in the project, with one problems review holding `problems`. With `texts`, the
 * session gets those messages, and the review saves their ids as its record order, so
 * evidence excerpts can be built from it.
 */
export const seedSession = async (
  db: Db,
  input: {
    readonly sessionId: string
    readonly projectId: string
    readonly userId: string
    readonly problems: ReadonlyArray<Problem>
    readonly texts?: ReadonlyArray<string>
  },
): Promise<{ readonly reviewId: string }> => {
  const { sessionId, projectId } = input
  await sessionsRepo.upsert(db, {
    id: sessionId,
    source: "claude_code",
    userId: input.userId,
    projectId,
    fields: { title: "t" },
  })
  const recordIds: string[] = []
  for (const [index, text] of (input.texts ?? []).entries()) {
    const [row] = await db
      .insert(messages)
      .values({
        sessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: 0,
        msgType: "message",
        role: "assistant",
        lineNumber: index + 1,
        source: "claude_code",
        sourceRelativePath: "test.jsonl",
        trackId: "main",
        raw: {},
        sourceSchemaVersion: 1,
        content: { type: "text", value: text },
        details: {},
      })
      .returning({ id: messages.id })
    recordIds.push(row?.id as string)
  }
  const review = await reviewsRepo.upsertReview(db, {
    sessionId,
    projectId,
    analyzer: "ai-problems-v2",
    outcome: "shipped",
    friction: "none",
    summary: "s",
    signals: recordIds.length === 0 ? {} : { run: { recordIds } },
  })
  await problemsRepo.replaceReviewProblems(db, {
    reviewId: review.id,
    sessionId,
    projectId,
    problems: input.problems,
  })
  return { reviewId: review.id }
}

/** A git repo with one committed SKILL.md, standing in for the agent harness. */
export const harnessRepoFixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "harness-repo-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args])
  git("init", "-q")
  writeFileSync(join(dir, "SKILL.md"), "Run the tests.\n")
  git("add", ".")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first")
  return dir
}

/**
 * Both agents, faked. Agent 1 puts every problem into one group (joining K1 when there is
 * one), or one group each; agent 2 writes each group up as a learning — high while the batch
 * has any high left, then low — or drops it. What each was handed is kept.
 */
export const fakeAgents = (
  options: { badGroups?: boolean; verdict?: "learning" | "drop"; oneGroupEach?: boolean } = {},
) => {
  const seen: { knownLearningsMd: string[]; writerMd: string[] } = {
    knownLearningsMd: [],
    writerMd: [],
  }
  const runner: HarnessRunner = {
    run: async ({ workspaceDir }) => {
      const read = (name: string) => readFileSync(join(workspaceDir, name), "utf8")
      if (existsSync(join(workspaceDir, "problems.md"))) {
        const problemIds = [...read("problems.md").matchAll(/^## (P\d+)/gm)].map((m) => m[1])
        const joins = /^## K1:/m.test(read("known-learnings.md")) ? "K1" : "new"
        seen.knownLearningsMd.push(read("known-learnings.md"))
        const ids = options.badGroups ? problemIds.slice(1) : problemIds
        writeFileSync(
          join(workspaceDir, "groups.md"),
          options.oneGroupEach
            ? ids
                .map(
                  (id) =>
                    `## Cause ${id}\n- **Joins:** new\n- **Cause:** cause of ${id}\n- **Problems:** ${id}\n`,
                )
                .join("\n")
            : `## Wait\n- **Joins:** ${joins}\n- **Cause:** No wait rule.\n- **Problems:** ${ids.join(", ")}\n`,
        )
        return { stdout: "done", firstByteMs: 1 }
      }
      if (!existsSync(join(workspaceDir, "harness", "SKILL.md")))
        throw new Error("agent 2 was not given the harness")
      const groupIds = [...read("groups.md").matchAll(/^## (G\d+)/gm)].map((m) => m[1])
      seen.writerMd.push(read("groups.md"))
      let highLeft = Number(/at most (\d+) new high/.exec(read("groups.md"))?.[1] ?? "99")
      writeFileSync(
        join(workspaceDir, "learnings.md"),
        groupIds
          .map((id) =>
            options.verdict === "drop"
              ? `## ${id}\n- **Verdict:** drop\n- **Why:** One session, medium and slow, a one-off typo.\n`
              : `## ${id}\n- **Verdict:** learning\n- **Title:** Helpers report early\n- **Problem:** They stop before jest exits.\n- **Priority:** ${highLeft-- > 0 ? "high" : "low"} — many sessions\n- **Impact:** time_only — lost a few minutes\n- **Fix type:** skill\n- **Fix:** Add a wait rule to SKILL.md.\n- **How it helps:** Saves a few minutes a run.\n`,
          )
          .join("\n"),
      )
      return { stdout: "done", firstByteMs: 1 }
    },
  }
  return { runner, seen }
}
