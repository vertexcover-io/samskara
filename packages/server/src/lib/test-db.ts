import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { createDb, type Db } from "../db/client.js"

export const packageDir = fileURLToPath(new URL("../..", import.meta.url))

/**
 * The server suite runs wherever a Postgres is reachable — a local server (no Docker; the
 * samskara role has CREATEDB) or, failing that, a testcontainers container. `DATABASE_URL` is
 * the opt-in for the local path: when set, that server is used and Docker is never touched.
 */
export const localServerUrl = (): string | undefined =>
  process.env.SAMSKARA_TEST_DATABASE_URL ?? process.env.DATABASE_URL

export const dockerAvailable = (): boolean => {
  if (localServerUrl() !== undefined) return false
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export type TestDbHandle = {
  readonly db: Db
  readonly url: string
  readonly stop: () => Promise<void>
}

const migrateTo = (url: string): void => {
  execFileSync("bun", ["run", "db:migrate"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  })
}

/**
 * A throwaway database on the server `baseUrl` names, migrated and dropped by the caller —
 * the same contract e2e/run.ts uses, so a local run never touches the dev database's data.
 */
export const throwawayOnLocalServer = async (baseUrl: string): Promise<TestDbHandle> => {
  const admin = postgres(baseUrl, { max: 1 })
  const name = `samskara_test_${process.pid}_${Math.random().toString(16).slice(2, 8)}`
  await admin.unsafe(`create database "${name}"`)
  await admin.end()

  const url = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`)
  migrateTo(url)
  const created = createDb(url)
  return {
    db: created.db,
    url,
    stop: async () => {
      await created.client.end()
      const dropper = postgres(baseUrl, { max: 1 })
      await dropper.unsafe(`drop database if exists "${name}" with (force)`)
      await dropper.end()
    },
  }
}
