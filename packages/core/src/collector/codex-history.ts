import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type pino from "pino"
import { z } from "zod"

const legacySpawnSourceSchema = z.object({
  subAgent: z.object({ thread_spawn: z.object({ parent_thread_id: z.string().min(1) }) }),
})

export const codexThreadSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number(),
    historyMode: z.enum(["legacy", "paginated"]).default("legacy"),
    name: z.string().nullish(),
    preview: z.string().optional(),
    parentThreadId: z.string().nullish(),
    forkedFromId: z.string().nullish(),
    model: z.string().nullish(),
    modelProvider: z.string().optional(),
    agentRole: z.string().nullish(),
    agentNickname: z.string().nullish(),
    gitInfo: z.object({ sha: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough()
  .transform((thread) => {
    // Legacy history can expose spawn lineage only in its native source metadata.
    const legacy = legacySpawnSourceSchema.safeParse(thread.source)
    return {
      ...thread,
      parentThreadId:
        thread.parentThreadId ??
        (legacy.success && !thread.forkedFromId
          ? legacy.data.subAgent.thread_spawn.parent_thread_id
          : null),
    }
  })
  .readonly()

export type CodexThread = z.infer<typeof codexThreadSchema>

const itemSchema = z.object({ id: z.string(), type: z.string() }).passthrough().readonly()
export const codexItemEntrySchema = z
  .object({
    turnId: z.string(),
    item: itemSchema,
    startedAtMs: z.number().nullish(),
    completedAtMs: z.number().nullish(),
  })
  .readonly()
export type CodexItemEntry = z.infer<typeof codexItemEntrySchema>

const turnSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    startedAt: z.number().nullish(),
    completedAt: z.number().nullish(),
    items: z.array(itemSchema).default([]),
  })
  .passthrough()
  .readonly()
export type CodexTurn = z.infer<typeof turnSchema>

export type CodexHistory = {
  readonly thread: CodexThread
  readonly turns: ReadonlyArray<CodexTurn>
  readonly items: ReadonlyArray<CodexItemEntry>
}

export interface CodexHistoryReader {
  listThreads(): Promise<ReadonlyArray<CodexThread>>
  readThread(threadId: string, options?: CodexReadOptions): Promise<CodexHistory>
  close(): Promise<void>
}

export type CodexReadOptions = {
  readonly settledTurns: ReadonlySet<string>
  readonly pendingTurns: ReadonlySet<string>
}

