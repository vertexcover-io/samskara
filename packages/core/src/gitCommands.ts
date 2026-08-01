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
