const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline gap-2">
    <dt className="text-label uppercase text-ink-soft">{label}</dt>
    <dd className="font-mono text-evidence text-ink">{value}</dd>
  </div>
)

export const BuildStamp = ({ className = "" }: { className?: string }) => {
  const version = import.meta.env.VITE_APP_VERSION || "dev"
  const commit = import.meta.env.VITE_GIT_COMMIT || "unknown"

  return (
    <dl
      data-testid="build-stamp"
      title={`Built from ${version} (${commit})`}
      className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 ${className}`}
    >
      <Field label="Version" value={version} />
      <span aria-hidden="true" className="h-3 w-px shrink-0 self-center bg-rule-soft" />
      <Field label="Commit" value={commit} />
    </dl>
  )
}
