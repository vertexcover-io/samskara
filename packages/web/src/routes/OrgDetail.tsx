import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { OrgDetail as OrgDetailPayload } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly org: OrgDetailPayload }
  | { readonly phase: "failed"; readonly error: ApiError }

type Settings = {
  readonly name: string
  readonly autoAddMembers: boolean
}

type SettingsState = {
  readonly saved: Settings
  readonly draft: Settings
  readonly pending: boolean
  readonly acknowledged: boolean
  readonly error: string | null
}

const requestOrgPatch = (slug: string, json: { autoAddMembers?: boolean; name?: string | null }) =>
  request(() => client.api.orgs[":slug"].$patch({ param: { slug }, json }))

type PatchResult = Awaited<ReturnType<typeof requestOrgPatch>>

const patchFailureMessage = (result: PatchResult): string | null => {
  if (!result.ok) return result.error.message
  return result.data.org === null ? "This org can no longer be found." : null
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
      {label}
    </p>
    <p className="truncate font-mono text-[0.9375rem]">{children}</p>
  </div>
)

const ErrorState = ({ error }: { error: ApiError }) => (
  <section className="border border-err/40 bg-panel p-6">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
      Retrieval failed
    </p>
    <p className="mt-2 text-ink-soft">{error.message}</p>
  </section>
)

