import type pino from "pino"

export type CrashTarget = Pick<NodeJS.EventEmitter, "on">

/**
 * After an uncaught exception the process state is unknowable, so it logs and goes. An unhandled
 * rejection is merely *handled* -- adding a listener suppresses Node's default terminate, which is
 * what we want on a server: one orphaned promise must not take every in-flight request down too.
 */
export const installCrashHandlers = (
  log: pino.Logger,
  target: CrashTarget = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void => {
  target.on("uncaughtException", (err: unknown) => {
    log.fatal({ err }, "uncaught exception")
    exit(1)
  })
  target.on("unhandledRejection", (err: unknown) => {
    log.fatal({ err }, "unhandled rejection")
  })
}
