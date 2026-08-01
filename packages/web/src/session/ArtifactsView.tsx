import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { rawArtifactUrl } from "../api/artifacts.js"
import type { CapturedArtifact } from "../api/types.js"
import { Code } from "./Code.js"
import { Markdown } from "./Markdown.js"
import { fileNameOf, saveBlob, zipArtifacts } from "./artifact-download.js"
import {
  type ArtifactKind,
  type TreeNode,
  buildTree,
  countByKind,
  displayType,
  folderPaths,
  isArtifactKind,
  matchesKind,
} from "./artifact-filter.js"
import type { Artifact } from "./records.js"

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

type Medium = "markdown" | "code" | "diff" | "image" | "video" | "unknown"

const EXTENSION_MEDIA: Readonly<Record<string, Medium>> = {
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
}

/**
 * Both sources render through the same browser. A captured file carries `relativePath`, which is
 * also what tells the two apart on screen.
 */
type Exhibit = {
  readonly id: string
  readonly label: string | null
  readonly title: string | null
  readonly timestamp: string | null
  readonly mimeType: string | null
  readonly agent: string | null
  readonly access: "granted" | "denied"
  readonly content: string | null
  readonly mediaUrl: string | null
  /** Set for captured text artifacts, whose body the list route withholds; fetched on demand. */
  readonly textUrl: string | null
  /** The pre-session copy, when one resolved. Absent for created files and editedUnknownBase. */
  readonly baseUrl: string | null
  /** Bytes as captured. Null for a frame-link, which points outside the capture. */
  readonly downloadUrl: string | null
  readonly isBinary: boolean
  readonly relativePath: string | null
  readonly diff: string | null
  readonly oldFragment: string | null
  readonly changeKind: string | null
  readonly editCount: number | null
}

const isCaptured = (value: Artifact | CapturedArtifact): value is CapturedArtifact =>
  "relativePath" in value

const fromFrameLink = (artifact: Artifact): Exhibit => ({
  id: artifact.id,
  label: artifact.path ?? artifact.url,
  title: artifact.title,
  timestamp: artifact.timestamp,
  mimeType: artifact.mimeType ?? null,
  agent: artifact.agent ?? null,
  access: artifact.access ?? "granted",
  content: artifact.content ?? null,
  mediaUrl: artifact.url,
  textUrl: null,
  baseUrl: null,
  downloadUrl: null,
  isBinary: false,
  relativePath: null,
  diff: null,
  oldFragment: null,
  changeKind: null,
  editCount: null,
})

const fromCaptured = (artifact: CapturedArtifact): Exhibit => ({
  id: artifact.id,
  label: artifact.relativePath,
  title: null,
  timestamp: artifact.lastSeenAt,
  mimeType: artifact.mimeType,
  agent: null,
  access: "granted",
  // The list route withholds text bodies; the diff and the fragment are what it does send. A
  // created file has neither, so its body is fetched from the raw route on demand.
  content: null,
  mediaUrl: artifact.isBinary ? rawArtifactUrl(artifact.id) : null,
  textUrl: artifact.isBinary ? null : rawArtifactUrl(artifact.id),
  baseUrl:
    artifact.isBinary || artifact.changeKind !== "edited"
      ? null
      : rawArtifactUrl(artifact.id, "base"),
  downloadUrl: rawArtifactUrl(artifact.id),
  isBinary: artifact.isBinary,
  relativePath: artifact.relativePath,
  diff: artifact.diff,
  oldFragment: artifact.oldFragment,
  changeKind: artifact.changeKind,
  editCount: artifact.editCount,
})

const toExhibit = (artifact: Artifact | CapturedArtifact): Exhibit =>
  isCaptured(artifact) ? fromCaptured(artifact) : fromFrameLink(artifact)

const extensionOf = (exhibit: Exhibit): string => {
  const name = (exhibit.label ?? "").split("/").pop() ?? ""
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : ""
}

const mediumOf = (exhibit: Exhibit): Medium => {
  const mime = exhibit.mimeType ?? ""
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime === "text/x-diff") return "diff"
  if (mime === "text/markdown") return "markdown"

  const extension = extensionOf(exhibit)
  const byExtension = EXTENSION_MEDIA[extension]
  if (byExtension) return byExtension
  return extension === "" ? "unknown" : "code"
}

