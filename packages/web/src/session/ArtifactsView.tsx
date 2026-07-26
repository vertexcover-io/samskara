import { useState } from "react"
import type { Artifact } from "./records.js"

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

const nameOf = (artifact: Artifact): string => {
  const source = artifact.path ?? artifact.url
  if (source === null) return artifact.title ?? "unavailable exhibit"
  return source.split("/").pop() ?? source
}

const kindOf = (artifact: Artifact): string => {
  const source = artifact.path ?? artifact.url
  if (source === null) return "Metadata unavailable"
  const extension = source.includes(".") ? (source.split(".").pop() ?? "") : ""
  return extension === "" ? "Filed exhibit" : `${extension.toUpperCase()} evidence`
}

const exhibitNo = (index: number): string => `E-${String(index + 1).padStart(2, "0")}`

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

    <div className="flex flex-wrap border-b border-rule">
      <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
        <b className="font-semibold text-custody">Filed</b>{" "}
        {artifact.timestamp === null ? "unavailable" : artifact.timestamp.slice(0, 16)}
      </span>
      <span className="border-r border-rule px-3 py-2 font-mono text-[0.6875rem] text-ink-soft">
        <b className="font-semibold text-custody">Source</b>{" "}
        {artifact.url === null ? "capture" : "link"}
      </span>
    </div>

    <div className="overflow-auto p-4">
      {artifact.url === null ? (
        <p className="border border-dashed border-faded bg-panel p-4 text-faded">
          The contents of this exhibit were not captured. Its provenance is recorded above.
        </p>
      ) : (
        <a
          href={artifact.url}
          className="break-all font-mono text-[0.78rem] text-custody underline"
        >
          {artifact.url}
        </a>
      )}
    </div>
  </section>
)

export const ArtifactsView = ({ artifacts }: { artifacts: ReadonlyArray<Artifact> }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (artifacts.length === 0) {
    return (
      <p className="border border-dashed border-rule bg-panel p-6 text-center text-ink-soft">
        No artifacts were filed in this session.
      </p>
    )
  }

  const selectedIndex = Math.max(
    0,
    artifacts.findIndex((artifact) => artifact.id === selectedId),
  )
  const selected = artifacts[selectedIndex]

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

        <ul aria-label="Filed artifacts" className="hidden min-[720px]:block">
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
                  <span className="mt-1 block text-[0.6875rem] text-faded">{kindOf(artifact)}</span>
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