const pageSchema = z.object({ data: z.array(z.unknown()), nextCursor: z.string().nullish() })
const responseSchema = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})
const SOURCES = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export const createCodexHistoryClient = (options: {
  readonly home: string
  readonly log: pino.Logger
  readonly command?: string
  readonly args?: ReadonlyArray<string>
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly clientVersion?: string
}): CodexHistoryReader => {
  let child: ChildProcessWithoutNullStreams | undefined
  let initialized: Promise<void> | undefined
  let nextId = 1
  let closed = false
  const pending = new Map<number, Pending>()

  const fail = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    initialized = undefined
  }

  const stop = async (): Promise<void> => {
    const current = child
    child = undefined
    fail(new Error("Codex history reader closed"))
    if (!current || current.exitCode !== null) return
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (current.pid !== undefined) process.kill(-current.pid, name)
      } catch {
        current.kill(name)
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal("SIGKILL")
        resolve()
      }, 1_000)
      current.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
      signal("SIGTERM")
    })
  }

  const send = (method: string, params: unknown): Promise<unknown> => {
    const current = child
    if (!current) return Promise.reject(new Error("Codex history reader is not running"))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex history request timed out: ${method}`))
        void stop()
      }, options.timeoutMs ?? 30_000)
      pending.set(id, { resolve, reject, timer })
      current.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) fail(error)
      })
    })
  }

  const start = async (): Promise<void> => {
    const current = spawn(
      options.command ?? "codex",
      [...(options.args ?? ["app-server", "--listen", "stdio://"])],
      {
        cwd: options.home,
        env: { ...(options.env ?? process.env), CODEX_HOME: options.home },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    )
    child = current
    current.once("error", fail)
    current.stdin.on("error", fail)
    current.once("close", () => {
      if (child === current) {
        child = undefined
        fail(new Error("Codex history process exited"))
      }
    })
    current.stderr.on("data", () => {})
    const lines = createInterface({ input: current.stdout })
    lines.on("line", (line: string) => {
      try {
        const response = responseSchema.parse(JSON.parse(line))
        const request = response.id === undefined ? undefined : pending.get(response.id)
        if (!request || response.id === undefined) return
        pending.delete(response.id)
        clearTimeout(request.timer)
        if (response.error)
          request.reject(
            new Error(
              response.error.code === -32601
                ? "Codex history methods are unavailable. Install Codex CLI 0.163.0 or newer."
                : `Codex RPC ${response.error.code}: ${response.error.message}`,
            ),
          )
        else request.resolve(response.result)
      } catch {
        fail(new Error("Invalid Codex history protocol response"))
        void stop()
      }
    })
    await send("initialize", {
      clientInfo: {
        name: "samskara",
        title: "Samskara",
        version: options.clientVersion ?? "0.0.0",
      },
      capabilities: { experimentalApi: false },
    })
    current.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
  }

  const request = async (method: string, params: unknown): Promise<unknown> => {
    if (closed) throw new Error("Codex history reader closed")
    initialized ??= start().catch(async (error: unknown) => {
      await stop()
      throw error
    })
    await initialized
    return send(method, params)
  }

  const pages = async (
    method: string,
    params: Readonly<Record<string, unknown>>,
    complete?: (data: ReadonlyArray<unknown>) => boolean,
  ): Promise<ReadonlyArray<unknown>> => {
    const data: unknown[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const page = pageSchema.parse(
        await request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }),
      )
      data.push(...page.data)
      if (!page.nextCursor || complete?.(data)) return data
      if (seen.has(page.nextCursor))
        throw new Error("Codex history returned a repeated page cursor")
      seen.add(page.nextCursor)
      cursor = page.nextCursor
    }
  }

  return {
    close: async () => {
      closed = true
      await stop()
    },
    listThreads: async () => {
      const threads = await Promise.all(
        [false, true].map((archived) =>
          pages("thread/list", {
            archived,
            modelProviders: [],
            sourceKinds: SOURCES,
            sortKey: "updated_at",
          }),
        ),
      )
      return [
        ...new Map(
          threads.flat().map((value) => {
            const thread = codexThreadSchema.parse(value)
            return [thread.id, thread] as const
          }),
        ).values(),
      ]
    },
    readThread: async (threadId, readOptions) => {
      const { thread } = z
        .object({ thread: codexThreadSchema })
        .parse(await request("thread/read", { threadId, includeTurns: false }))
      const turns = (
        await pages(
          "thread/turns/list",
          {
            threadId,
            itemsView: thread.historyMode === "legacy" ? "full" : "notLoaded",
            sortDirection: readOptions ? "desc" : "asc",
          },
          readOptions
            ? (values) => {
                const ids = new Set(values.map((value) => turnSchema.parse(value).id))
                return (
                  [...readOptions.settledTurns].some((id) => ids.has(id)) &&
                  [...readOptions.pendingTurns].every((id) => ids.has(id))
                )
              }
            : undefined,
        )
      ).map((value) => turnSchema.parse(value))
      if (readOptions) turns.reverse()
      const items =
        thread.historyMode === "legacy"
          ? turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))
          : (readOptions
              ? (
                  await Promise.all(
                    turns
                      .filter(
                        (turn, index) =>
                          index === turns.length - 1 ||
                          !readOptions.settledTurns.has(turn.id) ||
                          readOptions.pendingTurns.has(turn.id),
                      )
                      .map((turn) =>
                        pages("thread/items/list", {
                          threadId,
                          turnId: turn.id,
                          sortDirection: "asc",
                        }),
                      ),
                  )
                ).flat()
              : await pages("thread/items/list", { threadId, sortDirection: "asc" })
            ).map((value) => codexItemEntrySchema.parse(value))
      return { thread, turns, items }
    },
  }
}
