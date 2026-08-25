export const ARTIFACT_KINDS = ["all", "code", "docs", "media"] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const isArtifactKind = (value: string | null): value is ArtifactKind =>
  value !== null && (ARTIFACT_KINDS as ReadonlyArray<string>).includes(value)

const DOC_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "rst",
  "adoc",
  "pdf",
  "csv",
  "diff",
  "patch",
])

const MEDIA_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "mp4",
  "mov",
  "webm",
  "mp3",
  "wav",
])

const extensionOf = (path: string): string => {
  const name = path.split("/").pop() ?? ""
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : ""
}

/**
 * Grouped by what a reader wants to scan for, not by mime family: a `.diff` is prose about code and
 * belongs with docs, while an extensionless script is still code. Anything that is neither
 * recognisably prose nor media is treated as code, since that is what an agent overwhelmingly
 * writes and an unknown extension is more useful filed there than hidden.
 */
export const kindOfPath = (
  path: string | null,
  isBinary: boolean,
): Exclude<ArtifactKind, "all"> => {
  const extension = path === null ? "" : extensionOf(path)
  if (MEDIA_EXTENSIONS.has(extension)) return "media"
  if (DOC_EXTENSIONS.has(extension)) return "docs"
  // A binary with no recognised extension is media rather than unreadable "code".
  if (isBinary) return "media"
  return "code"
}

export type Filterable = {
  readonly relativePath: string | null
  readonly label: string | null
  readonly isBinary: boolean
}

export const matchesKind = (artifact: Filterable, kind: ArtifactKind): boolean =>
  kind === "all" || kindOfPath(artifact.relativePath ?? artifact.label, artifact.isBinary) === kind

/** Matched against the whole path, not just the basename: `cli/src` is how you narrow to a folder. */
export const matchesQuery = (artifact: Filterable, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (needle === "") return true
  return (artifact.relativePath ?? artifact.label ?? "").toLowerCase().includes(needle)
}

export const countByKind = (
  artifacts: ReadonlyArray<Filterable>,
): Readonly<Record<ArtifactKind, number>> => ({
  all: artifacts.length,
  code: artifacts.filter((a) => matchesKind(a, "code")).length,
  docs: artifacts.filter((a) => matchesKind(a, "docs")).length,
  media: artifacts.filter((a) => matchesKind(a, "media")).length,
})

/**
 * `text/x-typescript` is what the wire carries; "TypeScript" is what a reader wants. Strips the
 * `text/` and `application/` prefixes and the `x-` vendor marker, then maps the handful of names
 * that do not survive that on their own.
 */
const MIME_NAMES: Readonly<Record<string, string>> = {
  "text/x-typescript": "TypeScript",
  "text/tsx": "TSX",
  "text/jsx": "JSX",
  "text/javascript": "JavaScript",
  "text/markdown": "Markdown",
  "text/x-python": "Python",
  "text/x-go": "Go",
  "text/x-rust": "Rust",
  "text/x-ruby": "Ruby",
  "text/x-java": "Java",
  "text/x-shellscript": "Shell",
  "text/x-sql": "SQL",
  "text/x-diff": "Diff",
  "text/plain": "Plain text",
  "text/html": "HTML",
  "text/css": "CSS",
  "text/csv": "CSV",
  "text/yaml": "YAML",
  "text/toml": "TOML",
  "text/xml": "XML",
  "application/json": "JSON",
  "application/x-ndjson": "JSON Lines",
  "application/pdf": "PDF",
  "application/zip": "ZIP",
  "application/wasm": "WebAssembly",
  "application/octet-stream": "Binary",
  "image/svg+xml": "SVG",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "video/mp4": "MP4",
}

export const displayType = (mimeType: string | null): string => {
  if (mimeType === null) return "unknown"
  const known = MIME_NAMES[mimeType]
  if (known) return known
  const subtype = mimeType.split("/").pop() ?? mimeType
  return subtype
    .replace(/^x-/, "")
    .replace(/\+xml$/, "")
    .toUpperCase()
}

export type TreeNode<T> =
  | {
      readonly kind: "folder"
      readonly name: string
      readonly path: string
      readonly children: ReadonlyArray<TreeNode<T>>
    }
  | { readonly kind: "file"; readonly name: string; readonly path: string; readonly item: T }

type Pathed = { readonly relativePath: string | null; readonly label: string | null }

const pathOf = (item: Pathed): string => item.relativePath ?? item.label ?? ""

/**
 * A real nested tree, as a file browser shows it: folders sort before files, both alphabetically,
 * and a chain of single-child folders collapses into one row (`packages/cli/src`) so deep repo
 * layouts do not cost four rows of indentation to reach the first file.
 */
export const buildTree = <T extends Pathed>(
  artifacts: ReadonlyArray<T>,
): ReadonlyArray<TreeNode<T>> => {
  type Draft = { folders: Map<string, Draft>; files: Array<readonly [string, T]> }
  const root: Draft = { folders: new Map(), files: [] }

  for (const item of artifacts) {
    const segments = pathOf(item)
      .split("/")
      .filter((segment) => segment.length > 0)
    const name = segments.pop() ?? pathOf(item)
    let node = root
    for (const segment of segments) {
      const next = node.folders.get(segment) ?? { folders: new Map(), files: [] }
      node.folders.set(segment, next)
      node = next
    }
    node.files.push([name, item] as const)
  }

  const build = (node: Draft, prefix: string): ReadonlyArray<TreeNode<T>> => {
    const folders: Array<TreeNode<T>> = [...node.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => {
        let folderName = name
        let path = prefix === "" ? name : `${prefix}/${name}`
        let current = child
        // Collapse `a > b > c` into one `a/b/c` row while each level holds nothing else.
        while (current.files.length === 0 && current.folders.size === 1) {
          const [onlyName, onlyChild] = [...current.folders.entries()][0] as [string, Draft]
          folderName = `${folderName}/${onlyName}`
          path = `${path}/${onlyName}`
          current = onlyChild
        }
        return { kind: "folder", name: folderName, path, children: build(current, path) } as const
      })

    const files: Array<TreeNode<T>> = [...node.files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, item]) =>
          ({
            kind: "file",
            name,
            path: prefix === "" ? name : `${prefix}/${name}`,
            item,
          }) as const,
      )

    return [...folders, ...files]
  }

  return build(root, "")
}

/** Every folder path in the tree, for opening the browser fully expanded. */
export const folderPaths = <T extends Pathed>(
  nodes: ReadonlyArray<TreeNode<T>>,
): ReadonlyArray<string> =>
  nodes.flatMap((node) =>
    node.kind === "folder" ? [node.path, ...folderPaths(node.children)] : [],
  )