const MEDIUM_LABEL: Readonly<Record<Medium, string>> = {
  markdown: "Markdown",
  code: "Source",
  diff: "Diff",
  image: "Image",
  video: "Video",
  unknown: "Unknown",
}

const CHANGE_LABEL: Readonly<Record<string, string>> = {
  created: "Created",
  edited: "Edited",
  editedUnknownBase: "Edited",
  deleted: "Deleted",
}

const nameOf = (exhibit: Exhibit): string => {
  if (exhibit.label === null) return exhibit.title ?? "unavailable exhibit"
  // A captured file is listed by its full relative path -- that is what identifies it in the repo.
  if (exhibit.relativePath !== null) return exhibit.relativePath
  return exhibit.label.split("/").pop() ?? exhibit.label
}

const kindOf = (exhibit: Exhibit): string => {
  if (exhibit.access === "denied") return "Permission denied"
  const medium = mediumOf(exhibit)
  if (medium === "unknown") return "Metadata unavailable"
  const extension = extensionOf(exhibit)
  const media = extension === "" ? MEDIUM_LABEL[medium] : `${MEDIUM_LABEL[medium]} · ${extension}`
  const change = exhibit.changeKind === null ? null : CHANGE_LABEL[exhibit.changeKind]
  return change === null || change === undefined ? media : `${change} · ${media}`
}

const Notice = ({
  tone,
  title,
  children,
}: { tone: "err" | "faded"; title: string; children: React.ReactNode }) => (
  <div
    className={`border border-dashed p-4 ${tone === "err" ? "border-err/50 bg-panel" : "border-faded bg-panel"}`}
  >
    <p
      className={`text-[0.656rem] font-semibold uppercase tracking-[0.12em] ${tone === "err" ? "text-err" : "text-faded"}`}
    >
      {title}
    </p>
    <p className="mt-2 text-ink-soft">{children}</p>
  </div>
)

const DiffBody = ({ content }: { content: string }) => (
  <pre className="overflow-x-auto border border-rule bg-panel p-3 font-mono text-[0.72rem] leading-relaxed">
    {content.split("\n").map((line, index) => {
      const tone = line.startsWith("+")
        ? "bg-ok/10 text-ok"
        : line.startsWith("-")
          ? "bg-err/10 text-err"
          : line.startsWith("@@")
            ? "text-custody"
            : "text-ink-2"
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
        <div key={index} className={`whitespace-pre-wrap break-words ${tone}`}>
          {line === "" ? " " : line}
        </div>
      )
    })}
  </pre>
)

/**
 * About one in five edited files resolves no base, so this is an ordinary outcome and reads as
 * one -- the excerpt is what the edit replaced, not a diff and not a failure.
 */
const ReplacedExcerpt = ({ fragment }: { fragment: string }) => (
  <section>
    <h4 className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
      Replaced excerpt
    </h4>
    <p className="mt-1 text-[0.72rem] text-faded">
      No pre-session copy of this file was found, so this is the text the edit replaced rather than
      a diff.
    </p>
    <pre className="mt-2 overflow-x-auto border border-rule bg-panel p-3 font-mono text-[0.72rem] leading-relaxed">
      {fragment}
    </pre>
  </section>
)

type FetchState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string }
  | { readonly status: "failed" }

/**
 * A created file has no diff and no replaced excerpt -- its body is the only thing there is to
 * show, and the list route deliberately withholds it so a session's worth of metadata costs no
 * blobs. The raw route already serves text as `text/plain` with `nosniff`, so it is fetched here
 * rather than adding a second detail-fetch path that would return the same bytes.
 */
const FetchedText = ({ url, render }: { url: string; render: (text: string) => JSX.Element }) => {
  const [state, setState] = useState<FetchState>({ status: "loading" })

  useEffect(() => {
    let live = true
    setState({ status: "loading" })
    fetch(url, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("unreadable"))))
      .then((text) => live && setState({ status: "ready", text }))
      .catch(() => live && setState({ status: "failed" }))
    return () => {
      live = false
    }
  }, [url])

  if (state.status === "loading") return <output className="block text-faded">Loading…</output>
  if (state.status === "failed") {
    return (
      <Notice tone="faded" title="Contents unavailable">
        This artifact's contents could not be read back. Its provenance is recorded above.
      </Notice>
    )
  }
  return render(state.text)
}

