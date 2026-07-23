# Auth System — reviewer index

GitHub OAuth web login, org-allowlist gate, audience-scoped session/CLI JWTs, and a browserless
CLI pairing flow. Built on the existing identity mesh; **no new tables** (pairing codes are in-memory).

**Verification verdict:** **PASS (live)** — every endpoint (`/github/start`, `/me`, `/logout`,
`/cli-code`, `/cli-exchange`) and the real `samskara login` CLI were driven against a running server
on `:3000` with real secrets: CSRF state binding, audience gating (aud:cli rejected on web routes),
httpOnly/SameSite cookies, no internal-field leak, single-use pairing codes, and the `0600` CLI
token file all confirmed. The org-gate happy/reject paths are proven by the stubbed integration
suite (43 server tests green). **One step is deferred to a human:** the interactive GitHub *Authorize*
click + live org-membership check (no `agent-browser` / no autonomous OAuth) — manual repro steps are
in the (gitignored) `verification/proof-report.md`.

**Quality gate:** PASS — typecheck, lint (62 files), build, and all tests green vs baseline.
**Code review:** two-pass, final verdict **APPROVE** (2 Important bugs found & fixed in pass 1:
org-slug case mismatch, unchecked GitHub API responses; 0 Critical). Then a 5-part architectural
refactor (repositories, zod config, `@hono/zod-validator`, env-driven JWT expiry, CLI config) was
applied and re-approved.

## Artifacts
- [design.md](design.md) — the design (decisions A1–A10, endpoints, GithubClient seam, testing).
- [plan.md](plan.md) — 3 vertical-slice phases (login → session → cli-pairing) + system E2E.

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/auth/github/start`    | none | state cookie + redirect to GitHub |
| GET  | `/api/auth/github/callback` | none | verify state, exchange code, org-gate, upsert, set session |
| GET  | `/api/auth/me`              | web  | current user |
| POST | `/api/auth/logout`          | web  | clear session |
| POST | `/api/auth/cli-code`        | web  | mint a pairing code |
| POST | `/api/auth/cli-exchange`    | none | redeem code → aud:cli JWT |

## Library / config
- **jose** for JWTs (issuer `samskara`, HS256, `aud: web|cli`, `JWT_EXPIRES_IN` default `7d`).
- **zod** config (`lib/env.ts`) + **@hono/zod-validator** request validation.
- Env in `.env` (`.env.example` committed): `GITHUB_CLIENT_ID/SECRET`, `JWT_SECRET`,
  `PUBLIC_BASE_URL`, `COOKIE_SECURE`, `JWT_EXPIRES_IN`. Seed allowed orgs: `bun run seed:org <slug>`.

PR: _(local --auto run; no PR opened — caller handles it)_
