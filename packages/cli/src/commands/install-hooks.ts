import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { resolveCliEntry } from "../config/daemon.js"
import { type Writer, reportError, resolveIo } from "../io.js"

const hookCommandSchema = z
  .object({ type: z.string().optional(), command: z.string().optional() })
  .passthrough()
const hookMatcherSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(hookCommandSchema) })
  .passthrough()
const recordSchema = z.record(z.string(), z.unknown())
const marker = "samskara:ensure"

type Hook = z.infer<typeof hookCommandSchema>
type Matcher = z.infer<typeof hookMatcherSchema>
type JsonRecord = z.infer<typeof recordSchema>
type Status = "missing" | "stale" | "current"

export type HookCommandOptions = {
  readonly settingsPath?: string
  readonly stdout?: Writer
  readonly stderr?: Writer
}

const defaultSettingsPath = (): string => join(homedir(), ".claude", "settings.json")

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

const managedCommand = (): string =>
  `${JSON.stringify(process.execPath)} ${JSON.stringify(resolveCliEntry())} ensure # ${marker}`

const isManaged = (hook: Hook): hook is Hook & { command: string } =>
  hook.command?.includes(marker) === true

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
    const path = options.settingsPath ?? defaultSettingsPath()
    return statusOf(readCurrent(path).sessionStart, managedCommand()) !== "missing"
  } catch {
    return false
  }
}

export const installHooksCommand = (options: HookCommandOptions = {}): number => {
  const path = options.settingsPath ?? defaultSettingsPath()
  const { stdout, stderr } = resolveIo(options)

  try {
    const current = readCurrent(path)
    const command = managedCommand()
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
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}

export const uninstallHooksCommand = (options: HookCommandOptions = {}): number => {
  const path = options.settingsPath ?? defaultSettingsPath()
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
