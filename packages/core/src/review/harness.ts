export const REVIEW_HARNESSES = ["opencode", "claude"] as const
export type ReviewHarness = (typeof REVIEW_HARNESSES)[number]

/** A model id reaches the msb runner's `sh -lc`, so it is charset-checked, not just quoted. */
export const REVIEW_MODEL_PATTERN = /^[A-Za-z0-9._/-]+$/

/** Overridable with AI_REVIEW_MODEL: which provider prefix resolves differs per account. */
export const DEFAULT_REVIEW_MODEL: Readonly<Record<ReviewHarness, string>> = {
  opencode: "opencode-go/glm-5.3-flash",
  claude: "sonnet",
}

/** Credentials travel as environment only; nothing is staged into the workspace. */
export const CREDENTIAL_ENV: Readonly<Record<ReviewHarness, ReadonlyArray<string>>> = {
  opencode: ["OPENCODE_API_KEY"],
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
}

const HOW_TO_GET: Readonly<Record<ReviewHarness, string>> = {
  opencode: "`opencode auth login`, then the key in ~/.local/share/opencode/auth.json",
  claude: "`claude setup-token`",
}

/** In the hardened lane opencode runs inside the VM, so the host binary is msb. */
export const hostCommandFor = (harness: ReviewHarness, env: NodeJS.ProcessEnv): string =>
  harness === "opencode" && env.AI_REVIEW_HARDEN !== "0" ? "msb" : harness

export const hasCredential = (harness: ReviewHarness, env: NodeJS.ProcessEnv): boolean =>
  CREDENTIAL_ENV[harness].some((name) => (env[name] ?? "") !== "")

export const missingCredentialMessage = (
  harness: ReviewHarness,
  env: NodeJS.ProcessEnv,
): string | null => {
  if (hasCredential(harness, env)) return null
  const names = CREDENTIAL_ENV[harness]
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`
  return `the ${harness} harness has no credential: set ${list} (from ${HOW_TO_GET[harness]})`
}