export const OrgDetail = () => {
  const { slug } = useParams()
  const [state, setState] = useState<State>({ phase: "loading" })
  const [settings, setSettings] = useState<SettingsState | null>(null)

  useEffect(() => {
    let active = true

    request(() => client.api.orgs[":slug"].$get({ param: { slug: slug ?? "" } })).then((result) => {
      if (!active) return
      if (!result.ok) {
        setState({ phase: "failed", error: result.error })
        return
      }
      const saved = {
        name: result.data.org.name,
        autoAddMembers: result.data.org.autoAddMembers,
      }
      setState({ phase: "ready", org: result.data.org })
      setSettings({ saved, draft: saved, pending: false, acknowledged: false, error: null })
    })

    return () => {
      active = false
    }
  }, [slug])

  const edit = (change: Partial<Settings>) =>
    setSettings((current) =>
      current === null
        ? current
        : { ...current, draft: { ...current.draft, ...change }, acknowledged: false, error: null },
    )

  const save = () => {
    if (settings === null || settings.pending || !slug) return
    const { saved, draft } = settings
    const trimmed = draft.name.trim()
    const json = {
      ...(trimmed === saved.name ? {} : { name: trimmed === "" ? null : trimmed }),
      ...(draft.autoAddMembers === saved.autoAddMembers
        ? {}
        : { autoAddMembers: draft.autoAddMembers }),
    }
    if (Object.keys(json).length === 0) return

    setSettings({ ...settings, pending: true, acknowledged: false, error: null })
    requestOrgPatch(slug, json).then((result) => {
      const org = result.ok ? result.data.org : null
      if (org === null) {
        setSettings((current) =>
          current === null
            ? current
            : {
                ...current,
                draft: current.saved,
                pending: false,
                acknowledged: false,
                error: patchFailureMessage(result),
              },
        )
        return
      }
      const next = { name: org.name, autoAddMembers: org.autoAddMembers }
      setSettings({
        saved: next,
        draft: next,
        pending: false,
        acknowledged: true,
        error: null,
      })
    })
  }

  if (state.phase === "loading") return <LoadingShell label="Retrieving the org" />
  if (state.phase === "failed") {
    if (state.error.kind === "unauthorized") return <SessionExpired />
    return <ErrorState error={state.error} />
  }

  const { org } = state
  const dirty =
    settings !== null &&
    (settings.draft.name.trim() !== settings.saved.name ||
      settings.draft.autoAddMembers !== settings.saved.autoAddMembers)

  return (
    <section>
      <h1 className="text-[1.375rem] font-semibold leading-tight">
        {settings?.saved.name ?? org.name}
      </h1>
      {(settings?.saved.name ?? org.name) === org.githubSlug ? null : (
        <p className="mt-1 font-mono text-[0.78rem] text-custody">{org.githubSlug}</p>
      )}

      {/* biome-ignore lint/a11y/useSemanticElements: a plain div grouping Field pairs, not a form */}
      <div
        role="group"
        aria-label="Org totals"
        className="mt-4 grid grid-cols-2 gap-4 border border-rule bg-panel-2 p-4 shadow-card min-[560px]:grid-cols-4"
      >
        <Field label="Sessions">{org.sessionCount}</Field>
        <Field label="Members">{org.members.length}</Field>
        <Field label="Projects">{org.projects.length}</Field>
      </div>

      <h2 className="mt-6 text-[0.9375rem] font-semibold">Projects</h2>
      {org.projects.length === 0 ? (
        <p className="mt-2 border border-rule-soft bg-panel p-4 text-ink-soft">
          This org owns no projects yet. A project becomes the org's when someone runs{" "}
          <code className="font-mono text-[0.78rem]">samskara enable</code> in a repository under{" "}
          <span className="font-mono text-[0.78rem] text-custody">{org.githubSlug}</span>.
        </p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-4 min-[560px]:grid-cols-2 min-[840px]:grid-cols-3">
          {org.projects.map((project) => (
            <li key={project.id}>
              <article className="flex w-full flex-col gap-3 border border-rule bg-panel-2 p-4 shadow-card transition-colors focus-within:border-ink-soft hover:border-ink-soft">
                <div className="min-w-0">
                  <h3 className="truncate text-[0.9375rem] font-semibold">
                    <Link
                      to={`/projects/${encodeURIComponent(project.id)}`}
                      className="hover:underline"
                    >
                      {project.name}
                    </Link>
                  </h3>
                  <p className="truncate font-mono text-[0.78rem] text-custody">/{project.slug}</p>
                </div>
                <Field label="Sessions">{project.sessionCount}</Field>
                {project.sessionCount === 0 ? null : (
                  <Link
                    to={`/sessions?project=${encodeURIComponent(project.id)}`}
                    className="block border-t border-rule-soft pt-2 text-[0.78rem] font-semibold text-custody hover:underline"
                  >
                    View sessions
                  </Link>
                )}
              </article>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-6 text-[0.9375rem] font-semibold">Members</h2>
      {org.members.length === 0 ? (
        <p className="mt-2 border border-rule-soft bg-panel p-4 text-ink-soft">
          Nobody has signed in from this org yet.
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-3">
          {org.members.map((member) => (
            <li
              key={member.id}
              className="flex items-center gap-2 border border-rule bg-panel-2 px-3 py-2"
            >
              {member.avatarUrl ? (
                <img src={member.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
              ) : null}
              <span className="font-mono text-[0.78rem]">{member.githubLogin}</span>
            </li>
          ))}
        </ul>
      )}

      {settings === null ? null : (
        <>
          <h2 className="mt-8 text-[0.9375rem] font-semibold">Settings</h2>
          <div className="mt-2 border border-rule-soft bg-panel">
            <div className="border-b border-rule-soft p-4">
              <label
                htmlFor="org-name-input"
                className="block text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft"
              >
                Display name
              </label>
              <p className="mt-1 text-ink-soft">
                Shown wherever this org appears. Leave it empty to fall back to{" "}
                <span className="font-mono text-[0.78rem] text-custody">{org.githubSlug}</span>.
              </p>
              <input
                id="org-name-input"
                type="text"
                value={settings.draft.name}
                disabled={settings.pending}
                onChange={(event) => edit({ name: event.target.value })}
                autoComplete="off"
                className="mt-3 w-full max-w-sm border border-rule bg-panel-2 px-3 py-2 font-mono text-[0.9375rem]"
              />
            </div>

            <div className="border-b border-rule-soft p-4">
              <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
                <input
                  type="checkbox"
                  checked={settings.draft.autoAddMembers}
                  disabled={settings.pending}
                  onChange={(event) => edit({ autoAddMembers: event.target.checked })}
                  className="mt-1 h-5 w-5 shrink-0"
                />
                <span>
                  <span className="font-semibold">Add new GitHub members automatically</span>
                  <span className="mt-1 block text-ink-soft">
                    Anyone who joins{" "}
                    <span className="font-mono text-[0.78rem] text-custody">{org.githubSlug}</span>{" "}
                    on GitHub gets access to every project this org owns, from their next sign-in.
                    Leave it off to admit people one at a time.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3 p-4">
              <button
                type="button"
                onClick={save}
                disabled={settings.pending || !dirty}
                className="min-h-11 border border-rule bg-panel-2 px-4 py-2 text-[0.78rem] font-semibold disabled:opacity-60"
              >
                {settings.pending ? "Saving…" : "Save"}
              </button>
              {dirty && !settings.pending ? (
                <button
                  type="button"
                  onClick={() => setSettings({ ...settings, draft: settings.saved, error: null })}
                  className="min-h-11 px-2 py-2 text-[0.78rem] font-semibold text-ink-soft hover:underline"
                >
                  Discard
                </button>
              ) : null}
              {settings.acknowledged && !dirty ? (
                <output className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ok">
                  Saved
                </output>
              ) : null}
            </div>

            {settings.error ? (
              <p role="alert" className="border-t border-err/40 bg-panel-2 p-4 text-err">
                {settings.error}
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}
