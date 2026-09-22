import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { autovacuumStep, INSERT_SCALE_FACTOR } from "./autovacuum.js"
import type { StepContext } from "./steps.js"
import { dockerAvailable, startTestDb, type TestDb } from "./testDb.js"

const SETTING = `autovacuum_vacuum_insert_scale_factor=${INSERT_SCALE_FACTOR}`

const reloptions = async (testDb: TestDb): Promise<ReadonlyArray<string>> => {
  const [row] = await testDb.client<{ readonly options: ReadonlyArray<string> | null }[]>`
    select coalesce(reloptions, '{}') as options
    from pg_class where oid = 'messages'::regclass
  `
  return row?.options ?? []
}

const context = (testDb: TestDb): StepContext => ({
  client: testDb.client,
  flags: new Set(),
})

describe.skipIf(!dockerAvailable())("autovacuumStep", () => {
  let testDb: TestDb

  beforeAll(async () => {
    testDb = await startTestDb()
  }, 120_000)

  afterAll(async () => {
    await testDb?.teardown()
  })

  test("SC20: migrating sets the insert scale factor on messages", async () => {
    expect(await reloptions(testDb)).toContain(SETTING)
  })

  test("SC21: running the step twice leaves one setting and raises nothing", async () => {
    await autovacuumStep.run(context(testDb))
    await autovacuumStep.run(context(testDb))
    const options = await reloptions(testDb)
    expect(options.filter((option) => option === SETTING)).toHaveLength(1)
  })

  test("SC22: verify rejects a database whose setting was reset", async () => {
    await autovacuumStep.run(context(testDb))
    await testDb.client.unsafe(
      `alter table "messages" reset (autovacuum_vacuum_insert_scale_factor)`,
    )

    await expect(autovacuumStep.verify(context(testDb))).rejects.toThrow(SETTING)
    await expect(autovacuumStep.verify(context(testDb))).rejects.toThrow("db:migrate")

    await autovacuumStep.run(context(testDb))
  })
})
