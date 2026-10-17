#!/usr/bin/env bash
# TC-987 S0: run a throwaway local tinycloud-node in its own process group,
# with a watchdog that kills the whole group after TTL seconds or when this
# wrapper exits. Loopback only; data under $DIR; never production.
# BIN: `cargo build -p tinycloud-node` of TinyCloudLabs/tinycloud-node (S0 used
# main 212a8265). A fresh node key is generated per data dir.
set -euo pipefail
BIN=${BIN:-/tmp/tc987-s0/target/debug/tinycloud}
DIR=${DIR:-/tmp/tc987-s0/node-data}
PORT=${PORT:-18471}
TTL=${TTL:-7200}
mkdir -p "$DIR/blocks"
umask 077
[ -f "$DIR/node.key" ] || openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' > "$DIR/node.key"
cd "$DIR"
export TINYCLOUD_KEYS__TYPE=Static TINYCLOUD_KEYS__SECRET="$(cat node.key)"
export TINYCLOUD_ADDRESS=127.0.0.1 TINYCLOUD_PORT=$PORT
export TINYCLOUD_STORAGE__DATADIR="$DIR" TINYCLOUD_STORAGE__DATABASE="sqlite:$DIR/caps.db?mode=rwc"
export TINYCLOUD_STORAGE__BLOCKS__TYPE=Local TINYCLOUD_STORAGE__BLOCKS__PATH="$DIR/blocks"
export TINYCLOUD_PROMETHEUS__PORT=$((PORT + 1)) TINYCLOUD_TELEMETRY__ENABLED=false
export ROCKET_ADDRESS=127.0.0.1 ROCKET_PORT=$PORT
setsid "$BIN" &
NODE_PID=$!
PGID=$NODE_PID   # setsid makes the child a session + group leader
echo "$PGID" > "$DIR/node.pgid"
kill_group() { kill -TERM -- "-$PGID" 2>/dev/null || true; sleep 3; kill -KILL -- "-$PGID" 2>/dev/null || true; }
trap kill_group EXIT INT TERM HUP
( sleep "$TTL"; echo "watchdog: TTL ${TTL}s reached, killing pgid $PGID" >&2; kill -TERM -- "-$PGID" 2>/dev/null; sleep 3; kill -KILL -- "-$PGID" 2>/dev/null ) &
echo "node pid/pgid=$PGID port=$PORT dir=$DIR ttl=${TTL}s"
wait "$NODE_PID"
