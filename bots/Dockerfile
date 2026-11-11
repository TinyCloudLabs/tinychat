# syntax=docker/dockerfile:1
# TinyCloud bots service (TC-2808). One image, two containers (see docker-compose.phala.yml):
#   supervisor  not privileged, but holds the capabilities runsc needs (see the compose); internal API + sandboxes
#   gateway     unprivileged user, no capabilities; egress + the model key            bun src/gateway-main.ts
# Build from this directory: docker build -t tinychat-bots bots/
# The image holds no keys.
ARG BUN_IMAGE=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e

# Bot root filesystem: the shared read-only lower layer of every bot sandbox.
FROM ${BUN_IMAGE} AS bot
RUN apt-get update && apt-get install -y --no-install-recommends socat ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/omp
# The agent and every transitive dependency come from the committed lockfile; nothing floats.
COPY sandbox/package.json sandbox/bun.lock ./
RUN bun install --frozen-lockfile \
 && ln -s /opt/omp/node_modules/.bin/omp /usr/local/bin/omp \
 && omp --version
COPY sandbox/bot-start.sh /usr/local/bin/bot-start.sh
RUN chmod 0755 /usr/local/bin/bot-start.sh
WORKDIR /root

FROM ${BUN_IMAGE}
ARG GVISOR_RELEASE=20261102.0
ARG GVISOR_SHA512=2e6671bb2d033b871c5811ab57e16ac570988b0e0054c525f911cfaf191bab3ca4efb08e0a98daa4b9e7d248f9e5776ef2ef2f8a6b82d829646a42924c98bb05
# e2fsprogs: per-bot fixed-size state filesystems. curl and bzip2 are only for fetching gVisor and are removed.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates e2fsprogs curl bzip2 \
 && curl -fsSL -o /tmp/gvisor.tar.bz2 "https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/x86_64/gvisor.tar.bz2" \
 && echo "${GVISOR_SHA512}  /tmp/gvisor.tar.bz2" | sha512sum -c - \
 && mkdir -p /opt/gvisor && tar -xjf /tmp/gvisor.tar.bz2 -C /opt/gvisor && rm /tmp/gvisor.tar.bz2 \
 && ln -s /opt/gvisor/runsc /usr/local/bin/runsc && runsc --version \
 && apt-get purge -y curl bzip2 && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=bot / /bot-rootfs
# The gateway's budget volume is created from this directory, so it starts owned by the gateway's user.
RUN mkdir -p /var/lib/bots-gateway && chown 65532:65532 /var/lib/bots-gateway
WORKDIR /bots
COPY package.json tsconfig.json ./
COPY src ./src
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
CMD ["bun", "src/supervisor.ts"]
