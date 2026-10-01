import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type HarnessRunner, reviewMdSkeleton } from "@samskara/core"
import { beforeEach, describe, expect, test } from "vitest"
import { type RunnerSpec, reviewSessionCommand } from "./review-session.js"

const SESSION = "sess-review-1"

/** The credential the opencode lane looks for; tests never read the real environment. */
const KEYED = { OPENCODE_API_KEY: "test-key" }

const assistantLine = (uuid: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    uuid,
    sessionId: SESSION,
    cwd: "/work/app",
    gitBranch: "main",
    timestamp: "2026-07-23T00:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: `toolu_${uuid}`, name: "Read", input: {} },
      ],
    },
    ...extra,
  })

/** A filled-in review.md with one problem, citing a record the export actually produced. */
const reviewMd = (messageId: string, quote = "hi") => `# Review

- **Outcome:** productive
- **Friction:** moderate

## Summary

One short session with a single read.

## Problems

### Read a file without saying why

- **Class:** slow
- **Severity:** low — a few seconds lost
- **Fix type:** skill
- **Description:** The agent was expected to say what it was looking for. It read a file without a word.
- **Evidence:** ${messageId} — "${quote}" — this is all it said before the read.
- **Learning:** Say what you are looking for before reading a file.
`

/** A filled-in lens deliverable citing the first record the export actually produced. */
const reviewXml = (messageId: string, seq: number) => `<?xml version="1.0" encoding="UTF-8"?>
<review outcome="productive" friction="moderate" model="?" harness="?">
  <summary>One short session with a single read.</summary>
  <timeline>
    <entry id="explore" kind="phase" from-seq="${seq}" to-seq="${seq}" tracks="main">
      <title>Exploration</title>
      <summary>The agent read one file.</summary>
      <message-ids><id>${messageId}</id></message-ids>
    </entry>
  </timeline>
  <humanLearnings/>
  <agentLearnings>
    <learning category="approach" audience="agent" severity="low">
      <title>Read before editing</title>
      <detail>The agent read the file first, which is the right order.</detail>
      <nextTime>Keep reading before editing.</nextTime>
      <evidence>
        <ref seq="${seq}" message-id="${messageId}"><what>the read happened here</what></ref>
      </evidence>
    </learning>
  </agentLearnings>
  <breadcrumbs/>
  <counts timeline="1" human="0" agent="1" breadcrumbs="0"/>
</review>`

const capture = () => {
  let text = ""
  return {
    write: (chunk: string) => {
      text += chunk
    },
    get text(): string {
      return text
    },
  }
}