type ArtifactViewId = "diff" | "split" | "current" | "base"

/** Two panes on a wide screen, stacked below it -- 320px must not scroll horizontally. */
const SideBySide = ({
  base,
  current,
  path,
}: { base: string; current: string; path: string | null }) => (
  <div className="grid grid-cols-1 gap-3 min-[900px]:grid-cols-2">
    <section className="min-w-0">
      <h4 className="mb-1 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
        Before
      </h4>
      <Code source={base} path={path} />
    </section>
    <section className="min-w-0">
      <h4 className="mb-1 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
        After
      </h4>
      <Code source={current} path={path} />
    </section>
  </div>
)

/** Fetches both sides before rendering, so the panes never show mismatched halves. */
const SideBySideLoader = ({
  baseUrl,
  currentUrl,
  path,
}: { baseUrl: string; currentUrl: string; path: string | null }) => (
  <FetchedText
    url={baseUrl}
    render={(base) => (
      <FetchedText
        url={currentUrl}
        render={(current) => <SideBySide base={base} current={current} path={path} />}
      />
    )}
  />
)

const ViewTabs = ({
  views,
  active,
  onSelect,
}: {
  views: ReadonlyArray<readonly [ArtifactViewId, string]>
  active: ArtifactViewId
  onSelect: (view: ArtifactViewId) => void
}) => (
  <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Artifact view">
    {views.map(([id, label]) => (
      <button
        key={id}
        type="button"
        role="tab"
        aria-selected={id === active}
        onClick={() => onSelect(id)}
        className={`border px-2 py-1 font-mono text-[0.6875rem] transition-colors ${
          id === active
            ? "border-custody bg-panel text-custody"
            : "border-rule text-ink-soft hover:bg-panel"
        }`}
      >
        {label}
      </button>
    ))}
  </div>
)

/**
 * An edited file opens on its diff -- that is what changed, and the whole reason the base was
 * captured. Everything else stays reachable rather than being the only thing on offer.
 */
const EditedBody = ({ exhibit }: { exhibit: Exhibit }) => {
  const [view, setView] = useState<ArtifactViewId>("diff")
  const path = exhibit.relativePath ?? exhibit.label

  const views: Array<readonly [ArtifactViewId, string]> = [["diff", "Diff"]]
  if (exhibit.baseUrl !== null) views.push(["split", "Side by side"])
  if (exhibit.textUrl !== null) views.push(["current", "Current"])
  if (exhibit.baseUrl !== null) views.push(["base", "Base"])

  const pane = () => {
    if (view === "current" && exhibit.textUrl !== null) {
      return (
        <FetchedText url={exhibit.textUrl} render={(text) => <Code source={text} path={path} />} />
      )
    }
    if (view === "base" && exhibit.baseUrl !== null) {
      return (
        <FetchedText url={exhibit.baseUrl} render={(text) => <Code source={text} path={path} />} />
      )
    }
    if (view === "split" && exhibit.baseUrl !== null && exhibit.textUrl !== null) {
      return <SideBySideLoader baseUrl={exhibit.baseUrl} currentUrl={exhibit.textUrl} path={path} />
    }
    if (exhibit.diff !== null) return <DiffBody content={exhibit.diff} />
    if (exhibit.oldFragment !== null) return <ReplacedExcerpt fragment={exhibit.oldFragment} />
    return (
      <Notice tone="faded" title="No diff captured">
        No pre-session copy of this file resolved, so there is nothing to compare against.
      </Notice>
    )
  }

  return (
    <>
      {views.length > 1 ? <ViewTabs views={views} active={view} onSelect={setView} /> : null}
      {pane()}
    </>
  )
}

