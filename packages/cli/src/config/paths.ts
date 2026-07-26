import { homedir } from "node:os"
import { join } from "node:path"

export const configHome = (): string => process.env.SAMSKARA_HOME ?? join(homedir(), ".samskara")
export const tokenPath = (): string => join(configHome(), "token")
export const statePath = (): string => join(configHome(), "state.json")
export const projectsPath = (): string => join(configHome(), "projects.json")
export const watchPidPath = (): string => join(configHome(), "watch.pid")
export const watchLogDir = (): string => join(configHome(), "logs")
export const currentLogPath = (): string => join(watchLogDir(), "current.log")
export const watcherCrashLogPath = (): string => join(watchLogDir(), "watch.crash.log")
