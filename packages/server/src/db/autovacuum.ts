import type { Sql } from "postgres"
import type { MigrationStep } from "./steps.js"

/**
 * How much of `messages` may be inserted before autovacuum refreshes the visibility map. The
 * server default of 0.2 means a fifth of the table -- around 285k rows at production size --
 * and until it runs, an index-only count of a recent session falls back to the heap for every
 * entry on an unmapped page. 0.02 costs a vacuum every ~29k inserts and keeps the newest pages,
 * which are the ones the list page reads, mapped.
 */
export const INSERT_SCALE_FACTOR = "0.02"

const SETTING = `autovacuum_vacuum_insert_scale_factor=${INSERT_SCALE_FACTOR}`

const reloptions = async (client: Sql): Promise<ReadonlyArray<string>> => {
  const [row] = await client<{ options: ReadonlyArray<string> | null }[]>`
    select coalesce(reloptions, '{}') as options
    from pg_class where oid = 'messages'::regclass
  `
  return row?.options ?? []
}

export const autovacuumStep: MigrationStep = {
  name: "messages-autovacuum",
  run: async ({ client }) => {
    // A storage parameter is part of the DDL's syntax, not a bindable value -- Postgres rejects
    // a placeholder there. INSERT_SCALE_FACTOR is a module constant, never user input.
    await client.unsafe(
      `alter table "messages" set (autovacuum_vacuum_insert_scale_factor = ${INSERT_SCALE_FACTOR})`,
    )
  },
  verify: async ({ client }) => {
    const options = await reloptions(client)
    if (!options.includes(SETTING)) {
      throw new Error(
        `messages is missing ${SETTING}; reloptions=${JSON.stringify(options)}. Run db:migrate.`,
      )
    }
  },
}
