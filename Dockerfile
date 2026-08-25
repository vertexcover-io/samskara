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
ENV WEB_DIST=/app/packages/web/dist

COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/package.json packages/core/package.json
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/server/package.json packages/server/package.json
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/packages/server/migrations packages/server/migrations
COPY --from=builder /app/packages/web/dist packages/web/dist

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
