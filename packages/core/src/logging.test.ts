import { describe, expect, test, vi } from "vitest"
import { createLogger, resolveLevel } from "./logging.js"

describe("createLogger", () => {
  test("S1: createLogger({service:'x'}) returns a logger with working .info, .child, and child.setBindings", () => {
    const logger = createLogger({ service: "x" })

    expect(typeof logger.info).toBe("function")
    expect(typeof logger.child).toBe("function")
    expect(typeof logger.child({}).setBindings).toBe("function")
  })
})

describe("resolveLevel", () => {
  test("S2: LOG_LEVEL=warn resolves to warn", () => {
    expect(resolveLevel({ LOG_LEVEL: "warn" })).toBe("warn")
  })

  test("S2: LOG_LEVEL=debug resolves to debug", () => {
    expect(resolveLevel({ LOG_LEVEL: "debug" })).toBe("debug")
  })

  test("S3: NODE_ENV=production with no LOG_LEVEL defaults to info", () => {
    expect(resolveLevel({ NODE_ENV: "production" })).toBe("info")
  })

  test("S3: no NODE_ENV and no LOG_LEVEL defaults to debug", () => {
    expect(resolveLevel({})).toBe("debug")
  })

  test("S3: NODE_ENV=development with no LOG_LEVEL defaults to debug", () => {
    expect(resolveLevel({ NODE_ENV: "development" })).toBe("debug")
  })

  test("S3: NODE_ENV=test with no LOG_LEVEL defaults to silent", () => {
    expect(resolveLevel({ NODE_ENV: "test" })).toBe("silent")
  })

  test("S3: an explicit LOG_LEVEL still wins under NODE_ENV=test", () => {
    expect(resolveLevel({ NODE_ENV: "test", LOG_LEVEL: "debug" })).toBe("debug")
  })

  test("S2: LOG_LEVEL=silent resolves to silent rather than warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(resolveLevel({ LOG_LEVEL: "silent" })).toBe("silent")
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  test("S4a: an invalid LOG_LEVEL under NODE_ENV=test falls back to silent", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(resolveLevel({ LOG_LEVEL: "chatty", NODE_ENV: "test" })).toBe("silent")
    expect(warnSpy).toHaveBeenCalledOnce()

    warnSpy.mockRestore()
  })

  test("S4a: LOG_LEVEL=chatty in production falls back to info, warns once, does not throw", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const level = resolveLevel({ LOG_LEVEL: "chatty", NODE_ENV: "production" })

    expect(level).toBe("info")
    expect(warnSpy).toHaveBeenCalledOnce()

    warnSpy.mockRestore()
  })
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

  test("S5: every line carries pid and hostname alongside service, so two processes are tellable apart", () => {
    const parsed = lineFrom({ service: "x" })

    expect(parsed.service).toBe("x")
    expect(parsed.pid).toBe(process.pid)
    expect(typeof parsed.hostname).toBe("string")
  })

  test("S5: a caller-supplied field wins over the defaults", () => {
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