const Body = ({ exhibit }: { exhibit: Exhibit }) => {
  if (exhibit.access === "denied") {
    return (
      <Notice tone="err" title="Permission denied">
        This artifact was filed but its contents were withheld. Provenance is recorded above.
      </Notice>
    )
  }

  const medium = mediumOf(exhibit)
  const source = exhibit.mediaUrl ?? undefined

  if (medium === "image") {
    return source === undefined ? (
      <Notice tone="faded" title="No image captured">
        The image was referenced but its bytes were not stored.
      </Notice>
    ) : (
      <img src={source} alt={nameOf(exhibit)} className="max-w-full border border-rule bg-panel" />
    )
  }

  if (medium === "video") {
    return source === undefined ? (
      <Notice tone="faded" title="Video not captured">
        Only metadata was recorded for this clip. The media itself lives outside the capture.
      </Notice>
    ) : (
      // biome-ignore lint/a11y/useMediaCaption: captured session media has no caption track
      <video controls src={source} className="max-w-full border border-rule bg-panel" />
    )
  }

  // An edit carries a before AND an after, so it gets the switcher rather than one fixed pane.
  if (exhibit.diff !== null || exhibit.oldFragment !== null || exhibit.baseUrl !== null) {
    return <EditedBody exhibit={exhibit} />
  }

  const asMedium = (text: string) => {
    if (medium === "markdown") return <Markdown source={text} />
    if (medium === "diff") return <DiffBody content={text} />
    return <Code source={text} path={exhibit.relativePath ?? exhibit.label} />
  }

  if (exhibit.content === null && exhibit.textUrl !== null) {
    return <FetchedText url={exhibit.textUrl} render={asMedium} />
  }

  if (exhibit.content === null) {
    return (
      <Notice tone="faded" title="No contents captured">
        The contents of this exhibit were not captured. Its provenance is recorded above.
      </Notice>
    )
  }

  if (medium === "markdown") return <Markdown source={exhibit.content} />
  if (medium === "diff") return <DiffBody content={exhibit.content} />

  return <Code source={exhibit.content} path={exhibit.relativePath ?? exhibit.label} />
}

/** UTC, minute precision -- the capture stamps ISO strings and the seconds carry no meaning here. */
const formatStamp = (iso: string | null): string =>
  iso === null ? "unavailable" : `${iso.slice(0, 16).replace("T", " ")} UTC`

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
    <b className="font-semibold text-custody">{label}</b> {children}
  </span>
)

/**
 * Only facts the capture actually holds. A single edit is the norm, so the count earns a cell only
 * when it says something a reader could not already infer -- that the file was touched more than
 * once during the session.
 */
const Provenance = ({ exhibit }: { exhibit: Exhibit }) => (
  <div className="flex flex-wrap border-b border-rule">
    <Fact label="Last written">{formatStamp(exhibit.timestamp)}</Fact>
    <Fact label="By">{exhibit.agent ?? "Claude"}</Fact>
    <Fact label="Type">{displayType(exhibit.mimeType)}</Fact>
    {exhibit.editCount !== null && exhibit.editCount > 1 ? (
      <Fact label="Edits">{exhibit.editCount}</Fact>
    ) : null}
    {exhibit.downloadUrl === null ? null : (
      <a
        href={exhibit.downloadUrl}
        download={fileNameOf(exhibit)}
        aria-label={`Download ${fileNameOf(exhibit)}`}
        title={`Download ${fileNameOf(exhibit)}`}
        className="ml-auto flex items-center gap-1 border-l border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft transition-colors hover:bg-panel-2 hover:text-custody"
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.5]"
        >
          <path d="M8 2v8m0 0L5 7m3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" strokeLinecap="round" />
        </svg>
        Download
      </a>
    )}
  </div>
)

const Viewer = ({ exhibit }: { exhibit: Exhibit }) => (
  <section aria-label="Artifact viewer" className="min-w-0 bg-panel-2">
    <header className="border-b border-rule bg-panel px-4 py-3">
      <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
        {kindOf(exhibit)}
      </p>
      <h3 className="mt-1 break-all font-mono text-[0.8125rem] font-semibold">
        {exhibit.label ?? <Unavailable />}
      </h3>
      {exhibit.title === null ? null : (
        <p className="mt-1 font-mono text-[0.6875rem] text-faded">{exhibit.title}</p>
      )}
    </header>

    <Provenance exhibit={exhibit} />

    <div className="max-h-[70vh] overflow-auto p-4">
      <Body exhibit={exhibit} />
    </div>
  </section>
)

