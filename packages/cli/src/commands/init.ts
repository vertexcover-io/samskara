import { readToken } from "../config/credentials.js"
import { startWatcherDaemon, watcherPid } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { normalizeUrl, readSettings, writeSettings } from "../config/settings.js"
import {
  API_URL_ENV,
  apiBase,
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  WEB_URL_ENV,
  webBase,
} from "../config.js"
import {
  errorMessage,
  interactivePrompt,
  type Prompt,
  reportError,
  resolveIo,
  type Writer,
} from "../io.js"
import { login } from "../login.js"
import { installHooksCommand, isManagedHookInstalled } from "./install-hooks.js"

export type InitOptions = {
  readonly stdout?: Writer
  readonly stderr?: Writer
  readonly server?: string
  readonly web?: string
  readonly prompt?: Prompt
}

const MAX_ATTEMPTS = 3

type UrlAsk = {
  readonly question: string
  readonly envName: string
  readonly envValue: string | undefined
  readonly flag: string | undefined
  readonly saved: string | undefined
  readonly fallback: string
}

type Io = { readonly stdout: Writer; readonly stderr: Writer }

/**
 * The environment is checked first and never written back: `SAMSKARA_API_URL` already overrides the
 * settings file at read time, so saving a different answer would store a url that nothing uses.
 */
const askForUrl = async (ask: UrlAsk, prompt: Prompt | null, io: Io): Promise<string> => {
  if (ask.envValue !== undefined) {
    io.stdout.write(`${ask.envName} is set in the environment, so ${ask.envValue} is used.\n`)
    return ask.saved ?? ask.fallback
  }
  if (ask.flag !== undefined) return normalizeUrl(ask.flag)

  const current = ask.saved ?? ask.fallback
  if (prompt === null) return current

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const answer = await prompt(ask.question, current)
    if (answer.trim() === "") return current
    try {
      return normalizeUrl(answer)
    } catch (error) {
      io.stderr.write(`${errorMessage(error)}\n`)
    }
  }
  throw new Error(`Gave up after ${MAX_ATTEMPTS} tries at ${ask.question.toLowerCase()}.`)
}

const configureUrls = async (
  options: InitOptions,
  io: Io,
  prompt: Prompt | null,
): Promise<void> => {
  const saved = readSettings()
  const apiUrl = await askForUrl(
    {
      question: "Samskara server URL",
      envName: API_URL_ENV,
      envValue: process.env[API_URL_ENV],
      flag: options.server,
      saved: saved?.apiUrl,
      fallback: DEFAULT_API_URL,
    },
    prompt,
    io,
  )
  const webUrl = await askForUrl(
    {
      question: "Samskara web URL",
      envName: WEB_URL_ENV,
      envValue: process.env[WEB_URL_ENV],
      flag: options.web,
      saved: saved?.webUrl,
      fallback: DEFAULT_WEB_URL,
    },
    prompt,
    io,
  )
  const path = await writeSettings({ apiUrl, webUrl })
  io.stdout.write(`Server ${apiBase()} and web ${webBase()} saved to ${path}.\n`)
}

export const initCommand = async (options: InitOptions = {}): Promise<number> => {
  const { stdout, stderr } = resolveIo(options)
  const io = { stdout, stderr }
  const prompt = options.prompt ?? interactivePrompt()

  try {
    await configureUrls(options, io, prompt)
  } catch (error) {
    return reportError(stderr, error)
  }

  const hadToken = (await readToken()) !== null
  if (!hadToken) {
    if ((await login({ stdout, stderr })) !== 0 || (await readToken()) === null) return 1
  } else {
    stdout.write("already logged in\n")
  }

  const hadHook = isManagedHookInstalled()
  if (installHooksCommand({ stdout, stderr }) !== 0) return 1

  const existingPid = watcherPid()
  if (existingPid === null) {
    try {
      const pid = await startWatcherDaemon()
      stdout.write(
        `Started the capture watcher (process ${pid}). Its logs are in ${watchLogDir()}.\n`,
      )
    } catch (error) {
      return reportError(stderr, error)
    }
  }

  if (hadToken && hadHook && existingPid !== null) stdout.write("nothing to do.\n")
  return 0
}
