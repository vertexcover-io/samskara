import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { createAgentGroups } from "./agentGroups.js"

/** A stand-in agent: the leader of its own process group, as the runner spawns them. */
const startAgent = (): ChildProcess => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
  children.push(child)
  return child
}

const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
})

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const exited = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once("exit", () => resolve())
  })

describe("agent groups", () => {
  test("a worker that starts kills the agent group a killed worker recorded, and drops the record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samskara-agent-groups-"))
    const agent = startAgent()
    const pid = agent.pid as number
    createAgentGroups(dir).started(pid)

    const reaped = createAgentGroups(dir).reapLeftovers()

    expect(reaped).toBe(1)
    await exited(agent)
    expect(agent.signalCode).toBe("SIGKILL")
    expect(readdirSync(dir)).toEqual([])
  })

  test("an agent that ended is forgotten, so the next worker reaps nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "samskara-agent-groups-"))
    const agent = startAgent()
    const groups = createAgentGroups(dir)
    groups.started(agent.pid as number)
    groups.ended(agent.pid as number)

    expect(readdirSync(dir)).toEqual([])
    expect(createAgentGroups(dir).reapLeftovers()).toBe(0)
    expect(isAlive(agent.pid as number)).toBe(true)
  })

  test("a recorded pid that another process now holds is left alone, and its record dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "samskara-agent-groups-"))
    const other = startAgent()
    // What a reused pid looks like: the record's start time is not this process's.
    writeFileSync(join(dir, String(other.pid)), "Mon Jan  1 00:00:00 2024")

    expect(createAgentGroups(dir).reapLeftovers()).toBe(0)
    expect(isAlive(other.pid as number)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })
})
