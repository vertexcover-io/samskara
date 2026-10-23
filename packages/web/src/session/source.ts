export const sourceName = (source: string | undefined): string =>
  source === "codex" ? "Codex" : source === "opencode" ? "OpenCode" : "Claude"
