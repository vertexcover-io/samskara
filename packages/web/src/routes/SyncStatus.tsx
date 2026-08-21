import { useEffect, useState } from "react"
import { getJson } from "../api/client.js"
import { parseSyncStatusRows } from "../api/parse.js"
import type { ApiError, SyncStatusRow } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { LoadingShell } from "../shell/LoadingShell.js"
import { absoluteTime, relativeTime } from "../time.js"

type Loaded = { readonly rows: ReadonlyArray<SyncStatusRow> }

type State =
  | { readonly phase: "loading" }
  | ({ readonly phase: "ready" } & Loaded)
  | { readonly phase: "failed"; readonly error: ApiError }

const EmptyState = () => (
  <section className="border border-dashed border-rule bg-panel p-8 text-center">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      No users yet
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">There is nothing to report</h2>
  </section>
)

const ErrorState = ({ error }: { error: ApiError }) => (
  <section className="border border-err/40 bg-panel p-6">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
      Retrieval failed
    </p>
    <p className="mt-2 text-ink-soft">{error.message}</p>
  </section>
)

const UserCell = ({ row }: { row: SyncStatusRow }) => (
  <td className="border border-rule px-2 py-1 align-top">
    {row.avatarUrl === null ? null : (
      <img
        src={row.avatarUrl}
        alt=""
        className="mr-2 inline-block size-5 rounded-pill align-middle"
      />
    )}
    <span className="font-semibold">{row.githubLogin}</span>
    {row.name === null ? null : (
      <span className="block text-[0.72rem] text-ink-soft">{row.name}</span>
    )}
  </td>
)

const ProjectCell = ({ row }: { row: SyncStatusRow }) => {
  if (row.projectId === null) {
    return <td className="border border-rule px-2 py-1 align-top text-faded italic">no projects</td>
  }
  return (
    <td className="border border-rule px-2 py-1 align-top">
      <span>{row.projectName}</span>
      <span className="block font-mono text-[0.72rem] text-ink-soft">{row.projectSlug}</span>
    </td>
  )
}

const SyncedCell = ({ lastSyncedAt }: { lastSyncedAt: string | null }) => (
  <td className="border border-rule px-2 py-1 align-top">
    {lastSyncedAt === null ? (
      "never"
    ) : (
      <time dateTime={lastSyncedAt} title={absoluteTime(lastSyncedAt)}>
        {relativeTime(lastSyncedAt)}
      </time>
    )}
  </td>
)

const SyncStatusTable = ({ rows }: { rows: ReadonlyArray<SyncStatusRow> }) => (
  <div className="mt-4 overflow-x-auto">
    <table className="w-full border-collapse border border-rule text-[0.8125rem]">
      <thead>
        <tr className="bg-panel-2">
          <th className="border border-rule px-2 py-1 text-left font-semibold">User</th>
          <th className="border border-rule px-2 py-1 text-left font-semibold">Project</th>
          <th className="border border-rule px-2 py-1 text-left font-semibold">Sessions</th>
          <th className="border border-rule px-2 py-1 text-left font-semibold">Last synced</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.userId}:${row.projectId ?? "none"}`}>
            <UserCell row={row} />
            <ProjectCell row={row} />
            <td className="border border-rule px-2 py-1 align-top">{row.sessionCount}</td>
            <SyncedCell lastSyncedAt={row.lastSyncedAt} />
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

export const SyncStatus = () => {
  const [state, setState] = useState<State>({ phase: "loading" })

  useEffect(() => {
    let active = true

    getJson("/api/sync-status", parseSyncStatusRows).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? { phase: "ready", rows: result.data }
          : { phase: "failed", error: result.error },
      )
    })

    return () => {
      active = false
    }
  }, [])

  if (state.phase === "loading") return <LoadingShell label="Retrieving sync status" />
  if (state.phase === "failed") {
    if (state.error.kind === "unauthorized") return <SessionExpired />
    return <ErrorState error={state.error} />
  }
  if (state.rows.length === 0) return <EmptyState />

  return (
    <section>
      <h1 className="text-[1.375rem] font-semibold leading-tight">Sync status</h1>
      <SyncStatusTable rows={state.rows} />
    </section>
  )
}
