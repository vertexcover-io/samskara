import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { reviveWatcher, watcherPid } from "../config/daemon.js"
import { projectsPath } from "../config/paths.js"
import { getProject, upsertProject } from "../config/projects.js"
import { writeSettings } from "../config/settings.js"
import { resolveProject } from "../watcher/resolveProject.js"
import { disableCommand } from "./disable.js"
import { enableCommand } from "./enable.js"

const originalHome = process.env.SAMSKARA_HOME

const setup = async (): Promise<{ readonly home: string; readonly output: string[] }> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-command-projects-"))
  process.env.SAMSKARA_HOME = home
  return { home, output: [] }
}

vi.mock("../config/daemon.js", () => ({
  reviveWatcher: vi.fn(() => 4321),
  watcherPid: vi.fn(() => 999),
}))
vi.mock("../watcher/resolveProject.js", () => ({ resolveProject: vi.fn() }))

const identity: ProjectIdentity = { name: "widget", slug: "acme-widget" }

const FAKE_PROJECT_ID = "00000000-0000-4000-8000-000000000001"

const fakeFetchOk = async (): Promise<Response> =>
  new Response(JSON.stringify({ id: FAKE_PROJECT_ID, owner: { type: "user", slug: "e2e-user" } }), {
    status: 201,
  })

const defaultDeps = {
  apiBase: "http://test",
  readToken: async () => "test-token",
  fetch: fakeFetchOk,
}

