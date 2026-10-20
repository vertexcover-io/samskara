import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { defaultDbPath } from "@samskara/core"
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
const opencodeConfigDir = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
// One file per profile, for the same reason as one marker per profile.
const opencodePluginPath = (): string =>
  join(
    opencodeConfigDir(),
    "plugins",
    profile() === "default" ? "samskara.js" : `samskara-${profile()}.js`,
  )
const AGENTS = ["claude", "codex", "opencode"] as const
export const detectedAgents = (): ReadonlyArray<(typeof AGENTS)[number]> => [
  ...(existsSync(join(homedir(), ".claude")) ? ["claude" as const] : []),
  ...(existsSync(codexHome()) ? ["codex" as const] : []),
  ...(existsSync(opencodeConfigDir()) || existsSync(defaultDbPath()) ? ["opencode" as const] : []),
]
const settingsPathFor = (options: HookCommandOptions): string => {
  if (options.settingsPath) return options.settingsPath
  if (options.agent === "codex") return join(codexHome(), "hooks.json")
  if (options.agent === "opencode") return opencodePluginPath()
  return defaultSettingsPath()
}
const validAgent = (agent: string | undefined): boolean =>
  agent === undefined || [...AGENTS, "all"].includes(agent)
const invalidAgent = (): Error => new Error("--agent must be claude, codex, opencode, or all")

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

/**
 * OpenCode has no command hooks: it loads every file in its plugins directory at startup and
 * hands each one the session's directory, so the hook is a small module that spawns `ensure`.
 */
const opencodePlugin = (): string => {
  const env =
    profile() === "default"
      ? "process.env"
      : `{ ...process.env, SAMSKARA_PROFILE: ${JSON.stringify(profile())} }`
  return [
    `// ${marker()}`,
    "// Written by `samskara install-hooks --agent opencode`. Reinstall rather than edit.",
    'import { spawn } from "node:child_process"',
    "",
    "const ensure = (cwd) => {",
    `  const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(resolveCliEntry())}, "ensure"], {`,
    `    cwd,`,
    `    env: ${env},`,
    '    stdio: "ignore",',
    "    detached: true,",
    "  })",
    '  child.on("error", () => {})',
    "  child.unref()",
    "}",
    "",
    "export const SamskaraEnsure = async ({ directory }) => {",
    "  ensure(directory)",
    "  return {",
    "    event: async ({ event }) => {",
    '      if (event.type === "session.created") ensure(directory)',
    "    },",
    "  }",
    "}",
    "",
  ].join("\n")
}

const pluginStatus = (path: string, want: string): Status | "foreign" => {
  if (!existsSync(path)) return "missing"
  const source = readFileSync(path, "utf8")
  if (source.split("\n")[0] !== `// ${marker()}`) return "foreign"
  return source === want ? "current" : "stale"
}

const notManaged = (path: string): Error =>
  new Error(`${path} exists and is not managed by samskara; move it aside first`)

const installPlugin = (path: string, { stdout, stderr }: ReturnType<typeof resolveIo>): number => {
  try {
    const source = opencodePlugin()
    const status = pluginStatus(path, source)
    if (status === "foreign") throw notManaged(path)
    if (status === "current") {
      stdout.write(`plugin already installed in ${path}\n`)
      return 0
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
    stdout.write(`${status === "stale" ? "repaired" : "installed"} OpenCode plugin in ${path}\n`)
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}

const uninstallPlugin = (
  path: string,
  { stdout, stderr }: ReturnType<typeof resolveIo>,
): number => {
  const status = pluginStatus(path, opencodePlugin())
  if (status === "missing") {
    stdout.write("nothing to uninstall\n")
    return 0
  }
  if (status === "foreign") return reportError(stderr, notManaged(path))
  unlinkSync(path)
  stdout.write(`removed samskara plugin from ${path}\n`)
  return 0
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
    if (options.agent === "opencode")
      return ["current", "stale"].includes(pluginStatus(path, opencodePlugin()))
    return statusOf(readCurrent(path).sessionStart, managedCommand(options.agent)) !== "missing"
  } catch {
    return false
  }
}

export const installHooksCommand = (options: HookCommandOptions = {}): number => {
  if (!validAgent(options.agent)) return reportError(resolveIo(options).stderr, invalidAgent())
  if (options.agent === "all")
    return AGENTS.reduce(
      (code, agent) => Math.max(code, installHooksCommand({ ...options, agent })),
      0,
    )
  if (options.agent === "opencode")
    return installPlugin(settingsPathFor(options), resolveIo(options))
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
  if (!validAgent(options.agent)) return reportError(resolveIo(options).stderr, invalidAgent())
  if (options.agent === "all")
    return AGENTS.reduce(
      (code, agent) => Math.max(code, uninstallHooksCommand({ ...options, agent })),
      0,
    )
  if (options.agent === "opencode")
    return uninstallPlugin(settingsPathFor(options), resolveIo(options))
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
