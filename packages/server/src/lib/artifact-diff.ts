import { MAX_DIFF_BYTES } from "@samskara/core"
import { createTwoFilesPatch } from "diff"

/** Null past the cap rather than truncated: a patch cut short reads as a file that stopped changing. */
export const renderBaseDiff = (base: string, current: string, path: string): string | null => {
  const patch = createTwoFilesPatch(path, path, base, current)
  return Buffer.byteLength(patch) > MAX_DIFF_BYTES ? null : patch
}