const FolderIcon = ({ open }: { open: boolean }) => (
  <svg
    viewBox="0 0 16 16"
    aria-hidden="true"
    className="h-3 w-3 shrink-0 fill-none stroke-current stroke-[1.5]"
  >
    {open ? (
      <path
        d="M2 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V6M2 12.5 3.8 7.5h11L13 12.5H2Z"
        strokeLinejoin="round"
      />
    ) : (
      <path
        d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Z"
        strokeLinejoin="round"
      />
    )}
  </svg>
)

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    viewBox="0 0 16 16"
    aria-hidden="true"
    className={`h-3 w-3 shrink-0 fill-none stroke-current stroke-[1.5] transition-transform ${open ? "rotate-90" : ""}`}
  >
    <path d="m6 4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

type TreeProps = {
  readonly nodes: ReadonlyArray<TreeNode<Exhibit>>
  readonly depth: number
  readonly selectedId: string | undefined
  readonly openFolders: ReadonlySet<string>
  readonly onToggle: (path: string) => void
  readonly onSelect: (id: string) => void
}

/** A file browser: folders collapse, files select, indentation follows nesting depth. */
const Tree = ({ nodes, depth, selectedId, openFolders, onToggle, onSelect }: TreeProps) => (
  <ul className={depth === 0 ? "" : ""}>
    {nodes.map((node) => {
      const indent = { paddingLeft: `${depth * 0.75 + 0.5}rem` }
      if (node.kind === "folder") {
        const open = openFolders.has(node.path)
        return (
          <li key={`folder:${node.path}`}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onToggle(node.path)}
              style={indent}
              className="flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-[0.6875rem] text-ink-soft transition-colors hover:bg-panel-2"
            >
              <Chevron open={open} />
              <FolderIcon open={open} />
              <span className="truncate">{node.name}</span>
            </button>
            {open ? (
              <Tree
                nodes={node.children}
                depth={depth + 1}
                selectedId={selectedId}
                openFolders={openFolders}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        )
      }
      return (
        <li key={node.item.id}>
          <button
            type="button"
            aria-current={node.item.id === selectedId}
            onClick={() => onSelect(node.item.id)}
            style={indent}
            className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-[0.6875rem] transition-colors hover:bg-panel-2 ${
              node.item.id === selectedId
                ? "bg-panel-2 font-semibold text-custody shadow-[inset_2px_0_0_var(--color-stamp)]"
                : "text-ink-2"
            }`}
          >
            <span className="w-3 shrink-0" />
            <span className="truncate">{node.name}</span>
            {node.item.access === "denied" ? (
              <span className="ml-auto shrink-0 font-semibold text-err">locked</span>
            ) : null}
          </button>
        </li>
      )
    })}
  </ul>
)

export const ArtifactsView = ({
  artifacts,
}: { artifacts: ReadonlyArray<Artifact | CapturedArtifact> }) => {
  // Selection and filter live in the URL so an artifact view is shareable and survives reload.
  const [params, setParams] = useSearchParams()
  const listRef = useRef<HTMLUListElement | null>(null)
  const [zipping, setZipping] = useState(false)

  const all = artifacts.map(toExhibit)
  const rawKind = params.get("kind")
  const kind: ArtifactKind = isArtifactKind(rawKind) ? rawKind : "all"
  const counts = countByKind(all)
  const exhibits = all.filter((exhibit) => matchesKind(exhibit, kind))

  const tree = buildTree(exhibits)
  // Open by default: a capture is usually a handful of files, and a collapsed tree hides them all.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const openFolders = new Set(folderPaths(tree).filter((path) => !closed.has(path)))
  const toggleFolder = (path: string): void =>
    setClosed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const selectedId = params.get("artifact")
  const selectedIndex = Math.max(
    0,
    exhibits.findIndex((exhibit) => exhibit.id === selectedId),
  )
  const selected = exhibits[selectedIndex]

  const update = (next: { artifact?: string | null; kind?: ArtifactKind }): void => {
    const merged = new URLSearchParams(params)
    if (next.kind !== undefined) {
      if (next.kind === "all") merged.delete("kind")
      else merged.set("kind", next.kind)
      // The selected artifact may not survive the new filter; let it fall back to the first.
      merged.delete("artifact")
    }
    if (next.artifact !== undefined) {
      if (next.artifact === null) merged.delete("artifact")
      else merged.set("artifact", next.artifact)
    }
    // Pushed, not replaced: opening a file is a navigation a reader expects Back to undo. Only the
    // implicit fallback to the first exhibit replaces, so Back never lands on a URL nobody chose.
    setParams(merged)
  }

  const setSelectedId = (id: string): void => update({ artifact: id })

  const downloadAll = async (): Promise<void> => {
    setZipping(true)
    try {
      const blob = await zipArtifacts(
        exhibits.filter((exhibit) => exhibit.downloadUrl !== null),
        async (id) => {
          const exhibit = exhibits.find((candidate) => candidate.id === id)
          const response = await fetch(exhibit?.downloadUrl ?? "", { credentials: "same-origin" })
          if (!response.ok) throw new Error(`${response.status}`)
          return new Uint8Array(await response.arrayBuffer())
        },
      )
      saveBlob(blob, "artifacts.zip")
    } finally {
      setZipping(false)
    }
  }

  if (exhibits.length === 0) {
    return (
      <p className="border border-dashed border-rule bg-panel p-6 text-center text-ink-soft">
        No artifacts were filed in this session.
      </p>
    )
  }

  const move = (delta: number): void => {
    const next = exhibits[(selectedIndex + delta + exhibits.length) % exhibits.length]
    if (!next) return
    setSelectedId(next.id)
    const buttons = listRef.current?.querySelectorAll("button")
    buttons?.[exhibits.indexOf(next)]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault()
      move(-1)
    }
  }

  return (
    <div className="grid grid-cols-1 border border-rule bg-panel-2 min-[720px]:grid-cols-[minmax(0,272px)_minmax(0,1fr)]">
      <aside className="border-b border-rule bg-panel min-[720px]:border-b-0 min-[720px]:border-r">
        <div className="border-b border-rule px-3 py-3">
          <h3 className="text-[0.8125rem] font-semibold">Filed exhibits</h3>
          <fieldset className="mt-2 flex flex-wrap gap-1">
            <legend className="sr-only">Filter by type</legend>
            {(["all", "code", "docs", "media"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={option === kind}
                disabled={counts[option] === 0 && option !== "all"}
                onClick={() => update({ kind: option })}
                className={`border px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.08em] transition-colors disabled:opacity-40 ${
                  option === kind
                    ? "border-custody bg-panel-2 text-custody"
                    : "border-rule text-ink-soft hover:bg-panel-2"
                }`}
              >
                {option} {counts[option]}
              </button>
            ))}
          </fieldset>
          {exhibits.some((exhibit) => exhibit.downloadUrl !== null) ? (
            <button
              type="button"
              onClick={downloadAll}
              disabled={zipping}
              className="mt-2 w-full border border-rule px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-ink-soft transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              {zipping ? "Preparing…" : "Download all"}
            </button>
          ) : null}
          <p className="mt-1 font-mono text-[0.6875rem] text-faded">
            {exhibits.length} {exhibits.length === 1 ? "exhibit" : "exhibits"}
          </p>
          <label className="mt-2 block min-[720px]:hidden">
            <span className="sr-only">Choose an artifact</span>
            <select
              value={selected?.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              className="w-full rounded-xs border border-rule bg-panel-2 px-2 py-2 font-mono text-[0.75rem]"
            >
              {exhibits.map((exhibit) => (
                <option key={exhibit.id} value={exhibit.id}>
                  {nameOf(exhibit)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <ul
          ref={listRef}
          aria-label="Filed artifacts"
          onKeyDown={onKeyDown}
          className="hidden max-h-[70vh] overflow-auto py-1 min-[720px]:block"
        >
          <Tree
            nodes={tree}
            depth={0}
            selectedId={selected?.id}
            openFolders={openFolders}
            onToggle={toggleFolder}
            onSelect={setSelectedId}
          />
        </ul>
      </aside>

      {selected ? <Viewer exhibit={selected} /> : null}
    </div>
  )
}
