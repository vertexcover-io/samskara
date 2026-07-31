import { useEffect, useRef, useState } from "react"
import { rawArtifactUrl } from "../api/artifacts.js"
import type { CapturedArtifact } from "../api/types.js"
import { Markdown } from "./Markdown.js"
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

const exhibitNo = (index: number): string => `E-${String(index + 1).padStart(2, "0")}`

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

const Body = ({ exhibit }: { exhibit: Exhibit }) => {
  if (exhibit.access === "denied") {
    return (
      <Notice tone="err" title="Permission denied">
        This artifact was filed but its contents were withheld. Provenance is recorded above.
      </Notice>
    )
  }

  if (exhibit.diff !== null) return <DiffBody content={exhibit.diff} />
  if (exhibit.oldFragment !== null) return <ReplacedExcerpt fragment={exhibit.oldFragment} />

  const medium = mediumOf(exhibit)
  const source = exhibit.mediaUrl ?? undefined

  if (medium === "image") {
    return source === undefined ? (
      <Notice tone="faded" title="No image captured">
        The image was referenced but its bytes were not stored.
      </Notice>
    ) : (
      <img
        src={source}
        alt={exhibit.title ?? nameOf(exhibit)}
        className="max-w-full border border-rule bg-panel"
      />
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

  const asMedium = (text: string) => {
    if (medium === "markdown") return <Markdown source={text} />
    if (medium === "diff") return <DiffBody content={text} />
    return (
      <pre className="overflow-x-auto border border-rule bg-panel p-3 font-mono text-[0.72rem] leading-relaxed">
        {text}
      </pre>
    )
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

  return (
    <pre className="overflow-x-auto border border-rule bg-panel p-3 font-mono text-[0.72rem] leading-relaxed">
      {exhibit.content}
    </pre>
  )
}

const Provenance = ({ exhibit }: { exhibit: Exhibit }) => (
  <div className="flex flex-wrap border-b border-rule">
    <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
      <b className="font-semibold text-custody">Filed</b>{" "}
      {exhibit.timestamp === null
        ? "unavailable"
        : exhibit.timestamp.slice(0, 16).replace("T", " ")}
    </span>
    <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
      <b className="font-semibold text-custody">By</b> {exhibit.agent ?? "Claude"}
    </span>
    <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
      <b className="font-semibold text-custody">Type</b> {exhibit.mimeType ?? "unknown"}
    </span>
    {exhibit.editCount === null ? null : (
      <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
        <b className="font-semibold text-custody">Edits</b> {exhibit.editCount}
      </span>
    )}
  </div>
)

const Viewer = ({ exhibit, index }: { exhibit: Exhibit; index: number }) => (
  <section aria-label="Artifact viewer" className="min-w-0 bg-panel-2">
    <header className="border-b border-rule bg-panel px-4 py-3">
      <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
        {kindOf(exhibit)}
      </p>
      <h3 className="mt-1 break-all font-mono text-[0.8125rem] font-semibold">
        {exhibit.label ?? <Unavailable />}
      </h3>
      <p className="mt-1 font-mono text-[0.6875rem] text-faded">
        {exhibitNo(index)} · {exhibit.title ?? "no title captured"}
      </p>
    </header>

    <Provenance exhibit={exhibit} />

    <div className="max-h-[70vh] overflow-auto p-4">
      <Body exhibit={exhibit} />
    </div>
  </section>
)

export const ArtifactsView = ({
  artifacts,
}: { artifacts: ReadonlyArray<Artifact | CapturedArtifact> }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const exhibits = artifacts.map(toExhibit)
  const selectedIndex = Math.max(
    0,
    exhibits.findIndex((exhibit) => exhibit.id === selectedId),
  )
  const selected = exhibits[selectedIndex]

  useEffect(() => {
    setSelectedId(null)
  }, [])

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
              {exhibits.map((exhibit, index) => (
                <option key={exhibit.id} value={exhibit.id}>
                  {exhibitNo(index)} · {nameOf(exhibit)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <ul
          ref={listRef}
          aria-label="Filed artifacts"
          onKeyDown={onKeyDown}
          className="hidden max-h-[70vh] overflow-auto min-[720px]:block"
        >
          {exhibits.map((exhibit, index) => (
            <li key={exhibit.id}>
              <button
                type="button"
                aria-current={exhibit.id === selected?.id}
                onClick={() => setSelectedId(exhibit.id)}
                className={`grid w-full grid-cols-[34px_minmax(0,1fr)] gap-2 border-b border-rule-soft px-3 py-3 text-left transition-colors hover:bg-panel-2 ${
                  exhibit.id === selected?.id
                    ? "bg-panel-2 shadow-[inset_3px_0_0_var(--color-stamp)]"
                    : ""
                }`}
              >
                <span className="font-mono text-[0.6875rem] font-bold text-stamp">
                  {exhibitNo(index)}
                </span>
                <span className="min-w-0">
                  <span className="block break-words font-mono text-[0.72rem] font-semibold">
                    {nameOf(exhibit)}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1 text-[0.6875rem] text-faded">
                    {kindOf(exhibit)}
                    {exhibit.access === "denied" ? (
                      <span className="font-mono font-semibold text-err">· locked</span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {selected ? <Viewer exhibit={selected} index={selectedIndex} /> : null}
    </div>
  )
}
