import { useEffect, useRef, useState } from "react"
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

const extensionOf = (artifact: Artifact): string => {
  const source = artifact.path ?? artifact.url ?? ""
  const name = source.split("/").pop() ?? ""
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : ""
}

const mediumOf = (artifact: Artifact): Medium => {
  const mime = artifact.mimeType ?? ""
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime === "text/x-diff") return "diff"
  if (mime === "text/markdown") return "markdown"

  const extension = extensionOf(artifact)
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

const nameOf = (artifact: Artifact): string => {
  const source = artifact.path ?? artifact.url
  if (source === null) return artifact.title ?? "unavailable exhibit"
  return source.split("/").pop() ?? source
}

const kindOf = (artifact: Artifact): string => {
  if (artifact.access === "denied") return "Permission denied"
  const medium = mediumOf(artifact)
  if (medium === "unknown") return "Metadata unavailable"
  const extension = extensionOf(artifact)
  return extension === "" ? MEDIUM_LABEL[medium] : `${MEDIUM_LABEL[medium]} · ${extension}`
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
          {line === "" ? " " : line}
        </div>
      )
    })}
  </pre>
)

const Body = ({ artifact }: { artifact: Artifact }) => {
  if (artifact.access === "denied") {
    return (
      <Notice tone="err" title="Permission denied">
        This artifact was filed but its contents were withheld. Provenance is recorded above.
      </Notice>
    )
  }

  const medium = mediumOf(artifact)

  const source = artifact.url ?? undefined

  if (medium === "image") {
    return source === undefined ? (
      <Notice tone="faded" title="No image captured">
        The image was referenced but its bytes were not stored.
      </Notice>
    ) : (
      <img
        src={source}
        alt={artifact.title ?? nameOf(artifact)}
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

  const content = artifact.content ?? null

  if (content === null) {
    return (
      <Notice tone="faded" title="No contents captured">
        The contents of this exhibit were not captured. Its provenance is recorded above.
      </Notice>
    )
  }

  if (medium === "markdown") return <Markdown source={content} />
  if (medium === "diff") return <DiffBody content={content} />

  return (
    <pre className="overflow-x-auto border border-rule bg-panel p-3 font-mono text-[0.72rem] leading-relaxed">
      {content}
    </pre>
  )
}

const Provenance = ({ artifact }: { artifact: Artifact }) => (
  <div className="flex flex-wrap border-b border-rule">
    <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
      <b className="font-semibold text-custody">Filed</b>{" "}
      {artifact.timestamp === null
        ? "unavailable"
        : artifact.timestamp.slice(0, 16).replace("T", " ")}
    </span>
    <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
      <b className="font-semibold text-custody">By</b> {artifact.agent ?? "Claude"}
    </span>
    <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
      <b className="font-semibold text-custody">Type</b> {artifact.mimeType ?? "unknown"}
    </span>
  </div>
)

const Viewer = ({ artifact, index }: { artifact: Artifact; index: number }) => (
  <section aria-label="Artifact viewer" className="min-w-0 bg-panel-2">
    <header className="border-b border-rule bg-panel px-4 py-3">
      <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
        {kindOf(artifact)}
      </p>
      <h3 className="mt-1 break-all font-mono text-[0.8125rem] font-semibold">
        {artifact.path ?? artifact.url ?? <Unavailable />}
      </h3>
      <p className="mt-1 font-mono text-[0.6875rem] text-faded">
        {exhibitNo(index)} · {artifact.title ?? "no title captured"}
      </p>
    </header>

    <Provenance artifact={artifact} />

    <div className="max-h-[70vh] overflow-auto p-4">
      <Body artifact={artifact} />
    </div>
  </section>
)

export const ArtifactsView = ({ artifacts }: { artifacts: ReadonlyArray<Artifact> }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const selectedIndex = Math.max(
    0,
    artifacts.findIndex((artifact) => artifact.id === selectedId),
  )
  const selected = artifacts[selectedIndex]

  useEffect(() => {
    setSelectedId(null)
  }, [])

  if (artifacts.length === 0) {
    return (
      <p className="border border-dashed border-rule bg-panel p-6 text-center text-ink-soft">
        No artifacts were filed in this session.
      </p>
    )
  }

  const move = (delta: number): void => {
    const next = artifacts[(selectedIndex + delta + artifacts.length) % artifacts.length]
    if (!next) return
    setSelectedId(next.id)
    const buttons = listRef.current?.querySelectorAll("button")
    buttons?.[artifacts.indexOf(next)]?.focus()
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
            {artifacts.length} {artifacts.length === 1 ? "exhibit" : "exhibits"}
          </p>
          <label className="mt-2 block min-[720px]:hidden">
            <span className="sr-only">Choose an artifact</span>
            <select
              value={selected?.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              className="w-full rounded-xs border border-rule bg-panel-2 px-2 py-2 font-mono text-[0.75rem]"
            >
              {artifacts.map((artifact, index) => (
                <option key={artifact.id} value={artifact.id}>
                  {exhibitNo(index)} · {nameOf(artifact)}
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
          {artifacts.map((artifact, index) => (
            <li key={artifact.id}>
              <button
                type="button"
                aria-current={artifact.id === selected?.id}
                onClick={() => setSelectedId(artifact.id)}
                className={`grid w-full grid-cols-[34px_minmax(0,1fr)] gap-2 border-b border-rule-soft px-3 py-3 text-left transition-colors hover:bg-panel-2 ${
                  artifact.id === selected?.id
                    ? "bg-panel-2 shadow-[inset_3px_0_0_var(--color-stamp)]"
                    : ""
                }`}
              >
                <span className="font-mono text-[0.6875rem] font-bold text-stamp">
                  {exhibitNo(index)}
                </span>
                <span className="min-w-0">
                  <span className="block break-words font-mono text-[0.72rem] font-semibold">
                    {nameOf(artifact)}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1 text-[0.6875rem] text-faded">
                    {kindOf(artifact)}
                    {artifact.access === "denied" ? (
                      <span className="font-mono font-semibold text-err">· locked</span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {selected ? <Viewer artifact={selected} index={selectedIndex} /> : null}
    </div>
  )
}
