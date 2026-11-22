# syntax=docker/dockerfile:1
# TinyCloud regular bots runtime (TC-3325). Build from the repository root; both images need bots/ as well:
#   docker build -f bots-regular/Dockerfile --target sandbox -t bots-regular-sandbox .   every bot's sandbox
#   docker build -f bots-regular/Dockerfile -t bots-regular .                             service and gateway
# The service image runs as two containers (deploy/bots-regular.yaml): the service (bun src/main.ts) and the gateway
# (bun src/gateway-main.ts).
ARG BUN_IMAGE=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e

# A bot's sandbox: OMP from bots/sandbox's lockfile, and the bridge the sandbox host starts with every pod.
FROM ${BUN_IMAGE} AS sandbox
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/omp
COPY bots/sandbox/package.json bots/sandbox/bun.lock ./
RUN bun install --frozen-lockfile \
 && ln -s /opt/omp/node_modules/.bin/omp /usr/local/bin/omp \
 && omp --version
COPY bots-regular/sandbox/bridge.ts bots-regular/sandbox/arm.ts /opt/bridge/
# The bots' system prompts (the bridge picks one per bot) and the role-neutral fallback, as in bots/Dockerfile.
COPY bots/sandbox/prompts/ /opt/tinycloud/prompts/
COPY bots/sandbox/prompts/sibling.md /root/.omp/agent/SYSTEM.md
WORKDIR /root

FROM ${BUN_IMAGE}
# The gateway's budget volume is created from this directory, so it starts owned by the gateway's user.
RUN mkdir -p /var/lib/bots-gateway && chown 65532:65532 /var/lib/bots-gateway
WORKDIR /app/bots
COPY bots/package.json bots/bun.lock bots/tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY bots/src ./src
WORKDIR /app/bots-regular
COPY bots-regular/package.json bots-regular/bun.lock bots-regular/tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY bots-regular/src ./src
COPY bots-regular/sandbox ./sandbox
# The cluster check runs from the deployed container (README, "Cluster check").
COPY bots-regular/scripts ./scripts
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER 65532:65532
CMD ["bun", "src/main.ts"]
