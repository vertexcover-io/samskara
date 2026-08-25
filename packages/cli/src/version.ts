import { readFileSync } from "node:fs"

/** `../package.json` is the manifest in every layout this file runs from: `src/version.ts` in the
 * repo, `dist/version.js` after a build, and the package root after a global install. */
export const cliVersion: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
).version
