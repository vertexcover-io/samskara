import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { artifactQueuePath, artifactStatePath, configHome, statePath } from "./paths.js"

const originalHome = process.env.SAMSKARA_HOME

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
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
