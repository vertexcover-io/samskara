import * as learningsRepo from "../../repositories/learnings.repo.js"
import { type LearningRunDeps, startLearningRun } from "./run.js"

/** How often an org gets a learning run on its own. */
export const LEARNING_RUN_EVERY_MS = 7 * 24 * 60 * 60 * 1000

/** How often the schedule looks for an org that is due. */
const CHECK_EVERY_MS = 60 * 60 * 1000

/**
 * The weekly learning run: every hour, each due org gets a run, one org at a time, since every
 * run starts two agents. A check still going when the next hour comes is not doubled.
 */
export const startLearningSchedule = (
  deps: LearningRunDeps,
  options: {
    readonly harnessPath: string
    readonly now?: () => Date
    readonly checkEveryMs?: number
  },
): { readonly tick: () => Promise<void>; readonly stop: () => void } => {
  const now = options.now ?? (() => new Date())
  let ticking = false
  const tick = async (): Promise<void> => {
    if (ticking) return
    ticking = true
    try {
      for (const orgId of await learningsRepo.orgsDueForRun(
        deps.db,
        new Date(now().getTime() - LEARNING_RUN_EVERY_MS),
      )) {
        const started = await startLearningRun(deps, orgId, { harnessPath: options.harnessPath })
        if (started.status === "started") await started.finished
      }
    } catch (error) {
      deps.log.error({ err: error }, "learning schedule check failed")
    } finally {
      ticking = false
    }
  }
  const timer = setInterval(() => void tick(), options.checkEveryMs ?? CHECK_EVERY_MS)
  timer.unref()
  return { tick, stop: () => clearInterval(timer) }
}
