# Design: Auth System (GitHub OAuth + user/org + CLI pairing + API auth)

> The identity/authentication foundation for samskara. Builds on the 2a identity mesh
> (`users`, `orgs`, `user_orgs`, `user_repos`, `org_repos`, `repos`). Everything downstream
> (ingest, reads, MCP) authenticates through this. Adapts the proven claude-sessions auth
> flow; the one net-new piece is the **multi-org gate** (claude-sessions is single-org).

## Problem

Users must authenticate to read/write session data. Requirements:

- **Web login** via GitHub OAuth (no passwords).
- **Org-gated**: only members of a pre-seeded allowed org may log in; membership drives
  `user_orgs`. Multi-org-ready (schema supports many; behavior starts allowlist-gated).
- **CLI auth** without a browser: the already-web-authenticated user authorizes the CLI via
  a short pairing code; the CLI then holds a bearer token for ingest.
- **Per-route token scoping** via JWT `aud`.

## Non-Goals (deferred)

- **MCP audience + `POST /mcp-token`** — audiences are `web | cli` now; add `mcp` with the MCP server.
- **Personal (no-org) login** — org membership is REQUIRED this milestone.
- **Email adoption** in user upsert — we never pre-seed users by email (only orgs are seeded).
- **Pairing-codes DB table** — in-memory Map now; DB table only if we run multiple server instances.
- **The ingest contract** (`POST /ingest` body/dedupe) — its own design; this doc stops at "CLI holds a valid `aud:cli` token".
- **Self-serve org creation / invites** — orgs are operator-seeded.

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | **GitHub OAuth web flow**, scopes `read:org user:email` | read:org for the gate; user:email for the users row. No passwords. |
| A2 | **Org gate at callback**: fetch user's GitHub orgs → intersect with seeded `orgs` → empty ⇒ reject; else sync `user_orgs` | Enforces the allowlist; populates the mesh; live-checked each login (no stale membership). |
| A3 | **Membership REQUIRED to log in** (no personal/no-org login yet) | Matches "manually create org, allow login only if user's org matches". |
| A4 | **Orgs seeded by a Bun script** (`bun run seed:org <slug>`), not an admin CLI | Fewer moving parts; no self-serve org creation. |
| A5 | **User upsert = resolve by `github_id`, else insert** (no email adoption) | We never pre-seed users by email; adoption unneeded now. |
| A6 | **CLI pairing**: authed `POST /cli-code` mints a short-TTL code; unauthed `POST /cli-exchange {code}` redeems it for an `aud:cli` JWT | Bridges browser-authed session → browserless CLI. Code is single-use proof. |
| A7 | **Pair codes in an in-memory Map** with TTL, swept on access | Ephemeral (~5 min); single-server; lost-on-restart just means re-login. |
| A8 | **JWT audiences `web | cli`** (jose, issuer, 7d), middleware checks `aud` per route | Route-scoped tokens. mcp deferred but cheap to add. |
| A9 | **httpOnly cookies**: `oauth_state` (~10 min, CSRF) + `session` (7d, Secure, SameSite=Lax). CLI uses `Authorization: Bearer` | Standard; XSS-safe web session; bearer for CLI. |
| A10 | **`GithubClient` injectable interface** (`exchangeCode`, `getProfile`, `getOrgs`, `getVerifiedEmails`) | Stub in tests via `buildApp(db, env, { githubClient })`; no live GitHub in CI. |

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET  | `/api/auth/github/start`    | none        | Set `oauth_state` cookie, redirect to GitHub |
| GET  | `/api/auth/github/callback` | none        | Verify state, exchange code, org-gate, upsert user+user_orgs, set session cookie |
| GET  | `/api/auth/me`              | web         | Current user |
| POST | `/api/auth/logout`          | web         | Clear session cookie |
| POST | `/api/auth/cli-code`        | web         | Mint a pairing code (in-memory) |
| POST | `/api/auth/cli-exchange`    | none (code) | Redeem code → `aud:cli` JWT |

## Web OAuth flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Server
    participant G as GitHub
    B->>S: GET /auth/github/start
    S->>B: set oauth_state cookie; 302 to GitHub (scope read:org user:email, state)
    B->>G: authorize
    G->>B: 302 /auth/github/callback?code&state
    B->>S: GET /auth/github/callback?code&state
    S->>S: verify state == cookie (CSRF)
    S->>G: exchange code → access_token
    S->>G: GET /user, /user/emails, /user/orgs
    S->>S: gate: user orgs ∩ seeded orgs; empty → reject
    S->>S: upsert users (by github_id); upsert user_orgs
    S->>B: set session cookie (aud:web JWT 7d); 302 app
```

## CLI pairing flow

```mermaid
sequenceDiagram
    participant CLI
    participant B as Browser (web-authed)
    participant S as Server
    CLI->>CLI: samskara login
    B->>S: POST /auth/cli-code (session cookie)
    S->>S: store code → {user_id, expiresAt} in Map (TTL ~5m)
    S->>B: { code }  (UI shows it)
    CLI->>S: POST /auth/cli-exchange { code }   (no auth)
    S->>S: lookup + delete code (single-use); mint aud:cli JWT
    S->>CLI: { token }
    CLI->>CLI: store token (~/.samskara/token)
    CLI->>S: (later) POST /ingest  Authorization: Bearer <token>
