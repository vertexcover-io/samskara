import { type ReactNode, useEffect, useState } from "react"
import { client, request } from "../api/client.js"
import { plural } from "../learnings/labels.js"
import { controlClass } from "./controls.js"

export type ProjectSettings = { readonly autoReview: boolean; readonly fixRunEveryDays: number }

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly message: string }

const REFUSED: Readonly<Record<string, string>> = {
  forbidden: "Only a project admin can change these settings.",
  projectNotFound: "This project could not be found.",
}

/** Matches the server's limit, `MAX_FIX_RUN_EVERY_DAYS` in packages/core/src/ingest/types.ts. */
const MAX_FIX_RUN_EVERY_DAYS = 3650

/** A whole number of days from 1 to the server's limit, or null for anything else. */
const asDays = (text: string): number | null => {
  if (!/^\d+$/.test(text.trim())) return null
  const days = Number(text)
  return days >= 1 && days <= MAX_FIX_RUN_EVERY_DAYS ? days : null
}

const Row = ({
  title,
  detail,
  children,
}: {
  readonly title: string
  readonly detail: string
  readonly children: ReactNode
}) => (
  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule-soft px-4 py-3.5 last:border-b-0">
    <div>
      <p className="text-[0.9375rem] font-semibold leading-snug">{title}</p>
      <p className="text-ink-soft">{detail}</p>
    </div>
    <div className="flex items-center gap-2">{children}</div>
  </div>
)

export const SettingsTab = ({
  projectId,
  settings,
  canEdit,
  onSaved,
}: {
  readonly projectId: string
  readonly settings: ProjectSettings
  readonly canEdit: boolean
  readonly onSaved: (settings: ProjectSettings) => void
}) => {
  const [days, setDays] = useState(String(settings.fixRunEveryDays))
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  // A saved or refused value from the page becomes the field's value again.
  useEffect(() => setDays(String(settings.fixRunEveryDays)), [settings.fixRunEveryDays])

  const save = async (change: Partial<ProjectSettings>) => {
    setStatus({ kind: "saving" })
    const result = await request(() =>
      client.api.projects[":id"].$patch({ param: { id: projectId }, json: change }),
    )
    if (result.ok) {
      onSaved({ ...settings, ...change })
      setStatus({ kind: "saved" })
      return
    }
    setDays(String(settings.fixRunEveryDays))
    setStatus({
      kind: "failed",
      message: REFUSED[result.error.code ?? ""] ?? result.error.message,
    })
  }

  const typed = asDays(days)
  const canSaveDays =
    typed !== null && typed !== settings.fixRunEveryDays && status.kind !== "saving"

  return (
    <div className="flex flex-col gap-3">
      <div className="border border-rule bg-panel-2 shadow-card">
        <Row title="Automatic review" detail="Review this project's finished sessions every night">
          {canEdit ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.autoReview}
                disabled={status.kind === "saving"}
                onChange={(e) => save({ autoReview: e.target.checked })}
              />
              On
            </label>
          ) : (
            <span className="font-mono text-[0.78rem]">{settings.autoReview ? "On" : "Off"}</span>
          )}
        </Row>
        <Row title="Fix run every" detail="Days between automatic fix runs">
          {canEdit ? (
            <>
              <input
                type="number"
                min={1}
                max={MAX_FIX_RUN_EVERY_DAYS}
                step={1}
                aria-label="Days between automatic fix runs"
                className={`${controlClass} w-20`}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
              <span className="text-ink-soft">days</span>
              <button
                type="button"
                disabled={!canSaveDays}
                onClick={() => typed !== null && save({ fixRunEveryDays: typed })}
                className="h-9 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink disabled:cursor-default disabled:opacity-60 disabled:hover:border-rule"
              >
                Save
              </button>
            </>
          ) : (
            <span className="font-mono text-[0.78rem]">
              {plural(settings.fixRunEveryDays, "day")}
            </span>
          )}
        </Row>
      </div>
      {canEdit ? null : (
        <p className="text-[0.82rem] text-ink-soft">Only a project admin can change these.</p>
      )}
      {/* A pending days edit is not saved, whichever control saved last. */}
      {status.kind === "saved" && days === String(settings.fixRunEveryDays) ? (
        <p role="status" className="text-[0.82rem] text-ok">
          Saved
        </p>
      ) : null}
      {status.kind === "failed" ? (
        <p role="alert" className="text-[0.82rem] text-err">
          {status.message}
        </p>
      ) : null}
    </div>
  )
}
