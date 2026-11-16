import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"

// Workflows are parsed with the yaml package, not Bun.YAML: Bun.YAML arrived in Bun 1.2.21, and
// CI, the Dockerfile and packageManager all pin Bun 1.2.19.

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

type Step = {
  readonly id?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: { readonly "build-args"?: string }
}
type Workflow = {
  readonly jobs?: Readonly<Record<string, { readonly steps?: ReadonlyArray<Step> }>>
}

const workflowSteps = (path: string): ReadonlyArray<Step> =>
  Object.values((parse(read(path)) as Workflow).jobs ?? {}).flatMap((job) => job.steps ?? [])

const isImageBuild = (step: Step): boolean =>
  step.uses?.startsWith("docker/build-push-action@") ?? false

// The expression inside GIT_COMMIT=${{ ... }}, such as "github.sha".
const gitCommitArg = (step: Step): string | undefined =>
  (step.with?.["build-args"] ?? "")
    .split("\n")
    .map((line) => line.trim().match(/^GIT_COMMIT=\$\{\{\s*(.+?)\s*\}\}$/)?.[1])
    .find((expression) => expression !== undefined)

type ImageBuild = {
  readonly path: string
  readonly steps: ReadonlyArray<Step>
  readonly commit: string | undefined
}

const imageBuilds = (): ReadonlyArray<ImageBuild> =>
  readdirSync(join(ROOT, ".github/workflows"))
    .map((name) => `.github/workflows/${name}`)
    .flatMap((path) => {
      const steps = workflowSteps(path)
      return steps
        .filter(isImageBuild)
        .map((build) => ({ path, steps, commit: gitCommitArg(build) }))
    })

// Where each workflow finds the commit it deploys. Not github.sha in deploy.yml: on
// workflow_dispatch that is the dispatching branch's head, not the tag being deployed.
const COMMIT_SOURCES: Readonly<Record<string, string>> = {
  ".github/workflows/deploy.yml": "steps.src.outputs.sha",
  ".github/workflows/deploy-azure.yml": "github.event.deployment.sha",
}

test("every image build passes GIT_COMMIT", () => {
  const builds = imageBuilds()

  expect(builds.length).toBeGreaterThan(0)
  expect(builds.filter((build) => !build.commit).map((build) => build.path)).toEqual([])
})

test("each workflow passes the commit it deploys as GIT_COMMIT", () => {
  const known = imageBuilds().filter((build) => build.path in COMMIT_SOURCES)

  expect(known.map((build) => build.path).sort()).toEqual(Object.keys(COMMIT_SOURCES).sort())
  for (const build of known)
    expect({ [build.path]: build.commit }).toEqual({ [build.path]: COMMIT_SOURCES[build.path] })
})

test("a GIT_COMMIT read from a step output names a step that exists", () => {
  const dangling = imageBuilds().flatMap((build) => {
    const ref = build.commit?.match(/steps\.([\w-]+)\.outputs/)?.[1]
    return ref && !build.steps.some((step) => step.id === ref)
      ? [`${build.path}: steps.${ref}`]
      : []
  })

  expect(dangling).toEqual([])
})

test("deploy.yml's src step reads the checked-out tag's commit", () => {
  const src = workflowSteps(".github/workflows/deploy.yml").find((step) => step.id === "src")

  expect(src?.run).toContain("git rev-parse HEAD")
})
