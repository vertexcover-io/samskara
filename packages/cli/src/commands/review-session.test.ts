import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessRunner } from "@samskara/core"
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

/** A filled-in deliverable citing the first record the export actually produced. */
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

  /** The export's first record id and seq, read back from the dry run's session.json. */
  const firstRecord = async (): Promise<{ id: string; seq: number }> => {
    const raw = await readFile(join(out, "session.json"), "utf8")
    const parsed = JSON.parse(raw) as { records: ReadonlyArray<{ id: string; seq: number }> }
    const record = parsed.records[0]
    if (record === undefined) throw new Error("export produced no records")
    return record
  }

  /** A runner that drops `xml` into the workspace, the way a real harness fills the template. */
  const writingRunner = (xml: string): ((spec: RunnerSpec) => HarnessRunner) => {
    return () => ({
      run: async ({ workspaceDir }) => {
        await writeFile(join(workspaceDir, "review.xml"), xml, "utf8")
        return { stdout: "done", firstByteMs: 120, agentLog: "$ ls\n" }
      },
    })
  }

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-review-cmd-"))
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
      createRunner: writingRunner(reviewXml(record.id, record.seq)),
    })
    expect(code).toBe(0)
    expect(stdout.text).toContain("outcome: productive")
    expect(stdout.text).toContain("Read before editing")

    const payload = JSON.parse(await readFile(join(out, "review.json"), "utf8")) as {
      model: string
      harness: string
    }
    // The harness never gets to claim these -- the runner is the authority.
    expect(payload).toMatchObject({ harness: "opencode", model: "opencode-go/glm-5.3-flash" })
    expect(await readFile(join(out, "agent.log"), "utf8")).toBe("$ ls\n")
  })

  test("RS4: a citation the export never produced is ungrounded, and review.json still lands", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stderr,
      stdout: capture(),
      createRunner: writingRunner(reviewXml("msg-999", 999)),
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("UNGROUNDED")
    await expect(readFile(join(out, "review.json"), "utf8")).resolves.toContain("outcome")
  })

  test("RS5: XML the parser cannot recover fails with the raw file kept", async () => {
    const stderr = capture()
    const code = await reviewSessionCommand(SESSION, {
      homedir: () => home,
      out,
      env: KEYED,
      stderr,
      stdout: capture(),
      createRunner: writingRunner("not xml at all"),
    })
    expect(code).toBe(1)
    expect(stderr.text).toContain("UNPARSEABLE")
    expect(await readFile(join(out, "review.xml"), "utf8")).toBe("not xml at all")
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
})
