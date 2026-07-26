export const Login = () => (
  <main className="relative z-10 grid min-h-dvh place-items-center px-4 py-10">
    <div className="w-full max-w-sm border border-rule bg-panel-2 p-6 shadow-[0_1px_2px_rgba(26,28,32,0.06)]">
      <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
        Case file access
      </p>
      <h1 className="mt-2 text-[1.375rem] font-semibold leading-tight">samskara</h1>
      <p className="mt-3 text-ink-soft">
        Process provenance for AI-assisted software development. Sign in to open your filed
        sessions.
      </p>
      <a
        href="/api/auth/github/start"
        className="mt-6 inline-flex w-full items-center justify-center rounded-xs border border-ink bg-ink px-4 py-2.5 text-panel-2 transition-colors hover:bg-ink-2"
      >
        Continue with GitHub
      </a>
    </div>
  </main>
)
