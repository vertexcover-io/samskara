FROM oven/bun:1.2.19 AS builder
WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.base.json biome.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# --ignore-scripts: the root `prepare` script runs `bun run --cwd packages/core
# build`, which needs tsconfig.build.json and src/ — neither is present at this
# layer (only package.json manifests are, to keep the install layer cacheable).
# The hook is a local-dev convenience and has no role in the image.
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/web packages/web

# Order matters: packages/web imports RPC types from @samskara/server, which
# resolve via server's dist/index.d.ts. Building web first leaves those types
# `unknown` and `tsc --noEmit` fails. core -> server -> web mirrors the
# `dependsOn: ["^build"]` ordering turbo derives for `bun run build`.
RUN bun run --filter @samskara/core build
RUN bun run --filter @samskara/server build
RUN bun run --filter @samskara/web build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV WEB_DIST=packages/web/dist

# The AI reviewer shells out to a coding-agent CLI (see packages/core/src/review/runner.ts),
# so both harnesses are installed into the image. Each release build takes the current CLI;
# the image a tag produces is immutable, so a deploy never changes reviewer version on its
# own. Pass --build-arg CLAUDE_CODE_VERSION=x.y.z to pin one. git is there because Claude Code
# probes the workspace for a repository on start; ca-certificates for the provider APIs.
ARG CLAUDE_CODE_VERSION=latest
ARG OPENCODE_VERSION=latest
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-fund --no-audit \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && claude --version \
    && opencode --version

# Review harness configuration (AI_REVIEW_HARNESS, AI_REVIEW_HARDEN, credentials) comes from
# the deployment environment, not the image.

COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/package.json packages/core/package.json
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/server/package.json packages/server/package.json
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/packages/server/migrations packages/server/migrations
COPY --from=builder /app/packages/web/dist packages/web/dist

EXPOSE 3000

# Claude Code refuses --dangerously-skip-permissions as root, and the runner always passes it.
# `node` is the uid 1000 user the base image ships. Nothing under /app is written at runtime;
# review workspaces go to the tmpdir, which is world-writable.
USER node

CMD ["sh", "-c", "node packages/server/dist/scripts/migrateRuntime.js && exec node packages/server/dist/index.js"]
