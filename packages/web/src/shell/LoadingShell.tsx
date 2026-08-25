export const LoadingShell = ({ label }: { label: string }) => (
  <output
    aria-live="polite"
    className="grid min-h-dvh place-items-center px-4 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft"
  >
    {label}
  </output>
)
