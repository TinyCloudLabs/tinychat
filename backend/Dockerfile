# syntax=docker/dockerfile:1.7

# 1.4.0 restores response-close notification after a consumed POST body, which
# agent-stream cancellation requires (covered by the real-socket regression).
FROM oven/bun:1.4.0 AS app
WORKDIR /app

ENV HUSKY=0
ARG BUILD_REVISION=unknown
ENV BUILD_REVISION=${BUILD_REVISION}

# tinychat's root `postinstall` shells out to `node`
# (packages/client/scripts/fix-web-wasm-init.mjs and
# packages/server/scripts/fix-wasm-esm.mjs). The oven/bun image does not ship
# Node, so install it before `bun install` or the install step fails.
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.base.json turbo.json ./
COPY manifest.json ./
COPY packages ./packages
COPY backend ./backend
COPY frontend/package.json ./frontend/package.json
COPY test/package.json ./test/package.json
COPY desktop/package.json ./desktop/package.json

RUN bun install --frozen-lockfile
RUN cd packages/core && bun run build
RUN cd packages/server && bun run build
RUN cd backend && bun run build

WORKDIR /app/backend
EXPOSE 3001

CMD ["bun", "run", "start"]
