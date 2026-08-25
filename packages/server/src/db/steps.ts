import type { Sql } from "postgres"
import { searchIndexStep } from "./searchIndexes.js"

/**
 * Database work that has to happen on every database but that drizzle-kit cannot carry: `create
 * index concurrently` is rejected inside a migration's transaction, so the search indexes have to
 * be built outside the migration journal. Steps run after `drizzle-kit migrate` on every
 * `db:migrate`, so a database is never half-set-up.
 *
 * To add one: write its module next to this file, export a `MigrationStep`, and list it below.
 * `run` converges the database and MUST be idempotent -- it runs on every migrate, including ones
 * that had no new migrations. `verify` only reads, and backs `db:verify`.
 */
export type StepContext = {
  readonly client: Sql
  readonly flags: ReadonlySet<string>
}

export type MigrationStep = {
  readonly name: string
  readonly run: (context: StepContext) => Promise<void>
  readonly verify: (context: StepContext) => Promise<void>
}

/** Registration order is execution order. */
export const MIGRATION_STEPS: ReadonlyArray<MigrationStep> = [searchIndexStep]

export const runSteps = async (
  steps: ReadonlyArray<MigrationStep>,
  context: StepContext,
  log: (line: string) => void = console.log,
): Promise<void> => {
  const verifying = context.flags.has("verify")
  for (const step of steps) {
    log(`> ${verifying ? "verifying" : "applying"} ${step.name}`)
    await (verifying ? step.verify(context) : step.run(context))
  }
}
