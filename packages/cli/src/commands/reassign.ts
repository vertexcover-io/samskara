import { resolve } from "node:path"
import { type ReassignSessionsResponse, reassignSessionsResponseSchema } from "@samskara/core"
import { z } from "zod"
import { readToken as defaultReadToken } from "../config/credentials.js"
import { getProject, type ProjectEntry, upsertProject } from "../config/projects.js"
import { apiBase as defaultApiBase } from "../config.js"
import {
  errorMessage,
  interactivePrompt,
  type Prompt,
  reportError,
  resolveIo,
  type Writer,
} from "../io.js"
import { resolveProject } from "../watcher/resolveProject.js"

const projectSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  owner: z.object({ type: z.enum(["user", "org"]), slug: z.string() }),
  sessionCount: z.number(),
})

const projectListSchema = z.object({ projects: z.array(projectSummarySchema) })

type ProjectSummary = z.infer<typeof projectSummarySchema>

export type ReassignOptions = {
  readonly path?: string
  readonly cwd?: string
  readonly to?: string
  readonly allSessions?: boolean
  readonly yes?: boolean
  readonly stdout?: Writer
  readonly stderr?: Writer
  readonly apiBase?: string
  readonly readToken?: () => Promise<string | null>
  readonly fetch?: typeof globalThis.fetch
  readonly prompt?: Prompt | null
}

type Deps = {
  readonly apiBase: string
  readonly token: string
  readonly fetch: typeof globalThis.fetch
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const unreachable = (apiBase: string, error: unknown): Error =>
  new Error(
    `Could not reach the server at ${apiBase} (${errorMessage(error)}). Start it or check SAMSKARA_API_URL, then try again.`,
  )

const listProjects = async (deps: Deps): Promise<ReadonlyArray<ProjectSummary>> => {
  let res: Response
  try {
    res = await deps.fetch(`${deps.apiBase}/api/projects`, {
      headers: { authorization: `Bearer ${deps.token}` },
    })
  } catch (error) {
    throw unreachable(deps.apiBase, error)
  }
  if (res.status === 401)
    throw new Error("The server rejected the stored login. Run `samskara login` again.")
  if (!res.ok) throw new Error(`The server answered ${res.status} while listing projects.`)
  const parsed = projectListSchema.safeParse(await res.json())
  if (!parsed.success)
    throw new Error("The server returned a project list this CLI does not recognize.")
  return parsed.data.projects
}

const postReassign = async (
  deps: Deps,
  toProjectId: string,
  body: { readonly fromProjectId: string; readonly scope: "mine" | "all" },
): Promise<ReassignSessionsResponse> => {
  let res: Response
  try {
    res = await deps.fetch(`${deps.apiBase}/api/projects/${toProjectId}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw unreachable(deps.apiBase, error)
  }
  if (res.status === 401)
    throw new Error("The server rejected the stored login. Run `samskara login` again.")
  if (res.status === 403) {
    const refusal = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(
      refusal?.error === "superAdminRequired"
        ? "Moving everyone's sessions is restricted to a Samskara super admin. Without --all-sessions this moves your own sessions."
        : "This account cannot write to that project, so nothing was moved.",
    )
  }
  if (!res.ok) throw new Error(`The server answered ${res.status} while reassigning sessions.`)
  const parsed = reassignSessionsResponseSchema.safeParse(await res.json())
  if (!parsed.success)
    throw new Error("The server returned a reassign result this CLI does not recognize.")
  return parsed.data
}

const describe = (project: ProjectSummary): string => {
  const owner = project.owner.type === "org" ? `org ${project.owner.slug}` : "you"
  const count = project.sessionCount === 1 ? "1 session" : `${project.sessionCount} sessions`
  return `${project.slug} (${owner}, ${count})`
}

const renderChoices = (stdout: Writer, choices: ReadonlyArray<ProjectSummary>): void => {
  const width = String(choices.length).length
  stdout.write("Move it to:\n")
  for (const [index, choice] of choices.entries()) {
    stdout.write(`  ${String(index + 1).padStart(width)}  ${describe(choice)}\n`)
  }
}

const choiceAt = (
  choices: ReadonlyArray<ProjectSummary>,
  answer: string,
): ProjectSummary | null => {
  const picked = Number(answer.trim())
  if (!Number.isInteger(picked)) return null
  return choices[picked - 1] ?? null
}

/** Null means "already there", which is not a failure and not a destination -- the caller stops. */
const pickDestination = async (params: {
  readonly choices: ReadonlyArray<ProjectSummary>
  readonly current: string
  readonly to: string | undefined
  readonly prompt: Prompt | null
  readonly stdout: Writer
}): Promise<ProjectSummary | null> => {
  const { choices, current, to, prompt, stdout } = params
  if (to !== undefined) {
    if (!UUID.test(to))
      throw new Error(
        `--to takes a project id. "${to}" is not one; run without --to to pick a project from a list.`,
      )
    // Checked against the current project before `choices`, which has it filtered out: otherwise
    // naming the project the folder is already on reports it as one this account cannot see.
    if (to === current) return null
    const named = choices.find((choice) => choice.id === to)
    if (!named)
      throw new Error(`No project this account can see has the id ${to}, so nothing was moved.`)
    return named
  }
  if (prompt === null)
    throw new Error(
      "There is nobody to answer the prompt here, so pass --to PROJECT_ID to name the destination.",
    )
  renderChoices(stdout, choices)
  const picked = choiceAt(choices, await prompt("Pick a number", ""))
  if (picked === null)
    throw new Error("That is not one of the numbers listed, so nothing was moved.")
  return picked
}

const confirmed = async (params: {
  readonly destination: ProjectSummary
  readonly scope: "mine" | "all"
  readonly yes: boolean
  readonly prompt: Prompt | null
}): Promise<boolean> => {
  if (params.yes) return true
  // Throws rather than answering "no": a scripted run has nobody to ask, and reporting success
  // for a move that never happened is worse than refusing. `--to` exists for exactly this case,
  // so the way through is to say `--yes` as well, not to have the flag imply consent on its own.
  if (params.prompt === null)
    throw new Error(
      "There is nobody to answer the confirmation here, so pass --yes to confirm the move up front.",
    )
  const whose =
    params.scope === "all" ? "every session, including other people's," : "your sessions"
  const answer = await params.prompt(`Move ${whose} to ${params.destination.slug}? (y/n)`, "n")
  return answer.trim().toLowerCase().startsWith("y")
}

/**
 * The registry is what the watcher reads, so the order decides which way a half-finished reassign
 * fails. Pinned first: a crash then sends new sessions to the destination, which a re-run
 * reconciles. Pinned last would leave the history moved while the folder still fed the old
 * project. Either order overwrites `projectId` before the outcome is known, so the source is
 * recorded in `pendingFrom` for the duration -- otherwise a re-run would read the destination as
 * its own source, conclude the move had landed, and never go back for the stranded sessions.
 * A restore that itself fails is reported rather than swallowed.
 */
const withPin = async <T>(params: {
  readonly slug: string
  readonly entry: ProjectEntry
  readonly source: string
  readonly destination: string
  readonly stderr: Writer
  readonly run: () => Promise<T>
}): Promise<T> => {
  await upsertProject(params.slug, {
    ...params.entry,
    projectId: params.destination,
    pinned: true,
    pendingFrom: params.source,
  })
  try {
    const result = await params.run()
    // Dropped by rebuilding the entry rather than spreading it: `params.entry` may itself carry a
    // `pendingFrom` from an earlier interrupted run, and spreading would carry that forward.
    const { pendingFrom: _settled, ...rest } = params.entry
    await upsertProject(params.slug, { ...rest, projectId: params.destination, pinned: true })
    return result
  } catch (error) {
    await upsertProject(params.slug, params.entry).catch(() => {
      params.stderr.write(
        `Could not put "${params.slug}" back to its previous project. It now points at ${params.destination}; run \`samskara reassign\` to set it where you want it.\n`,
      )
    })
    throw error
  }
}

