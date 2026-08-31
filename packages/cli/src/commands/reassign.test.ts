import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { getProject, upsertProject } from "../config/projects.js"
import type { Prompt } from "../io.js"
import { resolveProject } from "../watcher/resolveProject.js"
import { reassignCommand } from "./reassign.js"

vi.mock("../watcher/resolveProject.js", () => ({ resolveProject: vi.fn() }))

const originalHome = process.env.SAMSKARA_HOME

const identity: ProjectIdentity = { name: "widget", slug: "acme-widget" }

const FROM = "00000000-0000-4000-8000-000000000001"
const TO = "00000000-0000-4000-8000-000000000002"
const OTHER = "00000000-0000-4000-8000-000000000003"

const listBody = {
  projects: [
    {
      id: FROM,
      name: "Widget",
      slug: "acme-widget",
      owner: { type: "org", slug: "acme" },
      sessionCount: 4,
      lastActiveAt: null,
    },
    {
      id: TO,
      name: "Scratch",
      slug: "scratch",
      owner: { type: "user", slug: "e2e-user" },
      sessionCount: 0,
      lastActiveAt: null,
    },
    {
      id: OTHER,
      name: "Other",
      slug: "other",
      owner: { type: "user", slug: "e2e-user" },
      sessionCount: 1,
      lastActiveAt: null,
    },
  ],
}

type Call = { readonly url: string; readonly body: unknown }

