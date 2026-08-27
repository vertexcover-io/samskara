import { resolve } from "node:path"
import {
  type CreateProjectResponse,
  createProjectResponseSchema,
  type ProjectIdentity,
} from "@samskara/core"
import { readToken as defaultReadToken } from "../config/credentials.js"
import { reviveWatcher } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { getProject, upsertProject } from "../config/projects.js"
import { apiBase as defaultApiBase } from "../config.js"
import { errorMessage, reportError, resolveIo, type Writer } from "../io.js"
import { resolveProject } from "../watcher/resolveProject.js"

type RegisterDeps = {
  readonly apiBase: string
  readonly readToken: () => Promise<string | null>
  readonly fetch: typeof globalThis.fetch
}

export type EnableOptions = {
  readonly path?: string
  readonly cwd?: string
  readonly all?: boolean
  readonly syncFrom?: string
  readonly now?: () => Date
  readonly stdout?: Writer
  readonly stderr?: Writer
  readonly apiBase?: string
  readonly readToken?: () => Promise<string | null>
  readonly fetch?: typeof globalThis.fetch
}

/** Every failure mode throws a user-facing `Error`, so `enableCommand` can hand it to `reportError` as is. */
const registerProject = async (
  deps: RegisterDeps,
  identity: ProjectIdentity,
): Promise<CreateProjectResponse> => {
  const token = await deps.readToken()
  if (!token) throw new Error("Not logged in. Run `samskara login` first, then enable this folder.")
  let res: Response
  try {
    res = await deps.fetch(`${deps.apiBase}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: identity.name,
        slug: identity.slug,
        ...(identity.remote === undefined ? {} : { remote: identity.remote }),
      }),
    })
  } catch (error) {
    throw new Error(
      `Could not reach the server at ${deps.apiBase} (${errorMessage(error)}). Start it or check SAMSKARA_API_URL, then try again.`,
    )
  }
  if (res.status === 401)
    throw new Error("The server rejected the stored login. Run `samskara login` again.")
  if (!res.ok) throw new Error(`The server answered ${res.status} while registering this folder.`)
  const parsed = createProjectResponseSchema.safeParse(await res.json())
  if (!parsed.success)
    throw new Error("The server returned a project record this CLI does not recognize.")
  return parsed.data
}

const ownerLine = (identity: ProjectIdentity, registered: CreateProjectResponse): string => {
  if (registered.reason === "notMember" && identity.remote !== undefined) {
    return `This repo belongs to the GitHub org "${identity.remote.owner}", but you are not a member there. Sessions go to your personal project "${identity.slug}".\n`
  }
  return registered.owner.type === "org"
    ? `Sessions from this folder go to the org project "${identity.slug}" owned by "${registered.owner.slug}".\n`
    : `Sessions from this folder go to your personal project "${identity.slug}".\n`
}

/**
 * `--all` opts into the whole history; an explicit `--sync-from` pins a cutoff; otherwise capture
 * starts now, so enabling an old project does not retroactively upload sessions never opted into.
 */
const cutoffFor = (options: EnableOptions, enabledAt: string): string | undefined | null => {
  if (options.all === true) return undefined
  if (options.syncFrom === undefined) return enabledAt
  const parsed = new Date(options.syncFrom)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export const enableCommand = async (options: EnableOptions = {}): Promise<number> => {
  const cwd = options.cwd ?? process.cwd()
  const path = resolve(cwd, options.path ?? cwd)
  const project = await resolveProject(path)
  const { stdout, stderr } = resolveIo(options)
  if (project === null) {
    stderr.write(`There is no directory at "${path}", so there is nothing to enable.\n`)
    return 1
  }
  const existing = await getProject(project.slug)
  const enabledAt = (options.now ?? (() => new Date()))().toISOString()
  const syncFrom = cutoffFor(options, enabledAt)

  // Validate before branching on enabled state: the already-enabled path changes nothing,
  // so accepting an unreadable date there would silently discard what the user asked for.
  if (syncFrom === null) {
    stderr.write(
      `Could not read "${options.syncFrom}" as a date, so "${project.slug}" was not enabled. Pass a date like 2026-07-01 or 2026-07-01T00:00:00Z.\n`,
    )
    return 1
  }

  const deps: RegisterDeps = {
    apiBase: options.apiBase ?? defaultApiBase(),
    readToken: options.readToken ?? defaultReadToken,
    fetch: options.fetch ?? globalThis.fetch,
  }
  let registered: CreateProjectResponse
  try {
    registered = await registerProject(deps, project)
  } catch (error) {
    return reportError(stderr, error)
  }

  // A bare re-enable is a no-op so an accidental second run cannot move the cutoff forward and
  // silently drop sessions. A cutoff flag is not accidental, so it wins even when already
  // enabled -- otherwise the only way to widen a cutoff is `disable` then `enable`.
  const askedForCutoff = options.all === true || options.syncFrom !== undefined
  if (existing?.enabled === true && !askedForCutoff) {
    if (existing.projectId === registered.id) {
      stdout.write(
        `Capture is already enabled for "${project.slug}" (since ${existing.enabledAt}). Nothing to change.\n`,
      )
    } else {
      // The owner was decided after this project was already enabled.
      await upsertProject(project.slug, { ...existing, projectId: registered.id })
      stdout.write(ownerLine(project, registered))
    }
  } else {
    // Re-enabling keeps the original opt-in date: `enabledAt` records when capture was first
    // asked for, and only `syncFrom` says what is eligible.
    const since = existing?.enabled === true ? existing.enabledAt : enabledAt
    await upsertProject(project.slug, {
      name: project.name,
      path,
      enabled: true,
      enabledAt: since,
      ...(syncFrom === undefined ? {} : { syncFrom }),
      projectId: registered.id,
    })
    stdout.write(
      syncFrom === undefined
        ? `Capture enabled for "${project.slug}" at ${path}, including sessions recorded earlier.\n`
        : `Capture enabled for "${project.slug}" at ${path}, for sessions started after ${syncFrom}.\n`,
    )
    stdout.write(ownerLine(project, registered))
  }

  // `reviveWatcher` returns the running pid when there is one, so the message says what is true
  // afterwards rather than claiming this call started it.
  const pid = await reviveWatcher()
  if (pid === null) {
    stderr.write(
      `The capture watcher could not be started, so sessions will not be recorded. See the logs in ${watchLogDir()} for the reason.\n`,
    )
  } else {
    stdout.write(
      `The capture watcher is running (process ${pid}). Its logs are in ${watchLogDir()}.\n`,
    )
  }
  return 0
}
