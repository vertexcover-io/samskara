# Knowledge Index

Derived from frontmatter — do not edit. Regenerate: knowledge.mjs reindex.

- [Testing realpath-sensitive code and try/catch guards needs matching rigor, not just a passing assertion](lessons/gotchas/realpath-fixtures-and-provable-catch-guards-20260801.md) · applies_to: packages/cli/src/watcher/*.test.ts · tags: vitest, realpath, macos, symlink, mutation-testing, try-catch, tautological-test · ec:2 · 2026-08-01
- [Hand-written extraction regexes need adversarial real-world inputs, not just happy-path examples](lessons/gotchas/regex-extractor-boundary-gotchas-20260801.md) · applies_to: packages/cli/src/watcher/artifact-extract.ts · tags: regex, parsing, html, markdown, boundary-conditions · ec:1 · 2026-08-01
- [A new containment-check call site must realpath before isCapturable, or a symlink escapes it](lessons/gotchas/symlink-containment-bypass-missing-realpath-20260801.md) · applies_to: packages/cli/src/watcher/*.ts · tags: symlink, containment, security, realpath, toctou · ec:1 · 2026-08-01
- [os.tmpdir() resolves to /tmp under turbo, breaking isCapturable-based fixtures](lessons/gotchas/tmpdir-turbo-excluded-root-mismatch-20260801.md) · applies_to: packages/cli/src/watcher/*.test.ts, packages/cli/src/watcher/containment.ts · tags: tmpdir, turbo, containment, vitest, macos, fixtures · ec:1 · 2026-08-01
