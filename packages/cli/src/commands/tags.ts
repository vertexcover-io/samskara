import { z } from "zod"
import { readToken as defaultReadToken } from "../config/credentials.js"
import { apiBase as defaultApiBase } from "../config.js"
import { sleep as defaultSleep, errorMessage, reportError, resolveIo, type Writer } from "../io.js"

const tagsResponseSchema = z.object({ tags: z.array(z.string()) })
const sessionTagsResponseSchema = z.object({
  session: z.object({ tags: z.array(z.string()) }).loose(),
})

export type TagsAction = "add" | "rm" | "ls"

export type TagsOptions = {
  readonly action: TagsAction
  readonly tags?: readonly string[]
  readonly sessionId?: string
  readonly stdout?: Writer
  readonly stderr?: Writer
  readonly apiBase?: string
  readonly readToken?: () => Promise<string | null>
  readonly fetch?: typeof globalThis.fetch
  readonly env?: Record<string, string | undefined>
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

type Deps = {
  readonly apiBase: string
  readonly token: string
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const SYNC_WINDOW_MS = 30_000
const SYNC_STEP_MS = 3_000

const unreachable = (apiBase: string, error: unknown): Error =>
  new Error(
    `Could not reach the server at ${apiBase} (${errorMessage(error)}). Start it or check SAMSKARA_API_URL, then try again.`,
  )

const resolveSessionId = (options: TagsOptions): string => {
  const explicit = options.sessionId?.trim()
  if (explicit !== undefined && explicit !== "") return explicit
  const fromEnv = (options.env ?? process.env).CLAUDE_CODE_SESSION_ID?.trim()
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  throw new Error(
    "No session id. Run this inside Claude Code, or pass --session-id SESSION_ID to name the session.",
  )
}

const refuse = (status: number, sessionId: string): Error | null => {
  if (status === 401)
    return new Error("The server rejected the stored login. Run `samskara login` again.")
  if (status === 403)
    return new Error(`This account cannot edit session ${sessionId}, so nothing was changed.`)
  if (status === 400)
    return new Error(
      "A tag must be 1 to 32 characters with no spaces or commas, so nothing was changed.",
    )
  return null
}

const send = async (
  deps: Deps,
  sessionId: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const deadline = deps.now() + SYNC_WINDOW_MS
  for (;;) {
    let res: Response
    try {
      res = await deps.fetch(`${deps.apiBase}/api/sessions/${sessionId}/tags`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${deps.token}` },
      })
    } catch (error) {
      throw unreachable(deps.apiBase, error)
    }
    if (res.status !== 404 || deps.now() >= deadline)
      return { status: res.status, body: await res.json().catch(() => null) }
    await deps.sleep(SYNC_STEP_MS)
  }
}

const render = (tags: readonly string[]): string =>
  tags.length === 0 ? "no tags\n" : `${tags.join(", ")}\n`

export const tagsCommand = async (options: TagsOptions): Promise<number> => {
  const { stdout, stderr } = resolveIo(options)
  try {
    const sessionId = resolveSessionId(options)
    const tags = options.tags ?? []
    if (options.action !== "ls" && tags.length === 0)
      throw new Error(`Name at least one tag, as in \`samskara tags ${options.action} harness\`.`)

    const token = await (options.readToken ?? defaultReadToken)()
    if (token === null)
      throw new Error("Not logged in. Run `samskara login` first, then tag this session.")

    const deps: Deps = {
      apiBase: options.apiBase ?? defaultApiBase(),
      token,
      fetch: options.fetch ?? globalThis.fetch,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
    }

    const init: RequestInit =
      options.action === "ls"
        ? { method: "GET" }
        : {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(options.action === "add" ? { add: tags } : { remove: tags }),
          }

    const { status, body } = await send(deps, sessionId, init)
    if (status === 404)
      throw new Error(
        `Session ${sessionId} is not on the server yet, or is not visible to this account. The capture watcher uploads every few seconds -- try again in a moment, or check \`samskara status\`.`,
      )
    const refusal = refuse(status, sessionId)
    if (refusal !== null) throw refusal
    if (status !== 200) throw new Error(`The server answered ${status} while reading tags.`)

    const parsed =
      options.action === "ls"
        ? tagsResponseSchema.safeParse(body)
        : sessionTagsResponseSchema.safeParse(body)
    if (!parsed.success)
      throw new Error("The server returned a tag list this CLI does not recognize.")

    stdout.write(render("tags" in parsed.data ? parsed.data.tags : parsed.data.session.tags))
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}
