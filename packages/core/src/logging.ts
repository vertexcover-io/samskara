import pino from "pino"

export type LogBase = Record<string, unknown> & { service: string }

type CreateLoggerOptions = {
  level?: pino.LevelWithSilent
  destination?: pino.DestinationStream
}

const isValidLevel = (value: string): value is pino.Level => value in pino.levels.values

export const resolveLevel = (env: NodeJS.ProcessEnv): pino.Level => {
  const raw = env.LOG_LEVEL
  const fallback: pino.Level = env.NODE_ENV === "production" ? "info" : "debug"

  if (raw === undefined) return fallback
  if (isValidLevel(raw)) return raw

  console.warn(`Invalid LOG_LEVEL "${raw}", falling back to "${fallback}"`)
  return fallback
}

export const createLogger = (base: LogBase, opts?: CreateLoggerOptions): pino.Logger => {
  const level = opts?.level ?? resolveLevel(process.env)

  const options: pino.LoggerOptions = {
    level,
    base,
    redact: {
      paths: [
        "token",
        "authorization",
        "*.token",
        "req.headers.authorization",
        "password",
        "secret",
      ],
      censor: "[Redacted]",
    },
  }

  return opts?.destination ? pino(options, opts.destination) : pino(options)
}
