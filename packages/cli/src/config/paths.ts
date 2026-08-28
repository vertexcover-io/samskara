import { homedir } from "node:os"
import { join } from "node:path"

/**
 * A profile is what keeps a dev checkout and an installed release from fighting: each one gets its
 * own directory, so they never share a token, a `config.json` or the `watch.pid` that decides
 * whether a watcher is already running. `default` keeps the original directory, so an install that
 * predates profiles needs no migration.
 */
export const profile = (): string => {
  const name = process.env.SAMSKARA_PROFILE?.trim()
  if (name === undefined || name === "") return "default"
  // The profile is pasted into the shell command `install-hooks` writes into settings.json.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`SAMSKARA_PROFILE must be letters, digits, dashes or underscores, not ${name}`)
  }
  return name
}

export const configHome = (): string =>
  process.env.SAMSKARA_HOME ??
  join(homedir(), profile() === "default" ? ".samskara" : `.samskara-${profile()}`)
export const tokenPath = (): string => join(configHome(), "token")
export const settingsPath = (): string => join(configHome(), "config.json")
export const statePath = (): string => join(configHome(), "state.json")
export const projectsPath = (): string => join(configHome(), "projects.json")
// `search` lets you name a project or repo, but the API only takes ids. This file remembers the
// name-to-id list for a few minutes, so searching by name does not have to fetch it every time.
export const filterOptionsPath = (): string => join(configHome(), "filter-options.json")
export const watchPidPath = (): string => join(configHome(), "watch.pid")
// Separate files from state.json: readCheckpoints returns empty on any validation failure,
// so one corrupt artifact entry would wipe every transcript checkpoint.
export const artifactStatePath = (): string => join(configHome(), "artifacts.json")
export const artifactQueuePath = (): string => join(configHome(), "artifact-queue.json")
export const watchLogDir = (): string => join(configHome(), "logs")
export const currentLogPath = (): string => join(watchLogDir(), "current.log")
export const watcherCrashLogPath = (): string => join(watchLogDir(), "watch.crash.log")