const stubFetch = (reassign: () => Response) => {
  const calls: Call[] = []
  const fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url)
    calls.push({ url: href, body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
    if (href.endsWith("/api/projects"))
      return new Response(JSON.stringify(listBody), { status: 200 })
    return reassign()
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const ok = (moved: number) => () => new Response(JSON.stringify({ moved }), { status: 200 })

const setup = async (entry?: { pinned?: boolean }) => {
  const home = await mkdtemp(join(tmpdir(), "samskara-reassign-"))
  process.env.SAMSKARA_HOME = home
  await upsertProject(identity.slug, {
    name: "widget",
    path: "/work/widget",
    enabled: true,
    enabledAt: "2026-07-01T00:00:00.000Z",
    projectId: FROM,
    ...(entry?.pinned === true ? { pinned: true } : {}),
  })
  const output: string[] = []
  const errors: string[] = []
  return {
    output,
    errors,
    io: {
      stdout: { write: (t: string) => output.push(t) },
      stderr: { write: (t: string) => errors.push(t) },
    },
  }
}

const base = {
  cwd: "/work/widget",
  apiBase: "http://test",
  readToken: async () => "test-token",
}

const answering = (...answers: string[]): Prompt => {
  const queue = [...answers]
  return async () => queue.shift() ?? ""
}

beforeEach(() => {
  vi.mocked(resolveProject).mockResolvedValue(identity)
})

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("reassign command", () => {
  test("picking a project from the list moves the sessions and repoints the folder at it", async () => {
    const { io, output } = await setup()
    const { fetch, calls } = stubFetch(ok(4))

    const code = await reassignCommand({
      ...base,
      ...io,
      fetch,
      prompt: answering("1", "y"),
    })

    expect(code).toBe(0)
    // The current project is filtered out, so choice 1 is the first of the remaining two.
    expect(calls[1]?.url).toBe(`http://test/api/projects/${TO}/sessions`)
    expect(calls[1]?.body).toEqual({ fromProjectId: FROM, scope: "mine" })
    expect(output.join("")).toContain('Moved 4 sessions to "scratch"')
    const entry = await getProject(identity.slug)
    expect(entry?.projectId).toBe(TO)
    expect(entry?.pinned).toBe(true)
  })

  test("the registry is pinned to the destination before the server is called, not after", async () => {
    const { io } = await setup()
    let pinnedAtCallTime: string | undefined
    let wasPinned: boolean | undefined
    const spying = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const href = String(url)
      if (href.endsWith("/api/projects") && init?.method === undefined) {
        return new Response(JSON.stringify(listBody), { status: 200 })
      }
      const entry = await getProject(identity.slug)
      pinnedAtCallTime = entry?.projectId
      wasPinned = entry?.pinned
      return new Response(JSON.stringify({ moved: 2 }), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    await reassignCommand({ ...base, ...io, fetch: spying, to: TO, yes: true })

    expect(pinnedAtCallTime).toBe(TO)
    expect(wasPinned).toBe(true)
  })

  test("a refused move puts the folder back where it was, so it is not left pointing somewhere its sessions are not", async () => {
    const { io, errors } = await setup()
    const { fetch } = stubFetch(
      () => new Response(JSON.stringify({ error: "destinationForbidden" }), { status: 403 }),
    )

    const code = await reassignCommand({ ...base, ...io, fetch, to: TO, yes: true })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("cannot write to that project")
    const entry = await getProject(identity.slug)
    expect(entry?.projectId).toBe(FROM)
    expect(entry?.pinned).toBeUndefined()
  })

  test("a rollback restores the entry exactly, leaving a folder that was already pinned still pinned", async () => {
    const { io } = await setup({ pinned: true })
    const { fetch } = stubFetch(() => {
      throw new Error("network is down")
    })

    const code = await reassignCommand({ ...base, ...io, fetch, to: TO, yes: true })

    expect(code).toBe(1)
    const entry = await getProject(identity.slug)
    expect(entry?.projectId).toBe(FROM)
    expect(entry?.pinned).toBe(true)
  })

  test("answering no moves nothing and leaves the registry untouched", async () => {
    const { io, output } = await setup()
    const { fetch, calls } = stubFetch(ok(9))

    const code = await reassignCommand({ ...base, ...io, fetch, prompt: answering("1", "n") })

    expect(code).toBe(0)
    expect(output.join("")).toContain("Left where it was")
    expect(calls).toHaveLength(1)
    expect((await getProject(identity.slug))?.projectId).toBe(FROM)
  })

  test("--all-sessions asks the server for everyone's sessions rather than only the caller's", async () => {
    const { io } = await setup()
    const { fetch, calls } = stubFetch(ok(7))

    await reassignCommand({ ...base, ...io, fetch, to: TO, allSessions: true, yes: true })

    expect(calls[1]?.body).toEqual({ fromProjectId: FROM, scope: "all" })
  })

  test("a folder that was never enabled is refused before any request is made", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-reassign-"))
    process.env.SAMSKARA_HOME = home
    const errors: string[] = []
    const { fetch, calls } = stubFetch(ok(1))

    const code = await reassignCommand({
      ...base,
      stderr: { write: (t: string) => errors.push(t) },
      fetch,
      to: TO,
      yes: true,
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("samskara enable")
    expect(calls).toHaveLength(0)
  })

  test("--to naming a project this account cannot see is refused without moving anything", async () => {
    const { io, errors } = await setup()
    const { fetch, calls } = stubFetch(ok(1))

    const code = await reassignCommand({
      ...base,
      ...io,
      fetch,
      to: "00000000-0000-4000-8000-0000000000ff",
      yes: true,
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("No project this account can see")
    expect(calls).toHaveLength(1)
    expect((await getProject(identity.slug))?.projectId).toBe(FROM)
  })

  test("--to without --yes and nobody to answer fails loudly - the scripted path must not report success for a move that never happened", async () => {
    const { io, errors } = await setup()
    const { fetch, calls } = stubFetch(ok(3))

    const code = await reassignCommand({ ...base, ...io, fetch, to: TO, prompt: null })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("--yes")
    expect(calls).toHaveLength(1)
    expect((await getProject(identity.slug))?.projectId).toBe(FROM)
    expect((await getProject(identity.slug))?.pinned).toBeUndefined()
  })

  test("--to naming the project the folder already reports to says so, rather than claiming the account cannot see it", async () => {
    const { io, output } = await setup()
    const { fetch, calls } = stubFetch(ok(3))

    const code = await reassignCommand({ ...base, ...io, fetch, to: FROM, yes: true })

    expect(code).toBe(0)
    expect(output.join("")).toContain("already reports to")
    expect(calls).toHaveLength(1)
  })

  test("an account that can see only its current project is told there is nowhere to move to", async () => {
    const { io, output } = await setup()
    const onlyCurrent = { projects: listBody.projects.filter((p) => p.id === FROM) }
    const fetch = (async (url: string | URL): Promise<Response> =>
      String(url).endsWith("/api/projects")
        ? new Response(JSON.stringify(onlyCurrent), { status: 200 })
        : new Response("{}", { status: 500 })) as unknown as typeof globalThis.fetch

    const code = await reassignCommand({ ...base, ...io, fetch, yes: true })

    expect(code).toBe(0)
    expect(output.join("")).toContain("no other project")
  })

  test("a super-admin refusal on --all-sessions is reported as such, not as a destination problem", async () => {
    const { io, errors } = await setup()
    const { fetch } = stubFetch(
      () => new Response(JSON.stringify({ error: "superAdminRequired" }), { status: 403 }),
    )

    const code = await reassignCommand({
      ...base,
      ...io,
      fetch,
      to: TO,
      allSessions: true,
      yes: true,
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("super admin")
    expect((await getProject(identity.slug))?.projectId).toBe(FROM)
  })

  test("a folder pinned to a project the account can no longer see is still rescuable - this is the wedge the pin would otherwise create", async () => {
    const { io, output } = await setup({ pinned: true })
    const gone = { projects: listBody.projects.filter((p) => p.id !== FROM) }
    const fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> =>
      String(url).endsWith("/api/projects") && init?.method === undefined
        ? new Response(JSON.stringify(gone), { status: 200 })
        : new Response(JSON.stringify({ moved: 0 }), {
            status: 200,
          })) as unknown as typeof globalThis.fetch

    const code = await reassignCommand({ ...base, ...io, fetch, to: TO, yes: true })

    expect(code).toBe(0)
    expect(output.join("")).toContain("can no longer see")
    const entry = await getProject(identity.slug)
    expect(entry?.projectId).toBe(TO)
    expect(entry?.pinned).toBe(true)
  })

  test("with nobody to answer and no --to, the command says to pass one rather than hanging on a prompt", async () => {
    const { io, errors } = await setup()
    const { fetch } = stubFetch(ok(1))

    const code = await reassignCommand({ ...base, ...io, fetch, prompt: null })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("--to")
  })

  test("a number that names no row is refused rather than moving whatever happens to sit at that index", async () => {
    const { io, errors } = await setup()
    const { fetch, calls } = stubFetch(ok(1))

    const code = await reassignCommand({ ...base, ...io, fetch, prompt: answering("9") })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("not one of the numbers listed")
    expect(calls).toHaveLength(1)
  })
})
