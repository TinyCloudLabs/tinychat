#!/usr/bin/env bash
# Runs the Main, sibling, legacy, and revoke bot-history suites against an isolated TinyCloud node. Details: TC-3968
set -euo pipefail

image=ghcr.io/tinycloudlabs/tinycloud-node:1.26.22@sha256:03ea20ea9136b47cf6cf1f6b05ebae262dadda297d23d568c98fccf9c86f0c62
run=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/bot-history.XXXXXX")
container=
node_pid=
trap '
  if [[ -n "$node_pid" ]]; then
    kill "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true
  fi
  if [[ -n "$container" ]]; then docker rm "$container" >/dev/null || true; fi
  rm -rf "$run"
' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker pull "$image"
container=$(docker create "$image")
docker cp "$container:/tinycloud" "$run/tinycloud"
docker rm "$container" >/dev/null
container=
mkdir "$run/data" "$run/home" "$run/tmp"
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
secret=$(openssl rand -hex 32)
(
  cd "$run"
  exec env -i HOME="$run/home" TMPDIR="$run/tmp" \
    TINYCLOUD_STORAGE__DATADIR="$run/data" \
    TINYCLOUD_ADDRESS=127.0.0.1 TINYCLOUD_PORT="$port" \
    ROCKET_ADDRESS=127.0.0.1 ROCKET_PORT="$port" \
    TINYCLOUD_KEYS__TYPE=Static TINYCLOUD_KEYS__SECRET="$secret" \
    TINYCLOUD_ENCRYPTION_NETWORK__NAMED_KEYS_V1=true \
    TINYCLOUD_ENCRYPTION_NETWORK__DELETION_LEDGER_PATH="$run/deletions.jsonl" \
    ./tinycloud
) >"$run/node.log" 2>&1 &
node_pid=$!
host="http://127.0.0.1:$port"

ready=false
for _ in {1..30}; do
  if ! kill -0 "$node_pid" 2>/dev/null; then break; fi
  if curl --disable --noproxy '*' --max-time 1 -fs "$host/healthz" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "::error::TinyCloud node at $host did not become ready"
  cat "$run/node.log"
  exit 1
fi
curl --disable --noproxy '*' --max-time 5 -fsS "$host/info" |
  jq -ce 'select(any(.features[]; . == "encryption-named-keys-v1")) | {version, protocol, features}' || {
    echo "::error::TinyCloud node at $host did not advertise encryption-named-keys-v1"
    exit 1
  }
echo "TinyCloud node ready at $host"

cd backend
status=0
for suite in bot-history-network.test.ts bot-history-siblings-network.test.ts bot-history-legacy-network.test.ts bot-history-revoke-network.test.ts; do
  log="$run/$suite.log"
  if ! env -i PATH="$PATH" HOME="$run/home" TMPDIR="$run/tmp" BOT_HISTORY_TEST_NODE="$host" BOT_REVOKE_TEST_NODE="$host" \
    bun --no-env-file test "./src/__tests__/$suite" 2>&1 | tee "$log"; then
    status=1
  elif grep -Eq '^ *[1-9][0-9]* skip' "$log" || ! grep -Eq '^ *[1-9][0-9]* pass' "$log"; then
    echo "::error::$suite must pass without skips"
    status=1
  fi
done
exit "$status"