beforeEach(() => {
  vi.mocked(resolveProject).mockResolvedValue(identity)
  vi.mocked(watcherPid).mockReturnValue(999)
  vi.mocked(reviveWatcher).mockResolvedValue(4321)
})

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("enable command", () => {
  test.each([
    ["a new project", false, "2026-07-26T18:30:00.000Z"],
    ["an already-enabled project", true, "2026-07-25T10:00:00.000Z"],
    ["a previously-disabled project", "disabled", "2026-07-26T18:30:00.000Z"],
  ])(
    "REQ-006,REQ-008: enabling %s stores an absolute path and the right enabledAt",
    async (_case, priorState, expectedEnabledAt) => {
      const { output } = await setup()
      const stdout = { write: (text: string) => output.push(text) }
      if (priorState) {
        await enableCommand({
          ...defaultDeps,
          cwd: "/work/widget",
          now: () => new Date("2026-07-25T10:00:00.000Z"),
          stdout,
        })
        if (priorState === "disabled") await disableCommand({ cwd: "/work/widget", stdout })
      }

      const code = await enableCommand({
        ...defaultDeps,
        cwd: "/work/widget",
        now: () => new Date("2026-07-26T18:30:00.000Z"),
        stdout,
      })

      expect(code).toBe(0)
      expect(await getProject("acme-widget")).toEqual({
        name: "widget",
        path: "/work/widget",
        enabled: true,
        enabledAt: expectedEnabledAt,
        syncFrom: expectedEnabledAt,
        projectId: FAKE_PROJECT_ID,
      })
    },
  )

  test("REQ-034: enabling defaults the cutoff to now, so sessions recorded before opting in are not captured", async () => {
    const { output } = await setup()

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect((await getProject("acme-widget"))?.syncFrom).toBe("2026-07-26T18:30:00.000Z")
  })

  test("REQ-035: --all leaves the cutoff unset, so previously recorded sessions are captured too", async () => {
    const { output } = await setup()

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      all: true,
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(await getProject("acme-widget")).toMatchObject({ enabled: true })
    expect((await getProject("acme-widget"))?.syncFrom).toBeUndefined()
  })

  test("REQ-036: --sync-from pins an explicit cutoff rather than now", async () => {
    const { output } = await setup()

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      syncFrom: "2026-07-01T00:00:00.000Z",
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect((await getProject("acme-widget"))?.syncFrom).toBe("2026-07-01T00:00:00.000Z")
  })

  test("REQ-037: re-enabling an already-enabled project with no cutoff flag changes nothing", async () => {
    const { output } = await setup()
    const stdout = { write: (text: string) => output.push(text) }
    await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      stdout,
    })

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout,
    })

    expect(code).toBe(0)
    expect(await getProject("acme-widget")).toMatchObject({
      enabledAt: "2026-07-25T10:00:00.000Z",
      syncFrom: "2026-07-25T10:00:00.000Z",
    })
    expect(output.join("")).toContain("Nothing to change")
  })

  test("REQ-037b: --sync-from on an already-enabled project moves the cutoff and keeps enabledAt", async () => {
    const { output } = await setup()
    const stdout = { write: (text: string) => output.push(text) }
    await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      stdout,
    })

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      syncFrom: "2026-07-01T00:00:00.000Z",
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout,
    })

    expect(code).toBe(0)
    expect(await getProject("acme-widget")).toMatchObject({
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
      syncFrom: "2026-07-01T00:00:00.000Z",
    })
    expect(output.join("")).toContain("2026-07-01T00:00:00.000Z")
    expect(output.join("")).not.toContain("Nothing to change")
  })

  test("REQ-037c: --all on an already-enabled project clears the cutoff entirely", async () => {
    const { output } = await setup()
    const stdout = { write: (text: string) => output.push(text) }
    await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      stdout,
    })

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      all: true,
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout,
    })

    expect(code).toBe(0)
    const entry = await getProject("acme-widget")
    expect(entry?.syncFrom).toBeUndefined()
    expect(entry?.enabledAt).toBe("2026-07-25T10:00:00.000Z")
    expect(output.join("")).toContain("recorded earlier")
  })

  test("a directory that cannot be identified is refused, not registered under an invented slug", async () => {
    const { output } = await setup()
    const errors: string[] = []
    vi.mocked(resolveProject).mockResolvedValue(null)

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/gone",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("/work/gone")
  })

  test("EDGE-013: an unparseable --sync-from exits 1 and registers nothing", async () => {
    const { output } = await setup()
    const errors: string[] = []

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      syncFrom: "not-a-date",
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(await getProject("acme-widget")).toBeNull()
    expect(errors.join("")).toContain("not-a-date")
  })

  test("EDGE-017: an unparseable --sync-from is rejected even when the project is already enabled, rather than being silently ignored", async () => {
    const { output } = await setup()
    const errors: string[] = []
    const stdout = { write: (text: string) => output.push(text) }
    await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      stdout,
    })

    // The already-enabled path reports "nothing to change" -- but the user asked for a
    // cutoff. Accepting a date we cannot read would silently ignore that request.
    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      syncFrom: "not-a-date",
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout,
      stderr: { write: (text: string) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("not-a-date")
    // The original cutoff is untouched -- a rejected flag changes nothing.
    expect((await getProject("acme-widget"))?.syncFrom).toBe("2026-07-25T10:00:00.000Z")
  })

  test("EDGE-003: normalizes a relative non-git path before resolving", async () => {
    const { output } = await setup()
    vi.mocked(resolveProject).mockResolvedValue({ name: "nested", slug: "-work-nested" })

    await enableCommand({
      ...defaultDeps,
      path: "nested",
      cwd: "/work",
      stdout: { write: (text) => output.push(text) },
    })

    expect(resolveProject).toHaveBeenCalledWith("/work/nested")
    expect((await getProject("-work-nested"))?.path).toBe("/work/nested")
  })

  test.each([
    ["a stopped watcher is started", null, 4321, 4321],
    ["a running watcher is left alone", 999, null, 999],
    ["a watcher that will not stay up does not fail enable", null, null, null],
  ])("REQ-007: %s", async (_case, initialPid, revivedPid, expectedPid) => {
    const { output } = await setup()
    const daemon = { runningPid: initialPid as number | null }
    vi.mocked(watcherPid).mockImplementation(() => daemon.runningPid)
    // Mirrors the real one, which returns the running pid without starting anything. The double
    // used to skip that because the caller checked first, so it never saw an already-running case.
    vi.mocked(reviveWatcher).mockImplementation(async () => {
      if (daemon.runningPid !== null) return daemon.runningPid
      daemon.runningPid = revivedPid
      return revivedPid
    })

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: () => undefined },
    })

    expect(code).toBe(0)
    expect(daemon.runningPid).toBe(expectedPid)
    expect(await getProject("acme-widget")).toMatchObject({ enabled: true })
  })

  test("SC36: enable registers the project, stores the id, and names the org", async () => {
    const { output } = await setup()
    vi.mocked(resolveProject).mockResolvedValue({
      name: "widget",
      slug: "acme-widget",
      remote: { host: "github.com", owner: "acme", repoName: "widget" },
    })
    const requests: Array<{ body: unknown; authorization: string | undefined }> = []
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      requests.push({
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      })
      return new Response(
        JSON.stringify({ id: FAKE_PROJECT_ID, owner: { type: "org", slug: "acme" } }),
        {
          status: 201,
        },
      )
    }

    const code = await enableCommand({
      apiBase: "http://test",
      readToken: async () => "test-token",
      fetch,
      cwd: "/work/widget",
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(requests[0]).toEqual({
      body: {
        name: "widget",
        slug: "acme-widget",
        remote: { host: "github.com", owner: "acme", repoName: "widget" },
      },
      authorization: "Bearer test-token",
    })
    expect((await getProject("acme-widget"))?.projectId).toBe(FAKE_PROJECT_ID)
    expect(output.join("")).toContain("org project")
    expect(output.join("")).toContain("acme")
  })

  test("SC37: enable prints the not-member hint", async () => {
    const { output } = await setup()
    vi.mocked(resolveProject).mockResolvedValue({
      name: "widget",
      slug: "acme-widget",
      remote: { host: "github.com", owner: "acme", repoName: "widget" },
    })
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: FAKE_PROJECT_ID,
          owner: { type: "user", slug: "e2e-user" },
          reason: "notMember",
        }),
        { status: 201 },
      )

    const code = await enableCommand({
      apiBase: "http://test",
      readToken: async () => "test-token",
      fetch,
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(output.join("")).toContain("acme")
    expect(output.join("")).toContain("personal project")
    expect((await getProject("acme-widget"))?.projectId).toBe(FAKE_PROJECT_ID)
  })

  test("SC37b: enable prints the plain personal-project line when notMember arrives without a remote", async () => {
    const { output } = await setup()
    vi.mocked(resolveProject).mockResolvedValue({ name: "widget", slug: "widget" })
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: FAKE_PROJECT_ID,
          owner: { type: "user", slug: "e2e-user" },
          reason: "notMember",
        }),
        { status: 201 },
      )

    const code = await enableCommand({
      apiBase: "http://test",
      readToken: async () => "test-token",
      fetch,
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(output.join("")).not.toContain("undefined")
    expect(output.join("")).toContain("personal project")
  })

  test("SC38: enable without a token exits 1 and writes nothing", async () => {
    const { output } = await setup()
    const errors: string[] = []

    const code = await enableCommand({
      apiBase: "http://test",
      readToken: async () => null,
      fetch: fakeFetchOk,
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("samskara login")
    expect(await getProject("acme-widget")).toBeNull()
  })

  test("SC39: enable with an unreachable server exits 1 and writes nothing", async () => {
    const { output } = await setup()
    const errors: string[] = []
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED")
    }

    const code = await enableCommand({
      apiBase: "http://test-server",
      readToken: async () => "test-token",
      fetch,
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("http://test-server")
    expect(errors.join("")).toContain("SAMSKARA_API_URL")
    expect(await getProject("acme-widget")).toBeNull()
  })

  test("SC40: enable with a rejected token exits 1 with a login hint", async () => {
    const { output } = await setup()
    const errors: string[] = []
    const fetch: typeof globalThis.fetch = async () => new Response("unauthorized", { status: 401 })

    const code = await enableCommand({
      apiBase: "http://test",
      readToken: async () => "stale-token",
      fetch,
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("samskara login")
    expect(await getProject("acme-widget")).toBeNull()
  })

  test("SC41 (regression): re-running enable refreshes a missing projectId and otherwise changes nothing", async () => {
    const { output } = await setup()
    const stdout = { write: (text: string) => output.push(text) }
    await upsertProject("acme-widget", {
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
      syncFrom: "2026-07-25T10:00:00.000Z",
    })

    const first = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      now: () => new Date("2026-07-26T18:30:00.000Z"),
      stdout,
    })

    expect(first).toBe(0)
    expect(await getProject("acme-widget")).toEqual({
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
      syncFrom: "2026-07-25T10:00:00.000Z",
      projectId: FAKE_PROJECT_ID,
    })
    expect(output.join("")).not.toContain("Nothing to change")

    const second = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      now: () => new Date("2026-07-27T18:30:00.000Z"),
      stdout,
    })

    expect(second).toBe(0)
    expect(await getProject("acme-widget")).toEqual({
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
      syncFrom: "2026-07-25T10:00:00.000Z",
      projectId: FAKE_PROJECT_ID,
    })
    expect(output.join("")).toContain("Nothing to change")
  })

  test("SC23: a mismatched projects.json refuses enable, leaving the file byte-for-byte unchanged", async () => {
    const { output } = await setup()
    const errors: string[] = []
    await writeSettings({ apiUrl: "https://two.example", webUrl: "https://two.example" })
    const before = JSON.stringify({
      version: 1,
      apiBase: "https://one.example",
      projects: {
        "acme-widget": {
          name: "widget",
          path: "/work/widget",
          enabled: true,
          enabledAt: "2026-07-25T10:00:00.000Z",
          projectId: FAKE_PROJECT_ID,
        },
      },
    })
    await writeFile(projectsPath(), before, "utf8")

    const code = await enableCommand({
      ...defaultDeps,
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("https://one.example")
    expect(errors.join("")).toContain("https://two.example")
    expect(errors.join("")).toContain("samskara init --force")
    expect(await readFile(projectsPath(), "utf8")).toBe(before)
  })
})

describe("disable command", () => {
  test("REQ-010: disables a registered project without deleting its metadata", async () => {
    const { output } = await setup()
    await upsertProject("acme-widget", {
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })

    const code = await disableCommand({
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(await getProject("acme-widget")).toEqual({
      name: "widget",
      path: "/work/widget",
      enabled: false,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })
  })

  test("a directory that cannot be identified is refused rather than disabling something else", async () => {
    const { output } = await setup()
    const errors: string[] = []
    vi.mocked(resolveProject).mockResolvedValue(null)

    const code = await disableCommand({
      path: "/work/gone",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("/work/gone")
  })

  test("REQ-011,EDGE-005: unknown and already-disabled projects succeed idempotently", async () => {
    const { output } = await setup()

    const first = await disableCommand({
      path: "/work/missing",
      stdout: { write: (text) => output.push(text) },
    })
    const second = await disableCommand({
      path: "/work/missing",
      stdout: { write: (text) => output.push(text) },
    })

    expect([first, second]).toEqual([0, 0])
    expect(await getProject("acme-widget")).toBeNull()
  })

  test("SC23b: a mismatched projects.json refuses disable, leaving the file byte-for-byte unchanged", async () => {
    const { output } = await setup()
    const errors: string[] = []
    await writeSettings({ apiUrl: "https://two.example", webUrl: "https://two.example" })
    const before = JSON.stringify({
      version: 1,
      apiBase: "https://one.example",
      projects: {
        "acme-widget": {
          name: "widget",
          path: "/work/widget",
          enabled: true,
          enabledAt: "2026-07-25T10:00:00.000Z",
        },
      },
    })
    await writeFile(projectsPath(), before, "utf8")

    const code = await disableCommand({
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("samskara init --force")
    expect(await readFile(projectsPath(), "utf8")).toBe(before)
  })
})

describe("enable command with a pinned project", () => {
  const OTHER_PROJECT_ID = "00000000-0000-4000-8000-0000000000ff"

  test("a folder pinned by `samskara reassign` keeps its project when re-enabled - otherwise the next enable silently drags it back", async () => {
    const { output } = await setup()
    const stdout = { write: (text: string) => output.push(text) }
    await enableCommand({ ...defaultDeps, cwd: "/work/widget", stdout })

    // What `samskara reassign` leaves behind.
    const enabled = await getProject(identity.slug)
    if (!enabled) throw new Error("expected the project to be enabled")
    await upsertProject(identity.slug, {
      ...enabled,
      projectId: OTHER_PROJECT_ID,
      pinned: true,
    })

    await enableCommand({ ...defaultDeps, cwd: "/work/widget", stdout })

    expect((await getProject(identity.slug))?.projectId).toBe(OTHER_PROJECT_ID)
  })

  test("the pin survives an enable that also moves the cutoff - the branch that rewrites the whole entry must not drop it", async () => {
    const { output } = await setup()
    const stdout = { write: (text: string) => output.push(text) }
    await enableCommand({ ...defaultDeps, cwd: "/work/widget", stdout })
    const enabled = await getProject(identity.slug)
    if (!enabled) throw new Error("expected the project to be enabled")
    await upsertProject(identity.slug, {
      ...enabled,
      projectId: OTHER_PROJECT_ID,
      pinned: true,
    })

    await enableCommand({ ...defaultDeps, cwd: "/work/widget", all: true, stdout })

    const after = await getProject(identity.slug)
    expect(after?.projectId).toBe(OTHER_PROJECT_ID)
    expect(after?.pinned).toBe(true)
    expect(after?.syncFrom).toBeUndefined()
  })

  test("an unfinished reassign survives an enable that rewrites the entry - dropping pendingFrom would strand the sessions it names", async () => {
    const { output } = await setup()
    const stdout = { write: (text: string) => output.push(text) }
    await enableCommand({ ...defaultDeps, cwd: "/work/widget", stdout })
    const enabled = await getProject(identity.slug)
    if (!enabled) throw new Error("expected the project to be enabled")
    await upsertProject(identity.slug, {
      ...enabled,
      projectId: OTHER_PROJECT_ID,
      pinned: true,
      pendingFrom: FAKE_PROJECT_ID,
    })

    await enableCommand({ ...defaultDeps, cwd: "/work/widget", all: true, stdout })

    const after = await getProject(identity.slug)
    expect(after?.projectId).toBe(OTHER_PROJECT_ID)
    expect(after?.pendingFrom).toBe(FAKE_PROJECT_ID)
  })

  test("an unpinned folder still follows the server, so an owner decided after enabling is picked up", async () => {
    const { output } = await setup()
    const stdout = { write: (text: string) => output.push(text) }
    await enableCommand({ ...defaultDeps, cwd: "/work/widget", stdout })
    const enabled = await getProject(identity.slug)
    if (!enabled) throw new Error("expected the project to be enabled")
    await upsertProject(identity.slug, { ...enabled, projectId: OTHER_PROJECT_ID })

    await enableCommand({ ...defaultDeps, cwd: "/work/widget", stdout })

    expect((await getProject(identity.slug))?.projectId).toBe(FAKE_PROJECT_ID)
  })
})
