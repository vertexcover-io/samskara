import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { resolveCliEntry } from "../config/daemon.js"

interface Writer {
  write(text: string): unknown
}

const hookCommandSchema = z
  .object({ type: z.string().optional(), command: z.string().optional() })
  .passthrough()
const hookMatcherSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(hookCommandSchema) })
  .passthrough()
const settingsSchema = z.record(z.string(), z.unknown())
const recordSchema = z.record(z.string(), z.unknown())
const marker = "samskara:ensure"

export type HookCommandOptions = {
  readonly settingsPath?: string
  readonly stdout?: Writer
  readonly stderr?: Writer
}

const defaultSettingsPath = (): string => join(homedir(), ".claude", "settings.json")

const parseError = (path: string): Error => new Error(`failed to parse ${path}`)

const readSettings = (path: string): z.infer<typeof settingsSchema> => {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw parseError(path)
  }
  const parsed = settingsSchema.safeParse(raw)
  if (!parsed.success) throw parseError(path)
  return parsed.data
}

const writeSettings = (path: string, settings: z.infer<typeof settingsSchema>): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

const matchersFrom = (
  value: unknown,
  path: string,
): ReadonlyArray<z.infer<typeof hookMatcherSchema>> => {
  if (value === undefined) return []
  const parsed = z.array(hookMatcherSchema).safeParse(value)
  if (!parsed.success) throw parseError(path)
  return parsed.data
}

const hooksRecordFrom = (value: unknown, path: string): z.infer<typeof recordSchema> => {
  if (value === undefined) return {}
  const parsed = recordSchema.safeParse(value)
  if (!parsed.success) throw parseError(path)
  return parsed.data
}

const managedCommand = (): string =>
  `${JSON.stringify(process.execPath)} ${JSON.stringify(resolveCliEntry())} ensure # ${marker}`

const hasManagedHook = (matchers: ReadonlyArray<z.infer<typeof hookMatcherSchema>>): boolean =>
  matchers.some((matcher) =>
    (matcher.hooks ?? []).some((hook) => hook.command?.includes(marker) === true),
  )

const readManagedHooks = (
  path: string,
): {
  readonly settings: z.infer<typeof settingsSchema>
  readonly hooks: z.infer<typeof recordSchema>
  readonly sessionStart: ReadonlyArray<z.infer<typeof hookMatcherSchema>>
} => {
  const settings = readSettings(path)
  const hooks = hooksRecordFrom(settings.hooks, path)
  return { settings, hooks, sessionStart: matchersFrom(hooks.SessionStart, path) }
}

export const isManagedHookInstalled = (options: HookCommandOptions = {}): boolean => {
  const path = options.settingsPath ?? defaultSettingsPath()
  try {
    return hasManagedHook(readManagedHooks(path).sessionStart)
  } catch {
    return false
  }
}

export const installHooksCommand = (options: HookCommandOptions = {}): number => {
  const path = options.settingsPath ?? defaultSettingsPath()
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  let current: ReturnType<typeof readManagedHooks>
  try {
    current = readManagedHooks(path)
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  if (hasManagedHook(current.sessionStart)) {
    stdout.write(`hook already installed in ${path}\n`)
    return 0
  }

  writeSettings(path, {
    ...current.settings,
    hooks: {
      ...current.hooks,
      SessionStart: [
        ...current.sessionStart,
        { hooks: [{ type: "command", command: managedCommand() }] },
      ],
    },
  })
  stdout.write(`installed SessionStart hook in ${path}\n`)
  return 0
}

export const uninstallHooksCommand = (options: HookCommandOptions = {}): number => {
  const path = options.settingsPath ?? defaultSettingsPath()
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  if (!existsSync(path)) {
    stdout.write("nothing to uninstall\n")
    return 0
  }

  let current: ReturnType<typeof readManagedHooks>
  try {
    current = readManagedHooks(path)
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const filtered = current.sessionStart
    .map((matcher) => ({
      ...matcher,
      hooks: (matcher.hooks ?? []).filter((hook) => !hook.command?.includes(marker)),
    }))
    .filter((matcher) => matcher.hooks.length > 0)
  const nextHooks =
    filtered.length === 0
      ? Object.fromEntries(Object.entries(current.hooks).filter(([key]) => key !== "SessionStart"))
      : { ...current.hooks, SessionStart: filtered }
  writeSettings(path, { ...current.settings, hooks: nextHooks })
  stdout.write(`removed samskara hook from ${path}\n`)
  return 0
}
