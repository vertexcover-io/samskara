/**
 * A real invocation, not a substring: a grep whose pattern quotes the words, or a heredoc
 * containing them, invokes nothing. Shared by the watcher (to gate what ships) and the server
 * (which trusts no event and re-verifies it against the stored call before deriving rows).
 */
export const isGitCommitCommand = (command: string): boolean =>
  /(^|[\s;&|])git\s+(-\S+\s+)*commit\b/.test(command)

/** Only creations are captured -- a PR merely viewed or listed is not the session's work. */
export const isPrCreateCommand = (command: string): boolean =>
  /(^|[\s;&|])(?:gh\s+pr|glab\s+mr)\s+create\b/.test(command)

/**
 * Splits on whitespace the shell would split on, which is the whole point: a `--body` is one
 * argument however many lines it spans, so flag names discussed inside a PR description stay
 * prose. Quoting is tracked, not resolved -- no expansion, no globbing, just the boundaries.
 */
const tokenize = (command: string): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  let current = ""
  let quoted = false
  let quote: '"' | "'" | null = null

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (char === "\\" && quote !== "'" && index + 1 < command.length) {
      current += command[index + 1]
      index += 1
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      quoted = true
      continue
    }
    if (char !== undefined && /\s/.test(char)) {
      if (quoted || current !== "") tokens.push(current)
      current = ""
      quoted = false
      continue
    }
    current += char
  }

  if (quoted || current !== "") tokens.push(current)
  return tokens
}

const PR_FLAGS: Readonly<Record<string, "title" | "baseBranch" | "headBranch">> = {
  "--title": "title",
  "--base": "baseBranch",
  "--head": "headBranch",
}

export type PullRequestFlags = {
  readonly title?: string
  readonly baseBranch?: string
  readonly headBranch?: string
}

/**
 * What a `gh pr create` was invoked with. The created PR's number and repo come from the result,
 * but these three exist only in the command -- so a PR captured without them is not missing data,
 * it was read from the wrong half of the call.
 */
export const pullRequestFlags = (command: string): PullRequestFlags => {
  const tokens = tokenize(command)
  const flags: { -readonly [K in keyof PullRequestFlags]: string } = {}

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ""
    const split = token.indexOf("=")
    const name = split > 0 ? token.slice(0, split) : token
    const inline = split > 0 ? token.slice(split + 1) : undefined

    const key = PR_FLAGS[name]
    if (key === undefined) continue

    const value = inline ?? tokens[index + 1]
    // A flag followed by another flag was given no value at all; claiming the next one would
    // report the following flag's name as this one's argument.
    if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
      continue
    }

    flags[key] = value
    if (inline === undefined) index += 1
  }

  return flags
}
