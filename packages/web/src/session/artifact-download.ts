import { zipSync } from "fflate"

export type DownloadableArtifact = {
  readonly id: string
  readonly relativePath: string | null
  readonly label: string | null
}

/** Everything after the last slash, or the whole label when there is no path structure. */
export const fileNameOf = (artifact: DownloadableArtifact): string => {
  const source = artifact.relativePath ?? artifact.label ?? artifact.id
  return source.split("/").pop() || artifact.id
}

/**
 * Two artifacts in one session can share a relative path only if they came from different absolute
 * paths, so a suffix keeps both rather than letting the second silently replace the first inside
 * the archive.
 */
export const uniquePaths = (
  artifacts: ReadonlyArray<DownloadableArtifact>,
): ReadonlyMap<string, string> => {
  const taken = new Set<string>()
  const byId = new Map<string, string>()

  for (const artifact of artifacts) {
    const base = artifact.relativePath ?? artifact.label ?? artifact.id
    if (!taken.has(base)) {
      taken.add(base)
      byId.set(artifact.id, base)
      continue
    }
    const dot = base.lastIndexOf(".")
    const [stem, extension] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""]
    let candidate = ""
    let n = 2
    do {
      candidate = `${stem}-${n}${extension}`
      n += 1
    } while (taken.has(candidate))
    taken.add(candidate)
    byId.set(artifact.id, candidate)
  }

  return byId
}

/** Hands bytes to the browser as a file, then releases the object URL it had to mint to do so. */
export const saveBlob = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export type FetchBytes = (artifactId: string) => Promise<Uint8Array>

/**
 * Zipped in the browser rather than server-side: every artifact's `/raw` route already enforces
 * the same per-artifact access check, so building the archive here needs no new endpoint and no
 * second authorization path to keep in step with the first.
 */
export const zipArtifacts = async (
  artifacts: ReadonlyArray<DownloadableArtifact>,
  fetchBytes: FetchBytes,
): Promise<Blob> => {
  const paths = uniquePaths(artifacts)
  const entries: Record<string, Uint8Array> = {}

  const fetched = await Promise.all(
    artifacts.map(async (artifact) => {
      try {
        return [
          paths.get(artifact.id) ?? fileNameOf(artifact),
          await fetchBytes(artifact.id),
        ] as const
      } catch {
        // One unreadable artifact must not lose the rest of the archive.
        return null
      }
    }),
  )

  for (const entry of fetched) {
    if (entry) entries[entry[0]] = entry[1]
  }

  return new Blob([zipSync(entries) as unknown as BlobPart], { type: "application/zip" })
}