export const reassignCommand = async (options: ReassignOptions = {}): Promise<number> => {
  const cwd = options.cwd ?? process.cwd()
  const path = resolve(cwd, options.path ?? cwd)
  const { stdout, stderr } = resolveIo(options)

  const identity = await resolveProject(path)
  if (identity === null) {
    stderr.write(`There is no directory at "${path}", so there is nothing to reassign.\n`)
    return 1
  }

  const entry = await getProject(identity.slug)
  const fromProjectId = entry?.pendingFrom ?? entry?.projectId
  if (entry === null || fromProjectId === undefined) {
    stderr.write(
      `"${identity.slug}" has no project on the server yet. Run \`samskara enable\` here first, then reassign it.\n`,
    )
    return 1
  }

  const token = await (options.readToken ?? defaultReadToken)()
  if (!token) {
    stderr.write("Not logged in. Run `samskara login` first, then reassign this folder.\n")
    return 1
  }

  const deps: Deps = {
    apiBase: options.apiBase ?? defaultApiBase(),
    token,
    fetch: options.fetch ?? globalThis.fetch,
  }
  const prompt = options.prompt === undefined ? interactivePrompt() : options.prompt
  const scope = options.allSessions === true ? "all" : "mine"

  try {
    const projects = await listProjects(deps)
    if (entry.pendingFrom !== undefined) {
      stdout.write(
        `A previous reassign of "${identity.slug}" did not finish, so its sessions are still in the project below.\n`,
      )
    }
    const current = projects.find((project) => project.id === fromProjectId)
    stdout.write(
      current === undefined
        ? `"${identity.slug}" currently reports to a project this account can no longer see.\n`
        : `"${identity.slug}" currently reports to ${describe(current)}.\n`,
    )

    const choices = projects.filter((project) => project.id !== fromProjectId)
    if (choices.length === 0) {
      stdout.write("There is no other project to move it to, so nothing was moved.\n")
      return 0
    }

    const destination = await pickDestination({
      choices,
      current: fromProjectId,
      to: options.to,
      prompt,
      stdout,
    })
    if (destination === null) {
      stdout.write("That is the project it already reports to, so nothing was moved.\n")
      return 0
    }
    if (!(await confirmed({ destination, scope, yes: options.yes === true, prompt }))) {
      stdout.write("Left where it was. Nothing was moved.\n")
      return 0
    }

    const { moved } = await withPin({
      slug: identity.slug,
      entry,
      source: fromProjectId,
      destination: destination.id,
      stderr,
      run: () => postReassign(deps, destination.id, { fromProjectId, scope }),
    })

    const sessions = moved === 1 ? "1 session" : `${moved} sessions`
    stdout.write(
      `Moved ${sessions} to "${destination.slug}". New sessions from this folder go there too.\n`,
    )
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}
