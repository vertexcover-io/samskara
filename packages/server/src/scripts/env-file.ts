/**
 * Dependency-free on purpose: `scripts/setup.ts` imports this before `bun install` has run, so it
 * cannot reach anything in node_modules.
 */
const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/

export const readEnvValue = (text: string, key: string): string | undefined => {
  for (const line of text.split("\n")) {
    const name = ASSIGNMENT.exec(line)?.[1]
    if (name === key) return line.slice(line.indexOf("=") + 1).trim()
  }
  return undefined
}

/** Rewrites in place rather than regenerating: the file also holds secrets nothing else knows. */
export const applyEnv = (text: string, overrides: Readonly<Record<string, string>>): string => {
  const pending = new Map(Object.entries(overrides))
  const rewritten = text
    .split("\n")
    .map((line) => {
      const name = ASSIGNMENT.exec(line)?.[1]
      if (!name || !pending.has(name)) return line
      const value = pending.get(name)
      pending.delete(name)
      return `${name}=${value}`
    })
    .join("\n")
  if (pending.size === 0) return rewritten
  const body = rewritten.replace(/\n*$/, "\n")
  const appended = [...pending].map(([name, value]) => `${name}=${value}`).join("\n")
  return `${body}${appended}\n`
}

/**
 * A branch cut before a script existed still deserves a working database, so setup checks the
 * worktree's own package.json rather than assuming it looks like the branch running this code.
 */
export const definesScript = (packageJsonText: string, name: string): boolean => {
  const parsed: unknown = JSON.parse(packageJsonText)
  if (typeof parsed !== "object" || parsed === null) return false
  const scripts = (parsed as { readonly scripts?: unknown }).scripts
  if (typeof scripts !== "object" || scripts === null) return false
  return typeof (scripts as Record<string, unknown>)[name] === "string"
}
