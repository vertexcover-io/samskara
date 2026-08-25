import { EventEmitter } from "node:events"
import { describe, expect, test } from "vitest"
import { installCrashHandlers } from "./crash-handlers.js"
import { captureLogger } from "./test-logger.js"

describe("installCrashHandlers", () => {
  test("an uncaught exception is logged as fatal with its stack, then exits", () => {
    const { log, at } = captureLogger()
    const target = new EventEmitter()
    const exits: number[] = []

    installCrashHandlers(log, target, (code) => exits.push(code))
    target.emit("uncaughtException", new Error("boom"))

    const [line] = at("fatal")
    expect(line?.msg).toBe("uncaught exception")
    expect((line?.err as { stack?: string } | undefined)?.stack).toContain("boom")
    expect(exits).toEqual([1])
  })

  test("an unhandled rejection is logged as fatal but does not exit, so one bad promise cannot take the server down", () => {
    const { log, at } = captureLogger()
    const target = new EventEmitter()
    const exits: number[] = []

    installCrashHandlers(log, target, (code) => exits.push(code))
    target.emit("unhandledRejection", new Error("nope"))

    const [line] = at("fatal")
    expect(line?.msg).toBe("unhandled rejection")
    expect((line?.err as { stack?: string } | undefined)?.stack).toContain("nope")
    expect(exits).toEqual([])
  })

  test("a rejection with a non-Error reason still logs a fatal line", () => {
    const { log, at } = captureLogger()
    const target = new EventEmitter()

    installCrashHandlers(log, target, () => {})
    target.emit("unhandledRejection", "just a string")

    expect(at("fatal")).toHaveLength(1)
  })
})
