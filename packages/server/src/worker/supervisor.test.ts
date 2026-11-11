import { EventEmitter } from "node:events"
import { createLogger } from "@samskara/core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ALIVE, NEW_WORK, STOP } from "./messages.js"
import { startWorkerSupervisor, type WorkerChild } from "./supervisor.js"

const log = createLogger({ service: "supervisor-test", level: "silent" })

/** A stand-in for a forked worker: records what it was sent and how it was killed. */
class FakeChild extends EventEmitter {
  connected = true
  readonly sent: unknown[] = []
  readonly kills: Array<string | number | undefined> = []
  send(message: unknown): boolean {
    this.sent.push(message)
    return true
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    return true
  }
}

const startWithFakes = () => {
  const children: FakeChild[] = []
  const supervisor = startWorkerSupervisor({
    log,
    spawn: () => {
      const child = new FakeChild()
      children.push(child)
      return child as unknown as WorkerChild
    },
    now: () => Date.now(),
  })
  return { children, supervisor }
}

describe("worker supervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("SC11: the supervisor replaces a worker that exits", () => {
    const { children, supervisor } = startWithFakes()
    const first = children[0] as FakeChild

    first.emit("exit", 1, null)
    supervisor.notify()

    expect(children).toHaveLength(2)
    expect(children[1]?.sent).toEqual([NEW_WORK])
    expect(first.sent).toEqual([])
    supervisor.stop()
  })

  test("a worker that keeps exiting at once is restarted after a growing delay, then at once again after one stays up", () => {
    const { children, supervisor } = startWithFakes()
    const crash = () => children.at(-1)?.emit("exit", 1, null)

    crash()
    expect(children).toHaveLength(2)
    crash()
    vi.advanceTimersByTime(999)
    expect(children).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(3)
    crash()
    vi.advanceTimersByTime(1_999)
    expect(children).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(4)

    children.at(-1)?.emit("message", ALIVE)
    vi.advanceTimersByTime(60_000)
    crash()
    expect(children).toHaveLength(5)
    supervisor.stop()
  })

  test("stopping the supervisor while a restart waits starts no worker", () => {
    const { children, supervisor } = startWithFakes()
    children[0]?.emit("exit", 1, null)
    children[1]?.emit("exit", 1, null)

    supervisor.stop()
    vi.advanceTimersByTime(600_000)

    expect(children).toHaveLength(2)
  })

  test("an error from the worker process, such as a failed send, is logged and starts no other worker", () => {
    const { children, supervisor } = startWithFakes()

    expect(() => children[0]?.emit("error", new Error("write EPIPE"))).not.toThrow()

    expect(children).toHaveLength(1)
    supervisor.stop()
  })

  test("stop resolves only once the worker has exited, so the server can wait for its cleanup", async () => {
    const { children, supervisor } = startWithFakes()
    let resolved = false

    const stopped = supervisor.stop().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    children[0]?.emit("exit", 0, null)
    await stopped

    expect(resolved).toBe(true)
  })

  test("stop resolves at once when no worker is alive", async () => {
    const { children, supervisor } = startWithFakes()
    children[0]?.emit("exit", 1, null)
    children[1]?.emit("exit", 1, null)

    await expect(supervisor.stop()).resolves.toBeUndefined()
  })

  test("SC12: the supervisor replaces a worker that stops saying alive", () => {
    const { children, supervisor } = startWithFakes()
    const first = children[0] as FakeChild
    first.emit("message", ALIVE)

    vi.advanceTimersByTime(150_000)

    expect(children).toHaveLength(2)
    expect(first.kills).toEqual(["SIGKILL"])
    first.emit("exit", null, "SIGKILL")
    expect(children).toHaveLength(2)
    supervisor.stop()
  })

  test("SC13: a worker that keeps saying alive is left alone", () => {
    const { children, supervisor } = startWithFakes()
    const first = children[0] as FakeChild

    for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
      first.emit("message", ALIVE)
      vi.advanceTimersByTime(30_000)
    }

    expect(children).toHaveLength(1)
    expect(first.kills).toEqual([])
    supervisor.stop()
  })

  test("SC14: stopping the supervisor stops the worker and starts no other", () => {
    const { children, supervisor } = startWithFakes()
    const first = children[0] as FakeChild

    supervisor.stop()
    first.emit("exit", 0, null)
    vi.advanceTimersByTime(600_000)

    expect(first.sent).toEqual([STOP])
    expect(first.kills).toEqual(["SIGTERM"])
    expect(children).toHaveLength(1)
  })
})