describe("reviewSessionCommand", () => {
  let home: string
  let out: string
  let cwd: string

  /** The export's first record id and seq, read back from the dry run's session.json. */
  const firstRecord = async (): Promise<{ id: string; seq: number }> => {
    const raw = await readFile(join(out, "session.json"), "utf8")
    const parsed = JSON.parse(raw) as { records: ReadonlyArray<{ id: string; seq: number }> }
    const record = parsed.records[0]
    if (record === undefined) throw new Error("export produced no records")
    return record
  }

  /** A runner that writes `markdown` into the workspace, the way a real reviewer fills review.md. */
  const writingRunner = (markdown: string): ((spec: RunnerSpec) => HarnessRunner) => {
    return () => ({
      run: async ({ workspaceDir }) => {
        await writeFile(join(workspaceDir, "review.md"), markdown, "utf8")
        return { stdout: "done", firstByteMs: 120, agentLog: "$ ls\n" }
      },
    })
  }

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-review-cmd-"))
    // Where a saved prompt lives; never the developer's real ~/.samskara.
    process.env.SAMSKARA_HOME = join(dir, "samskara-home")
    cwd = dir
    home = join(dir, "home")
    out = join(dir, "out")
    const projects = join(home, ".claude", "projects", "bucket")
    await mkdir(projects, { recursive: true })
    await writeFile(join(projects, `${SESSION}.jsonl`), `${assistantLine("l1")}\n`, "utf8")
  })

  test("RS1: an unknown session fails with the directory it looked in", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand("no-such-session", {
      homedir: () => home,
      out,
      stderr,
      stdout: capture(),
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("No transcript found")
  })

  test("RS2: --dry-run writes the export and never calls a harness", async () => {
    const stderr = capture()
    let called = 0
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      dryRun: true,
      stderr,
      stdout: capture(),
      createRunner: () => {
        called += 1
        return { run: async () => ({ stdout: "", firstByteMs: null }) }
      },
    })
    expect(code).toBe(0)
    expect(called).toBe(0)
    expect(stderr.text).toContain("dry run")
    const record = await firstRecord()
    expect(record.id).toMatch(/^msg-/)
  })

  test("RS3: a grounded review is written and reported", async () => {
    await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      dryRun: true,
      stderr: capture(),
      stdout: capture(),
    })
    const record = await firstRecord()

    const stdout = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stdout,
      stderr: capture(),
      createRunner: writingRunner(reviewMd(record.id)),
    })
    expect(code).toBe(0)
    expect(stdout.text).toContain("outcome: productive")
    expect(stdout.text).toContain("Read a file without saying why")

    const payload = JSON.parse(await readFile(join(out, "review.json"), "utf8")) as {
      model: string
      harness: string
      problems: ReadonlyArray<{ fixType: string }>
      dropped: ReadonlyArray<string>
    }
    expect(payload.problems[0]?.fixType).toBe("skill")
    expect(payload.dropped).toEqual([])
    // The harness never gets to claim these -- the runner is the authority.
    expect(payload).toMatchObject({ harness: "opencode", model: "opencode-go/glm-5.3-flash" })
    expect(await readFile(join(out, "agent.log"), "utf8")).toBe("$ ls\n")
  })

  test("RS4: a problem quoting what is not in the session is dropped and named, the rest lands", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stderr,
      stdout: capture(),
      createRunner: writingRunner(reviewMd("msg-0", "something the agent never said")),
    })
    expect(code).toBe(0)
    expect(stderr.text).toContain("DROPPED 1")
    expect(stderr.text).toContain('"something the agent never said" is not in msg-0')
    const payload = JSON.parse(await readFile(join(out, "review.json"), "utf8")) as {
      problems: ReadonlyArray<unknown>
    }
    expect(payload.problems).toEqual([])
  })

  test("RS5: a review.md that does not follow the format fails with the file kept", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stderr,
      stdout: capture(),
      createRunner: writingRunner("not a review at all"),
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("UNPARSEABLE")
    expect(stderr.text).toContain("missing ## Summary")
    expect(await readFile(join(out, "review.md"), "utf8")).toBe("not a review at all")
  })

  test("RS5b: an untouched review.md fails as missing, the same as the server", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stderr,
      stdout: capture(),
      createRunner: writingRunner(reviewMdSkeleton()),
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("MISSING: the reviewer left review.md missing or untouched")
  })

  test("RS6: a model id outside the allowed charset is refused before any harness runs", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      model: "sonnet; rm -rf /",
      stderr,
      stdout: capture(),
      createRunner: () => {
        throw new Error("the runner must not be reached")
      },
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("is not a model id")
  })

  test("RS9: a harness that fails reads as a message with its own stderr, not a stack", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stderr,
      stdout: capture(),
      createRunner: () => ({
        run: async () => {
          throw Object.assign(new Error("opencode exited with code 1"), {
            stderr: "Error: provider refused",
          })
        },
      }),
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("HARNESS FAILED: opencode exited with code 1")
    expect(stderr.text).toContain("provider refused")
  })

  test("RS7: --harness claude takes claude's default model", async () => {
    let spec: RunnerSpec | undefined
    await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      harness: "claude",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      stderr: capture(),
      stdout: capture(),
      createRunner: (given) => {
        spec = given
        return { run: async () => ({ stdout: "", firstByteMs: null }) }
      },
    })
    expect(spec).toMatchObject({ harness: "claude", model: "sonnet", sandboxHome: true })
  })

  test("RS10: opencode with no OPENCODE_API_KEY stops before the harness", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: {},
      stderr,
      stdout: capture(),
      createRunner: () => {
        throw new Error("the runner must not be reached")
      },
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("OPENCODE_API_KEY")
  })

  test("RS11: claude names both credentials it accepts", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      harness: "claude",
      env: {},
      stderr,
      stdout: capture(),
      createRunner: () => {
        throw new Error("the runner must not be reached")
      },
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(stderr.text).toContain("ANTHROPIC_API_KEY")
  })

  test("RS12: --dry-run needs no credential -- it never calls a harness", async () => {
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: {},
      dryRun: true,
      stderr: capture(),
      stdout: capture(),
    })
    expect(code).toBe(0)
  })

  test("RS13: AI_REVIEW_HARNESS and AI_REVIEW_MODEL override the built-in defaults", async () => {
    let spec: RunnerSpec | undefined
    await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: {
        AI_REVIEW_HARNESS: "claude",
        AI_REVIEW_MODEL: "opus",
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
      },
      stderr: capture(),
      stdout: capture(),
      createRunner: (given) => {
        spec = given
        return { run: async () => ({ stdout: "", firstByteMs: null }) }
      },
    })
    expect(spec).toMatchObject({ harness: "claude", model: "opus" })
  })

  test("RS14: an explicit flag still beats the environment", async () => {
    let spec: RunnerSpec | undefined
    await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      model: "opencode-go/glm-5.3",
      env: { AI_REVIEW_MODEL: "ignored/model", ...KEYED },
      stderr: capture(),
      stdout: capture(),
      createRunner: (given) => {
        spec = given
        return { run: async () => ({ stdout: "", firstByteMs: null }) }
      },
    })
    expect(spec).toMatchObject({ model: "opencode-go/glm-5.3" })
  })

  test("RS8: an unknown harness is refused by name", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      harness: "cursor",
      stderr,
      stdout: capture(),
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("--harness must be one of opencode, claude")
  })

  test("RS15: --prompt naming a file that does not exist stops with an error and runs nothing", async () => {
    const stderr = capture()
    let called = 0
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      cwd,
      out,
      env: KEYED,
      prompt: "my-system.md",
      stderr,
      stdout: capture(),
      createRunner: () => {
        called += 1
        return { run: async () => ({ stdout: "", firstByteMs: null }) }
      },
    })
    expect(code).toBe(1)
    expect(called).toBe(0)
    expect(stderr.text).toContain(`No prompt file at ${join(cwd, "my-system.md")}`)
  })

  test("RS16: a filled prompt is merged, and the reviewer's contract is the merge plus the fixed output", async () => {
    await writeFile(
      join(cwd, "my-system.md"),
      "Every human message after plan approval is a problem.\n",
    )
    const contracts: string[] = []
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      cwd,
      out,
      env: KEYED,
      prompt: "my-system.md",
      stderr: capture(),
      stdout: capture(),
      createRunner: () => ({
        run: async ({ workspaceDir }) => {
          const user = await readFile(join(workspaceDir, "USER.md"), "utf8").catch(() => undefined)
          if (user !== undefined) {
            await writeFile(join(workspaceDir, "MERGED.md"), `# How to review\n\n${user}`)
            return { stdout: "merged", firstByteMs: 1 }
          }
          // Readers have no CONTRACT.md; only the reviewer does.
          const isReviewer = await readFile(join(workspaceDir, "CONTRACT.md"), "utf8").then(
            () => true,
            () => false,
          )
          if (!isReviewer) return { stdout: "stage", firstByteMs: 1 }
          contracts.push(await readFile(join(workspaceDir, "CONTRACT.md"), "utf8"))
          await writeFile(join(workspaceDir, "review.md"), reviewMd("msg-0"))
          return { stdout: "done", firstByteMs: 1 }
        },
      }),
    })
    expect(code).toBe(0)
    expect(contracts[0]).toContain("Every human message after plan approval is a problem.")
    expect(contracts[0]).toContain("# Files and output (fixed)")
    expect(await readFile(join(out, "CONTRACT.md"), "utf8")).toBe(contracts[0])
  })

  test("RS18: claude with --no-sandbox-home uses the machine's own login, so no key is needed", async () => {
    const record = await (async () => {
      await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        dryRun: true,
        stderr: capture(),
        stdout: capture(),
      })
      return firstRecord()
    })()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: {},
      harness: "claude",
      sandboxHome: false,
      stderr: capture(),
      stdout: capture(),
      createRunner: writingRunner(reviewMd(record.id)),
    })
    expect(code).toBe(0)
  })

  test("RS19: an extra field the merged prompt asks for is required; a problem without it is dropped", async () => {
    await writeFile(join(cwd, "my-system.md"), "Add a topic field.\n")
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      cwd,
      out,
      env: KEYED,
      prompt: "my-system.md",
      stderr,
      stdout: capture(),
      createRunner: () => ({
        run: async ({ workspaceDir }) => {
          const user = await readFile(join(workspaceDir, "USER.md"), "utf8").catch(() => undefined)
          if (user !== undefined) {
            await writeFile(
              join(workspaceDir, "MERGED.md"),
              "# How to review\n\n## Extra fields\n\n- topic: what was asked\n",
            )
            return { stdout: "merged", firstByteMs: 1 }
          }
          await writeFile(join(workspaceDir, "review.md"), reviewMd("msg-0"))
          return { stdout: "done", firstByteMs: 1 }
        },
      }),
    })
    expect(code).toBe(0)
    expect(stderr.text).toContain('missing Extra "topic"')
  })

  test("RS20: leads the review never answered are named, and saved in review.json", async () => {
    // A person's message ahead of the agent's, so the session has a lead to answer.
    const userLine = JSON.stringify({
      uuid: "u0",
      sessionId: SESSION,
      cwd: "/work/app",
      gitBranch: "main",
      timestamp: "2026-07-22T23:59:00.000Z",
      type: "user",
      message: { role: "user", content: "please fix the build" },
    })
    await writeFile(
      join(home, ".claude", "projects", "bucket", `${SESSION}.jsonl`),
      `${userLine}\n${assistantLine("l1")}\n`,
      "utf8",
    )
    const record = await (async () => {
      await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        dryRun: true,
        stderr: capture(),
        stdout: capture(),
      })
      return firstRecord()
    })()
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stderr,
      stdout: capture(),
      createRunner: writingRunner(reviewMd(record.id)),
    })
    expect(code).toBe(0)
    const leads = await readFile(join(out, "leads.md"), "utf8")
    const leadCount = [...leads.matchAll(/^- (L\d+) /gm)].length
    expect(leadCount).toBeGreaterThan(0)
    expect(stderr.text).toContain(`SKIPPED ${leadCount} of ${leadCount} leads`)
    const payload = JSON.parse(await readFile(join(out, "review.json"), "utf8")) as {
      unaccountedLeads: ReadonlyArray<string>
    }
    expect(payload.unaccountedLeads).toHaveLength(leadCount)
  })

  test("RS21: the session is read in pieces first, and what the readers find is a lead in leads.md", async () => {
    const record = await (async () => {
      await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        dryRun: true,
        stderr: capture(),
        stdout: capture(),
      })
      return firstRecord()
    })()
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stderr,
      stdout: capture(),
      createRunner: () => ({
        run: async ({ workspaceDir }) => {
          const isReader = await readFile(join(workspaceDir, "READER.md"), "utf8").then(
            () => true,
            () => false,
          )
          if (isReader) {
            await writeFile(
              join(workspaceDir, "leads.md"),
              `- ${record.id} — "hi" — said nothing about what it was looking for\n`,
            )
            return { stdout: "read", firstByteMs: 1 }
          }
          await writeFile(join(workspaceDir, "review.md"), reviewMd(record.id))
          return { stdout: "done", firstByteMs: 1 }
        },
      }),
    })
    expect(code).toBe(0)
    expect(stderr.text).toContain("readers done: 1 pieces, 1 leads, 0 failed")
    expect(await readFile(join(out, "leads.md"), "utf8")).toContain(
      `## Found by reading\n\n- L1 ${record.id}: "hi" — said nothing about what it was looking for (main, part 1)`,
    )
  })

  describe("--lenses", () => {
    /** A runner that drops `xml` into the workspace, the way a real harness fills the template. */
    const xmlRunner =
      (xml: string, specs: RunnerSpec[] = []): ((spec: RunnerSpec) => HarnessRunner) =>
      (spec) => {
        specs.push(spec)
        return {
          run: async ({ workspaceDir }) => {
            await writeFile(join(workspaceDir, "review.xml"), xml, "utf8")
            return { stdout: "done", firstByteMs: 120, agentLog: "$ ls\n" }
          },
        }
      }

    test("RL1: --dry-run stages the lens review's four files and calls no harness", async () => {
      const code = await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        lenses: true,
        dryRun: true,
        stderr: capture(),
        stdout: capture(),
      })
      expect(code).toBe(0)
      expect(await readFile(join(out, "review.xml"), "utf8")).toContain("<review")
      expect(await readFile(join(out, "CONTRACT.md"), "utf8")).not.toBe("")
      expect(await readFile(join(out, "prompt.txt"), "utf8")).not.toBe("")
      expect(await firstRecord()).toMatchObject({ id: expect.stringMatching(/^msg-/) })
    })

    test("RL2: a grounded lens review is written and reported, with the old ten-minute default", async () => {
      await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        lenses: true,
        dryRun: true,
        stderr: capture(),
        stdout: capture(),
      })
      const record = await firstRecord()
      const specs: RunnerSpec[] = []
      const stdout = capture()
      const code = await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        lenses: true,
        env: KEYED,
        stdout,
        stderr: capture(),
        createRunner: xmlRunner(reviewXml(record.id, record.seq), specs),
      })
      expect(code).toBe(0)
      expect(stdout.text).toContain("outcome: productive")
      expect(stdout.text).toContain("Read before editing")
      expect(specs[0]?.timeoutMs).toBe(600_000)
      const payload = JSON.parse(await readFile(join(out, "review.json"), "utf8")) as object
      expect(payload).toMatchObject({ harness: "opencode", model: "opencode-go/glm-5.3-flash" })
      expect(await readFile(join(out, "agent.log"), "utf8")).toBe("$ ls\n")
    })

    test("RL3: a citation the export never produced is ungrounded, and review.json still lands", async () => {
      const stderr = capture()
      const code = await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        lenses: true,
        env: KEYED,
        stderr,
        stdout: capture(),
        createRunner: xmlRunner(reviewXml("msg-999", 999)),
      })
      expect(code).toBe(1)
      expect(stderr.text).toContain("UNGROUNDED")
      await expect(readFile(join(out, "review.json"), "utf8")).resolves.toContain("outcome")
    })

    test("RL4: XML the parser cannot recover fails with the raw file kept", async () => {
      const stderr = capture()
      const code = await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        lenses: true,
        env: KEYED,
        stderr,
        stdout: capture(),
        createRunner: xmlRunner("not xml at all"),
      })
      expect(code).toBe(1)
      expect(stderr.text).toContain("UNPARSEABLE")
      expect(await readFile(join(out, "review.xml"), "utf8")).toBe("not xml at all")
    })

    test("RL5: --prompt is refused with --lenses, since the lens review has no custom prompt", async () => {
      const stderr = capture()
      const code = await reviewSessionCommand(SESSION, {
        homedir: () => home,
        out,
        cwd,
        lenses: true,
        prompt: "my-system.md",
        stderr,
        stdout: capture(),
      })
      expect(code).toBe(1)
      expect(stderr.text).toContain("--prompt")
    })
  })
})
