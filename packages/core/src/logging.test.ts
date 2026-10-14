import { describe, expect, test, vi } from "vitest"
import { createLogger, resolveLevel } from "./logging.js"

describe("resolveLevel", () => {
  test.each([
    { id: "S2a", env: { LOG_LEVEL: "warn" }, level: "warn" },
    { id: "S2b", env: { LOG_LEVEL: "debug" }, level: "debug" },
    { id: "S3a", env: { NODE_ENV: "production" }, level: "info" },
    { id: "S3b", env: {}, level: "debug" },
    { id: "S3c", env: { NODE_ENV: "development" }, level: "debug" },
    { id: "S3d", env: { NODE_ENV: "test" }, level: "silent" },
    { id: "S3e", env: { NODE_ENV: "test", LOG_LEVEL: "debug" }, level: "debug" },
  ])("$id: $env resolves to $level", ({ env, level }) => {
    expect(resolveLevel(env)).toBe(level)
  })

  test("S2c: LOG_LEVEL=silent resolves to silent rather than warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(resolveLevel({ LOG_LEVEL: "silent" })).toBe("silent")
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  test.each([
    { id: "S4a", nodeEnv: "test", level: "silent" },
    { id: "S4b", nodeEnv: "production", level: "info" },
  ])(
    "$id: LOG_LEVEL=chatty under NODE_ENV=$nodeEnv falls back to $level and warns once",
    ({ nodeEnv, level }) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

      expect(resolveLevel({ LOG_LEVEL: "chatty", NODE_ENV: nodeEnv })).toBe(level)
      expect(warnSpy).toHaveBeenCalledOnce()

      warnSpy.mockRestore()
    },
  )
})

describe("createLogger redaction", () => {
  test("S4: token, password, nested.token, and authorization are redacted from output", () => {
    const lines: string[] = []
    const destination = {
      write: (line: string) => {
        lines.push(line)
      },
    }

    const logger = createLogger({ service: "x" }, { level: "info", destination })

    logger.info({
      token: "abc",
      password: "p",
      nested: { token: "z" },
      authorization: "Bearer x",
    })

    expect(lines).toHaveLength(1)
    const line = lines[0] ?? ""
    const parsed = JSON.parse(line) as Record<string, unknown>

    expect(parsed.token).toBe("[Redacted]")
    expect(parsed.password).toBe("[Redacted]")
    expect((parsed.nested as Record<string, unknown>).token).toBe("[Redacted]")
    expect(parsed.authorization).toBe("[Redacted]")
    expect(line).not.toContain("abc")
    expect(line).not.toContain("Bearer x")
  })
})

describe("createLogger base", () => {
  const lineFrom = (base: Parameters<typeof createLogger>[0]): Record<string, unknown> => {
    const lines: string[] = []
    const logger = createLogger(base, {
      level: "info",
      destination: {
        write: (line: string) => {
          lines.push(line)
        },
      },
    })
    logger.info("hello")
    return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>
  }

  test("S5a: every line carries pid and hostname alongside service, so two processes are tellable apart", () => {
    const parsed = lineFrom({ service: "x" })

    expect(parsed.service).toBe("x")
    expect(parsed.pid).toBe(process.pid)
    expect(typeof parsed.hostname).toBe("string")
  })

  test("S5b: a caller-supplied field wins over the defaults", () => {
    expect(lineFrom({ service: "x", pid: 1 }).pid).toBe(1)
  })
})

describe("resolveLevel with a blank value", () => {
  test("S6: LOG_LEVEL='' is unset, not invalid -- it falls back without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(resolveLevel({ LOG_LEVEL: "" })).toBe("debug")
    expect(resolveLevel({ LOG_LEVEL: "   ", NODE_ENV: "production" })).toBe("info")
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
