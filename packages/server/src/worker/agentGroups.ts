import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Per database: two checkouts on one machine each have their own worker and their own agents. */
export const agentGroupsDir = (databaseUrl: string): string =>
  join(
    tmpdir(),
    "samskara-agent-groups",
    createHash("sha256").update(databaseUrl).digest("hex").slice(0, 16),
  )

/**
 * When the process started, as `ps` prints it. With the pid it names one process: a pid reused
 * after a reboot or a long gap has another start time, so the record never kills a stranger.
 */
const startTime = (pid: number): string | null => {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })
    return started.trim() === "" ? null : started.trim()
  } catch {
    return null
  }
}

export type AgentGroups = {
  readonly started: (pid: number) => void
  readonly ended: (pid: number) => void
  /** Kills every group a worker before this one recorded and never saw end; how many it killed. */
  readonly reapLeftovers: () => number
}

/**
 * A file per live agent group. A worker killed with SIGKILL cannot reap its detached agents, so
 * the next worker reads what is left here, once it holds the lock, and kills those groups.
 */
export const createAgentGroups = (dir: string): AgentGroups => {
  mkdirSync(dir, { recursive: true })
  const reapOne = (name: string): boolean => {
    const recorded = readFileSync(join(dir, name), "utf8")
    rmSync(join(dir, name), { force: true })
    const pid = Number(name)
    if (startTime(pid) !== recorded) return false
    try {
      process.kill(-pid, "SIGKILL")
      return true
    } catch {
      return false
    }
  }
  return {
    started: (pid) => {
      const started = startTime(pid)
      if (started !== null) writeFileSync(join(dir, String(pid)), started)
    },
    ended: (pid) => rmSync(join(dir, String(pid)), { force: true }),
    reapLeftovers: () => readdirSync(dir).map(reapOne).filter(Boolean).length,
  }
}
