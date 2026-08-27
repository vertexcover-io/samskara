import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import {
  artifactQueuePath,
  artifactStatePath,
  configHome,
  settingsPath,
  statePath,
  tokenPath,
  watchPidPath,
} from "./paths.js"

const original = {
  home: process.env.SAMSKARA_HOME,
  profile: process.env.SAMSKARA_PROFILE,
}

const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restore("SAMSKARA_HOME", original.home)
  restore("SAMSKARA_PROFILE", original.profile)
})

test("artifact paths are separate files beside state.json under the config home", () => {
  process.env.SAMSKARA_HOME = "/tmp/samskara-paths"

  expect(artifactQueuePath()).toBe(join(configHome(), "artifact-queue.json"))
  expect(artifactStatePath()).toBe(join(configHome(), "artifacts.json"))

  // Separate files, never new keys inside state.json: readCheckpoints returns empty on any
  // validation failure, so one corrupt artifact entry would wipe every transcript checkpoint.
  const distinct = new Set([statePath(), artifactQueuePath(), artifactStatePath()])
  expect(distinct.size).toBe(3)
})

test("a profile moves every per-install file, so a dev CLI cannot share prod's token, pid or urls", () => {
  delete process.env.SAMSKARA_HOME

  delete process.env.SAMSKARA_PROFILE
  const prod = [configHome(), tokenPath(), watchPidPath(), settingsPath()]

  process.env.SAMSKARA_PROFILE = "dev"
  const dev = [configHome(), tokenPath(), watchPidPath(), settingsPath()]

  // The default profile keeps today's directory, so an existing install needs no migration.
  expect(prod[0]).toBe(join(homedir(), ".samskara"))
  expect(dev[0]).toBe(join(homedir(), ".samskara-dev"))
  // A shared watch.pid is what lets one install's watcher convince the other it is already running.
  expect(new Set([...prod, ...dev]).size).toBe(8)

  // SAMSKARA_HOME stays the raw override the tests rely on: it wins over the profile.
  process.env.SAMSKARA_HOME = "/tmp/samskara-explicit"
  expect(configHome()).toBe("/tmp/samskara-explicit")
})
