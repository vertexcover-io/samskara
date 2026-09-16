#!/usr/bin/env bun
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { agreedVersion, MANIFESTS } from "./version.ts"

/** A tag that disagrees with the manifests would ship a tarball named after the wrong release. */
export const tagMismatch = (tag: string, version: string): string | null =>
  tag === `v${version}` ? null : `tag ${tag} does not match the packaged version ${version}`

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const main = (): void => {
  const tag = process.argv[2]
  if (tag === undefined) throw new Error("usage: bun scripts/check-release-tag.ts vX.Y.Z")
  const version = agreedVersion(
    MANIFESTS.map((manifest) => readFileSync(join(repoRoot, manifest), "utf8")),
  )
  const mismatch = tagMismatch(tag, version)
  if (mismatch !== null) throw new Error(mismatch)
  console.log(`tag ${tag} matches all ${MANIFESTS.length} manifests`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