```

## Auth middleware

- `requireAuth(aud)` resolves a token from either the `session` cookie (web) or
  `Authorization: Bearer` (cli), verifies signature + issuer + **`aud`** matches the route,
  loads the user, sets `c.get("user")`. Reject on bad/missing/expired/wrong-aud.
- Reads-global / writes-owner (from 2a) layer ON TOP of this — authn here, authz there.

## GithubClient seam

```ts
interface GithubClient {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  getProfile(accessToken: string): Promise<{ githubId: number; login: string; avatarUrl?: string; email?: string }>;
  getOrgs(accessToken: string): Promise<string[]>;         // the user's GitHub org slugs
  getVerifiedEmails(accessToken: string): Promise<string[]>;
}
```
Real impl = raw fetch to GitHub. Tests inject a stub via `buildApp(db, env, { githubClient })`.

## Org seeding (Bun script)

`bun run seed:org <github-slug>` (server package) upserts an `orgs` row
(`github_slug`, resolves `github_org_id` from GitHub or leaves null). The callback gate reads
these rows. No runtime org creation.

## Environment & the GitHub OAuth App

A **real GitHub OAuth App already exists** for local e2e:

- Name: **`samskara (dev)`**, owned by the **`vertexcover-io`** org.
- **Client ID: `Ov23linvZE00y7VZSI4Y`** (public; safe to reference).
- Homepage: `http://localhost:8000` — Callback: `http://localhost:3000/api/auth/github/callback`.
- Device Flow: off.

Ports for this project (NOTE — not 8787/5173): **backend API on `:3000`, web SPA on `:8000`.**

The client secret is **stored in a gitignored `.env`** at repo root. Env keys:

```bash
# Auth / GitHub OAuth
GITHUB_CLIENT_ID=Ov23linvZE00y7VZSI4Y
GITHUB_CLIENT_SECRET=            # ← the secret; set locally, NEVER commit
PUBLIC_BASE_URL=http://localhost:3000     # backend; drives redirect_uri + cookie domain
COOKIE_SECURE=false                       # localhost is HTTP; true only under HTTPS
JWT_SECRET=                               # long random (openssl rand -hex 32)

# DB
DATABASE_URL=postgres://samskara:samskara@localhost:5433/samskara

# Web SPA (Vite)
VITE_API_BASE_URL=http://localhost:3000
```

- Add these to `turbo.json`'s `env:` passthrough (`GITHUB_*`, `PUBLIC_BASE_URL`,
  `COOKIE_SECURE`, `JWT_SECRET`, `DATABASE_URL`, `VITE_API_BASE_URL`).
- Provide a committed `.env.example` with the same keys, values blank for the secrets.
- `vertexcover-io` may restrict third-party OAuth App access; if login fails with an org
  access error, approve `samskara (dev)` under Org → Settings → Third-party access.

## Testing (BOTH required)

### 1. Stubbed integration tests (primary, CI-safe)
Testcontainers Postgres + the injected **stub `GithubClient`** (no live GitHub). Cover, at least:
- callback with a stubbed profile whose orgs **intersect** a seeded org → user + `user_orgs`
  rows created, `session` cookie set, `aud:web` JWT valid.
- callback whose orgs **do NOT** intersect any seeded org → login **rejected** (redirect
  `?error=not_member`), no user row created.
- CSRF: `state` mismatch between cookie and query → rejected.
- user upsert idempotency: second login with same `github_id` updates, does not duplicate.
- pairing: `POST /cli-code` (authed) mints a code; `POST /cli-exchange {code}` returns an
  `aud:cli` JWT; code is single-use (second exchange fails); expired code fails.
- middleware `aud` gating: an `aud:cli` token is rejected on a web-only route and vice versa.
- `seed:org` script inserts/updates an org row.

### 2. Real e2e through the browser (must actually be performed)
Using the real `samskara (dev)` OAuth App + real GitHub login — **this must be run, not just
described**, and its outcome reported:
1. `bun run stack:up && bun run db:migrate`.
2. `bun run seed:org vertexcover-io` (the tester must be a member of that org).
3. Start backend on `:3000` and web on `:8000` (proxy `/api` through Vite to avoid
   cross-origin cookie issues).
4. In a browser: open `http://localhost:8000`, click **Login with GitHub**, approve on
   GitHub, and confirm you land back **authenticated** (session cookie set, `/api/auth/me`
   returns the user).
5. Verify DB: a `users` row + a `user_orgs` row for `vertexcover-io` now exist.
6. Run `samskara login` (CLI), complete the pairing code, and confirm the CLI receives and
   stores an `aud:cli` token.
7. Report the result explicitly (screenshots or the `/api/auth/me` JSON + the DB rows). If
   any step fails, report the exact failure — do not mark the milestone done on green unit
   tests alone.

## Open Questions

1. **`getOrgs` source** — use `GET /user/orgs` (list the user's orgs once, intersect with
   seeded rows) for the multi-org gate. Note: `/user/orgs` returns orgs the user has made
   visible / authorized; if a member's org membership is private, the app may need org
   approval to see it — hence the third-party-access note above. Confirm behavior during e2e.
2. **Token storage path on the CLI** — `~/.samskara/token`, file perms `0600` — build detail.

## External Dependencies & Fallback Chain

- **GitHub OAuth + REST API** — auth surface: oauth (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`)
  + the user token for `/user`, `/user/emails`, `/user/orgs`. Probe use-cases: (a) code→token
  exchange, (b) profile/email read, (c) org membership list. Fallback: none — GitHub is the
  identity provider by definition; if unavailable, login is down (acceptable).
