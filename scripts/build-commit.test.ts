import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// The footer's Commit field comes from packages/web/vite.config.ts, which asks git for HEAD and
// falls back to "unknown". The image build has no .git (.dockerignore drops it), so the sha
// has to arrive as GIT_COMMIT: a build arg the Dockerfile exposes to the web build, and one
// every workflow that builds the image passes in.

const ROOT = join(import.meta.dir, "..")
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8")

const builderStage = (dockerfile: string): string => dockerfile.split(/^FROM /m)[1] ?? ""

test("the Dockerfile's builder stage takes GIT_COMMIT before it builds the web app", () => {
  const stage = builderStage(read("Dockerfile"))
  const arg = stage.search(/^ARG GIT_COMMIT\b/m)
  const webBuild = stage.indexOf("RUN bun run --filter @samskara/web build")

  expect(webBuild).toBeGreaterThan(-1)
  expect(arg).toBeGreaterThan(-1)
  expect(arg).toBeLessThan(webBuild)
})

const imageWorkflows = (): ReadonlyArray<string> =>
  readdirSync(join(ROOT, ".github/workflows"))
    .map((name) => `.github/workflows/${name}`)
    .filter((path) => read(path).includes("docker/build-push-action"))

test("every workflow that builds the image passes the source sha as GIT_COMMIT", () => {
  const workflows = imageWorkflows()
  const missing = workflows.filter((path) => !/^\s+GIT_COMMIT=\$\{\{.+\}\}\s*$/m.test(read(path)))

  expect(workflows.length).toBeGreaterThan(0)
  expect(missing).toEqual([])
})
