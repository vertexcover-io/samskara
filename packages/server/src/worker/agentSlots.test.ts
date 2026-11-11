import type { HarnessRunInput, HarnessRunner, HarnessRunnerResult } from "@samskara/core"
import { describe, expect, test } from "vitest"
import { withAgentSlots } from "./agentSlots.js"

const input = (name: string) => ({ prompt: name }) as unknown as HarnessRunInput

/** A runner whose every call waits until the test lets it go, counting how many run at once. */
const blockingRunner = () => {
  let live = 0
  let most = 0
  const started: string[] = []
  const release = new Map<string, (outcome: "ok" | Error) => void>()
  const runner: HarnessRunner = {
    run: (call) =>
      new Promise<HarnessRunnerResult>((resolve, reject) => {
        const name = (call as unknown as { prompt: string }).prompt
        live += 1
        most = Math.max(most, live)
        started.push(name)
        release.set(name, (outcome) => {
          live -= 1
          if (outcome instanceof Error) reject(outcome)
          else resolve({ stdout: name, firstByteMs: null })
        })
      }),
  }
  return {
    runner,
    started,
    most: () => most,
    finish: (name: string, outcome: "ok" | Error = "ok") => release.get(name)?.(outcome),
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("withAgentSlots", () => {
  test("SC30: no more than the allowed agents run at once", async () => {
    const fake = blockingRunner()
    const limited = withAgentSlots(fake.runner, 2)
    const names = ["a", "b", "c", "d", "e", "f"]
    const runs = names.map((name) => limited.run(input(name)))

    for (const name of names) {
      await settle()
      fake.finish(name)
    }
    const results = await Promise.all(runs)

    expect(fake.most()).toBe(2)
    expect(results.map((result) => result.stdout)).toEqual(names)
  })

  test("SC31: a waiting call starts as soon as a slot frees, in order", async () => {
    const fake = blockingRunner()
    const limited = withAgentSlots(fake.runner, 1)
    const runs = ["A", "B", "C"].map((name) => limited.run(input(name)))

    await settle()
    expect(fake.started).toEqual(["A"])
    fake.finish("A")
    await settle()
    expect(fake.started).toEqual(["A", "B"])
    fake.finish("B")
    await settle()
    expect(fake.started).toEqual(["A", "B", "C"])
    fake.finish("C")
    await Promise.all(runs)
  })

  test("SC32: a call that throws still frees its slot", async () => {
    const fake = blockingRunner()
    const limited = withAgentSlots(fake.runner, 1)
    const a = limited.run(input("A"))
    const b = limited.run(input("B"))

    await settle()
    fake.finish("A", new Error("agent died"))
    await expect(a).rejects.toThrow("agent died")
    await settle()
    fake.finish("B")
    await expect(b).resolves.toMatchObject({ stdout: "B" })
  })

  test("after stop, a call waiting for a slot and a new call are refused without starting an agent", async () => {
    const fake = blockingRunner()
    const limited = withAgentSlots(fake.runner, 1)
    const running = limited.run(input("A"))
    const waiting = limited.run(input("B"))

    await settle()
    limited.stop()
    await expect(waiting).rejects.toThrow("agent slots stopped")
    await expect(limited.run(input("C"))).rejects.toThrow("agent slots stopped")
    fake.finish("A")
    await settle()

    await expect(running).resolves.toMatchObject({ stdout: "A" })
    expect(fake.started).toEqual(["A"])
  })
})
