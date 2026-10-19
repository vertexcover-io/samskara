import { join } from "node:path"
import { WATCH_CYCLE_MS_ENV } from "../packages/cli/src/config.js"
import { mintCliToken } from "./fixtures/auth.js"
import { API_BASE } from "./playwright.config.js"

const PIPELINE_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 250

/**
 * Nothing in these specs sleeps for a fixed duration: the watcher's cycle boundary is
 * not observable from here, so a fixed sleep would be either flaky or needlessly slow.
 */
export const pollUntil = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  describe: (value: T) => string,
  timeoutMs = PIPELINE_TIMEOUT_MS,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let last: T = await read()
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for pipeline; last saw ${describe(last)}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    last = await read()
  }
  return last
}

export const daemonEnv = (home: string, samskaraHome: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  CODEX_SQLITE_HOME: join(home, ".codex"),
  SAMSKARA_HOME: samskaraHome,
  SAMSKARA_API_URL: API_BASE,
  [WATCH_CYCLE_MS_ENV]: "500",
})

// Fail loudly here rather than as a silent ingest timeout: an auth mismatch between the token and
// the server makes every upload 401, which otherwise looks like a broken pipeline.
export const assertApiAcceptsCliToken = async (): Promise<void> => {
  const probe = await fetch(`${API_BASE}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await mintCliToken()}`,
    },
    body: JSON.stringify({}),
  })
  if (probe.status === 401) {
    throw new Error(
      `the API at ${API_BASE} rejected an e2e CLI token (401) -- it is signing with a different JWT_SECRET than this spec mints with.`,
    )
  }
}

// Past the daemon's own 5s shutdown grace, so a SIGKILL only lands on one that is truly stuck.
const STOP_TIMEOUT_MS = 8_000

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * SIGTERM does not cancel a cycle already running, so teardown waits for the process to exit:
 * otherwise it keeps writing rows and files into the next test's freshly seeded state.
 */
export const stopWatcher = async (pid: number): Promise<void> => {
  const deadline = Date.now() + STOP_TIMEOUT_MS
  const signal = (name: NodeJS.Signals) => {
    if (isRunning(pid)) process.kill(pid, name)
  }
  signal("SIGTERM")
  while (isRunning(pid)) {
    if (Date.now() > deadline) signal("SIGKILL")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
