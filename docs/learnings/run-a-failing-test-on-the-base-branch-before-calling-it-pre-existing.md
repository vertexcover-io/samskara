---
signal: Use when a test fails and you are about to call the failure pre-existing or unrelated to the change
paths: ["e2e/**", "packages/**/*.test.ts", "packages/**/*.test.tsx", "scripts/**/*.test.ts"]
tags: [testing, e2e, verification]
strength: hard-rule
---
# Run a failing test on the base branch before calling it pre-existing

Before reporting a failing test as pre-existing, run the same test command on the base branch and report both results side by side. "Likely pre-existing" without that run is a guess.

**Occurrences:**
- 2026-11-11 · implement reported 5 failing e2e tests as likely pre-existing without checking; the user asked for the master run, which showed the same 5 failing there.

**Stale when:** the e2e suite (`e2e/playwright.config.ts`) is removed, or CI runs every test suite on the base branch and its results are what a change is compared against.
