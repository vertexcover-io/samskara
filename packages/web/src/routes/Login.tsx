import { BuildStamp } from "../shell/BuildStamp.js"

type SpineActor = "user" | "assistant" | "aside"

type SpineRecord = {
  readonly actor: SpineActor
  readonly title: string
  readonly meta: string
}

const SPINE: readonly SpineRecord[] = [
  { actor: "user", title: "You ask for the change", meta: "prompt · filed verbatim" },
  {
    actor: "assistant",
    title: "The agent plans it, then writes it",
    meta: "reasoning · plan · diff",
  },
  { actor: "aside", title: "Every tool call keeps its result", meta: "tool call · tool result" },
  {
    actor: "aside",
    title: "Artifacts and commits attach to the file",
    meta: "artifact · commit · pull request",
  },
]

const NODE: Record<SpineActor, string> = {
  user: "border-panel-2 bg-panel-2",
  assistant: "border-custody-lift",
  aside: "border-rule",
}

/* The mark is the custody spine itself: the record a human filed, solid; the record the agent
   produced from it, hollow; and the subagent that branched off between them. */
const SamskaraMark = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-7 shrink-0">
    <path d="M8 7.5v9M8.5 12h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    <circle cx="8" cy="4.5" r="3" fill="currentColor" />
    <circle cx="8" cy="19.5" r="3" stroke="currentColor" strokeWidth="1.75" />
    <circle cx="17.5" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.75" />
  </svg>
)

const GithubMark = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
)

const CustodySpine = () => (
  <ol className="mt-8 space-y-6">
    {SPINE.map((record, index) => (
      <li key={record.title} className="relative pl-8">
        {index < SPINE.length - 1 ? (
          <span
            aria-hidden="true"
            className="absolute left-[4px] top-[15px] block h-[calc(100%_+_1.5rem_-_15px)] w-[2px] bg-custody-lift/40"
          />
        ) : null}
        <span
          aria-hidden="true"
          className={`absolute left-0 top-[5px] block size-[10px] rounded-pill border-2 ${NODE[record.actor]}`}
        />
        <p className="text-panel-2">{record.title}</p>
        <p className="mt-1 font-mono text-[0.78rem] text-panel-2/60">{record.meta}</p>
      </li>
    ))}
  </ol>
)

const EvidencePanel = () => (
  <section className="animate-file-in flex flex-col justify-center bg-ink px-6 py-14 sm:px-10 lg:px-14 lg:py-16">
    <div className="mx-auto w-full max-w-[28rem]">
      <h1 className="flex items-center gap-3 text-case-title text-panel-2">
        <SamskaraMark />
        samskara
      </h1>

      <h2 className="mt-9 text-cover text-panel-2">
        Read why a change happened, not just what changed.
      </h2>
      <p className="mt-5 text-lead text-panel-2/70">
        Samskara files the intent, the agent session, the tool activity and the artifacts behind
        AI-assisted code. Review starts with the reasoning, not the diff.
      </p>
      <p className="mt-12 text-label uppercase text-panel-2/50">How a session is filed</p>
      <CustodySpine />
    </div>
  </section>
)

const AccessColumn = () => (
  <section className="relative flex flex-col justify-center px-6 py-14 sm:px-10 lg:px-14">
    <div aria-hidden="true" className="ledger-ground pointer-events-none absolute inset-0" />
    <div className="animate-file-in relative mx-auto w-full max-w-[23rem] border border-rule bg-panel-2 p-8 shadow-card">
      <h2 className="text-case-title">Sign in</h2>
      <div aria-hidden="true" className="mt-4 h-[2px] w-10 bg-stamp" />
      <p className="mt-5 text-lead text-ink-soft">
        Open your filed sessions — every prompt, tool call and artifact, kept in place.
      </p>

      <a
        href="/api/auth/github/start"
        className="mt-8 inline-flex w-full items-center justify-center gap-2.5 rounded-xs border border-ink bg-ink px-4 py-3 font-semibold text-panel-2 transition-colors hover:bg-ink-2"
      >
        <GithubMark />
        Continue with GitHub
      </a>
    </div>

    <BuildStamp className="relative mx-auto mt-6 w-full max-w-[23rem] justify-end" />
  </section>
)

export const Login = () => (
  <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
    <EvidencePanel />
    <AccessColumn />
  </main>
)
