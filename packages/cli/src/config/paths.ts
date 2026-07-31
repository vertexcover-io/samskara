import { homedir } from "node:os"
import { join } from "node:path"

export const configHome = (): string => process.env.SAMSKARA_HOME ?? join(homedir(), ".samskara")
export const tokenPath = (): string => join(configHome(), "token")
export const statePath = (): string => join(configHome(), "state.json")
export const projectsPath = (): string => join(configHome(), "projects.json")
export const watchPidPath = (): string => join(configHome(), "watch.pid")
// Separate files from state.json: readCheckpoints returns empty on any validation failure,
// so one corrupt artifact entry would wipe every transcript checkpoint.
export const artifactStatePath = (): string => join(configHome(), "artifacts.json")
export const artifactQueuePath = (): string => join(configHome(), "artifact-queue.json")
/** Claude Code's own backup store, outside SAMSKARA_HOME: it is written by Claude, not by us. */
export const fileHistoryDir = (): string => join(homedir(), ".claude", "file-history")
export const watchLogDir = (): string => join(configHome(), "logs")
export const currentLogPath = (): string => join(watchLogDir(), "current.log")
export const watcherCrashLogPath = (): string => join(watchLogDir(), "watch.crash.log")
