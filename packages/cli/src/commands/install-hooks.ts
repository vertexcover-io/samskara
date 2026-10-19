import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { resolveCliEntry } from "../config/daemon.js"
import { profile } from "../config/paths.js"
import { reportError, resolveIo, type Writer } from "../io.js"

const hookCommandSchema = z
  .object({ type: z.string().optional(), command: z.string().optional() })
  .passthrough()
const hookMatcherSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(hookCommandSchema) })
  .passthrough()
const recordSchema = z.record(z.string(), z.unknown())
const markerBase = "samskara:ensure"

/** One marker per profile, so a dev install and a release install manage separate hook lines. */
const marker = (): string => (profile() === "default" ? markerBase : `${markerBase}:${profile()}`)

type Hook = z.infer<typeof hookCommandSchema>
type Matcher = z.infer<typeof hookMatcherSchema>
type JsonRecord = z.infer<typeof recordSchema>
type Status = "missing" | "stale" | "current"

export type HookCommandOptions = {
  readonly agent?: string
  readonly settingsPath?: string
  readonly stdout?: Writer
  readonly stderr?: Writer
}

const defaultSettingsPath = (): string => join(homedir(), ".claude", "settings.json")
const codexHome = (): string => process.env.CODEX_HOME ?? join(homedir(), ".codex")
export const detectedAgents = (): ReadonlyArray<"claude" | "codex"> => [
  ...(existsSync(join(homedir(), ".claude")) ? ["claude" as const] : []),
  ...(existsSync(codexHome()) ? ["codex" as const] : []),
]
const settingsPathFor = (options: HookCommandOptions): string =>
  options.settingsPath ??
  (options.agent === "codex" ? join(codexHome(), "hooks.json") : defaultSettingsPath())
const validAgent = (agent: string | undefined): boolean =>
  agent === undefined || ["claude", "codex", "all"].includes(agent)

const parseError = (path: string): Error => new Error(`failed to parse ${path}`)

const parseOrThrow = <T>(schema: z.ZodType<T>, value: unknown, path: string): T => {
  const result = schema.safeParse(value)
  if (!result.success) throw parseError(path)
  return result.data
}

const readSettings = (path: string): JsonRecord => {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw parseError(path)
  }
  return parseOrThrow(recordSchema, raw, path)
}

const writeSettings = (path: string, settings: JsonRecord): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

/**
 * Claude Code runs this command with its own environment, never the shell that installed it, so a
 * non-default profile has to travel inside the command itself.
 */
const managedCommand = (agent?: string): string => {
  const prefix = profile() === "default" ? "" : `SAMSKARA_PROFILE=${profile()} `
  return `${prefix}${JSON.stringify(process.execPath)} ${JSON.stringify(resolveCliEntry())} ensure${agent === "codex" ? " --agent codex" : ""} # ${marker()}`
}

// Anchored, not `includes`: `samskara:ensure` is a prefix of `samskara:ensure:dev`, so a substring
// match would let the default profile adopt every other profile's hook and overwrite it as stale.
const isManaged = (hook: Hook): hook is Hook & { command: string } =>
  hook.command?.endsWith(`# ${marker()}`) === true

const statusOf = (matchers: ReadonlyArray<Matcher>, want: string): Status => {
  const found = matchers.flatMap((matcher) => matcher.hooks.filter(isManaged))
  if (found.length === 0) return "missing"
  return found.every((hook) => hook.command === want) ? "current" : "stale"
}

const withCommand = (matchers: ReadonlyArray<Matcher>, command: string): ReadonlyArray<Matcher> =>
  matchers.map((matcher) => ({
    ...matcher,
    hooks: matcher.hooks.map((hook) => (isManaged(hook) ? { ...hook, command } : hook)),
  }))

const withoutManaged = (matchers: ReadonlyArray<Matcher>): ReadonlyArray<Matcher> =>
  matchers
    .map((matcher) => ({ ...matcher, hooks: matcher.hooks.filter((hook) => !isManaged(hook)) }))
    .filter((matcher) => matcher.hooks.length > 0)

type Current = {
  readonly settings: JsonRecord
  readonly hooks: JsonRecord
  readonly sessionStart: ReadonlyArray<Matcher>
}

const readCurrent = (path: string): Current => {
  const settings = readSettings(path)
  const hooks = settings.hooks === undefined ? {} : parseOrThrow(recordSchema, settings.hooks, path)
  const sessionStart =
    hooks.SessionStart === undefined
      ? []
      : parseOrThrow(z.array(hookMatcherSchema), hooks.SessionStart, path)
  return { settings, hooks, sessionStart }
}

const saveSessionStart = (
  path: string,
  current: Current,
  sessionStart: ReadonlyArray<Matcher>,
): void => {
  const hooks =
    sessionStart.length === 0
      ? Object.fromEntries(Object.entries(current.hooks).filter(([key]) => key !== "SessionStart"))
      : { ...current.hooks, SessionStart: sessionStart }
  writeSettings(path, { ...current.settings, hooks })
}

export const isManagedHookInstalled = (options: HookCommandOptions = {}): boolean => {
  try {
    const path = settingsPathFor(options)
    return statusOf(readCurrent(path).sessionStart, managedCommand(options.agent)) !== "missing"
  } catch {
    return false
  }
}

export const installHooksCommand = (options: HookCommandOptions = {}): number => {
  if (!validAgent(options.agent))
    return reportError(
      resolveIo(options).stderr,
      new Error("--agent must be claude, codex, or all"),
    )
  if (options.agent === "all")
    return ["claude", "codex"].reduce(
      (code, agent) => Math.max(code, installHooksCommand({ ...options, agent })),
      0,
    )
  const path = settingsPathFor(options)
  const { stdout, stderr } = resolveIo(options)

  try {
    const current = readCurrent(path)
    const command = managedCommand(options.agent)
    const status = statusOf(current.sessionStart, command)

    if (status === "current") {
      stdout.write(`hook already installed in ${path}\n`)
      return 0
    }

    saveSessionStart(
      path,
      current,
      status === "stale"
        ? withCommand(current.sessionStart, command)
        : [...current.sessionStart, { hooks: [{ type: "command", command }] }],
    )
    stdout.write(`${status === "stale" ? "repaired" : "installed"} SessionStart hook in ${path}\n`)
    if (options.agent === "codex")
      stdout.write("Open /hooks in Codex to review and trust this hook. Hooks must be enabled.\n")
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}

export const uninstallHooksCommand = (options: HookCommandOptions = {}): number => {
  if (!validAgent(options.agent))
    return reportError(
      resolveIo(options).stderr,
      new Error("--agent must be claude, codex, or all"),
    )
  if (options.agent === "all")
    return ["claude", "codex"].reduce(
      (code, agent) => Math.max(code, uninstallHooksCommand({ ...options, agent })),
      0,
    )
  const path = settingsPathFor(options)
  const { stdout, stderr } = resolveIo(options)
  if (!existsSync(path)) {
    stdout.write("nothing to uninstall\n")
    return 0
  }

  try {
    const current = readCurrent(path)
    saveSessionStart(path, current, withoutManaged(current.sessionStart))
    stdout.write(`removed samskara hook from ${path}\n`)
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}
