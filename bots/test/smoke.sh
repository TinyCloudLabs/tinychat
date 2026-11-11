#!/usr/bin/env bash
# Local MOCK-MODEL smoke for the bots service: the real image, real gVisor sandboxes and the real gateway, but the
# model is test/mock-upstream.ts running inside the gateway container (it always answers "pong"). A pass here is
# a mock run, not the happy path against the real model.
#
# Needs Docker (DOCKER="sudo docker" if your user cannot reach the daemon) on a cgroup v2 host.
# SKIP_BUILD=1 reuses $IMAGE. Removes every container, volume and network it creates, also on failure.
# Exits 1 if any containment check fails. CAPS / DEVICES override the supervisor's capability and device set (to
# try a smaller one); the defaults match docker-compose.phala.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

DOCKER=${DOCKER:-docker}
IMAGE=${IMAGE:-tinychat-bots:smoke}
NAME=tc2808-bots-smoke
PORT=${PORT:-18080}
# Long enough for the containment checks below to run before the idle stop.
IDLE_MS=30000
SECRET=$(openssl rand -hex 32)
ADDR_A=0x00000000000000000000000000000000000000aa
ADDR_B=0x00000000000000000000000000000000000000bb
A=did:pkh:eip155:1:$ADDR_A
B=did:pkh:eip155:1:$ADDR_B
C=did:pkh:eip155:1:0x00000000000000000000000000000000000000cc
URL=http://127.0.0.1:$PORT/v1/bots/main/messages

cleanup() {
  $DOCKER rm -f "$NAME-supervisor" "$NAME-gateway" >/dev/null 2>&1 || true
  $DOCKER volume rm -f "$NAME-data" "$NAME-egress" "$NAME-budget" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

step() { printf '\n=== %s\n' "$*"; }
bot_id() { printf %s "$1" | sha256sum | cut -c1-64; }
sandbox() { local id; id=$(bot_id "$1"); shift; $DOCKER exec "$NAME-supervisor" runsc --root=/run/runsc exec "bot-${id:0:32}" "$@"; }
post() { curl -sN -X POST -H "authorization: Bearer $SECRET" -H "x-tinycloud-owner: $1" -H 'content-type: application/json' -d "{\"text\":\"$2\"}" "$URL"; }
list() { curl -s -H "authorization: Bearer $SECRET" -H "x-tinycloud-owner: $1" "$URL"; }
running() { $DOCKER exec "$NAME-supervisor" runsc --root=/run/runsc list -quiet | sort; }
FAILED=0
check() { if "${@:2}" >/dev/null 2>&1; then echo "PASS $1"; else echo "FAIL $1"; FAILED=1; fi; }
export -f sandbox bot_id
export DOCKER NAME

if [[ ${SKIP_BUILD:-0} != 1 ]]; then step "build $IMAGE"; $DOCKER build -q -t "$IMAGE" .; fi

$DOCKER volume create "$NAME-data" >/dev/null
$DOCKER volume create --driver local --opt type=tmpfs --opt device=tmpfs \
  --opt o=uid=65532,gid=65532,mode=0711,size=16m "$NAME-egress" >/dev/null

step "gateway: unprivileged, read-only, no capabilities, no network; MOCK model on its loopback"
start_gateway() {
  $DOCKER run -d --name "$NAME-gateway" --network none --user 65532:65532 --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --tmpfs /tmp \
    -v "$NAME-egress:/egress" -v "$NAME-budget:/var/lib/bots-gateway" -v "$PWD/test/mock-upstream.ts:/mock/mock-upstream.ts:ro" \
    -e REDPILL_API_KEY=mock-model-key -e BOTS_TEST_UPSTREAM_URL=http://127.0.0.1:9099 \
    --entrypoint sh "$IMAGE" -c 'bun /mock/mock-upstream.ts & exec bun src/gateway-main.ts' >/dev/null
}
start_gateway

step "supervisor: not privileged (compose capability set), private cgroup namespace, dummy secret, accounts A and B only, idle stop after ${IDLE_MS} ms"
# Same container settings as docker-compose.phala.yml's bots-supervisor.
CAPS=${CAPS:-SYS_ADMIN SYS_CHROOT SETUID SETGID SETFCAP DAC_OVERRIDE FOWNER FSETID CHOWN KILL}
DEVICES=${DEVICES:-/dev/loop-control /dev/loop0 /dev/loop1 /dev/loop2 /dev/loop3 /dev/loop4 /dev/loop5 /dev/loop6 /dev/loop7}
SUPERVISOR_ARGS=(--cap-drop ALL)
for cap in $CAPS; do SUPERVISOR_ARGS+=(--cap-add "$cap"); done
for device in $DEVICES; do SUPERVISOR_ARGS+=(--device "$device"); done
echo "capabilities: $CAPS"
echo "devices: $DEVICES"
$DOCKER run -d --name "$NAME-supervisor" "${SUPERVISOR_ARGS[@]}" --cgroupns private --memory 7g \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined -p "127.0.0.1:$PORT:8080" \
  -v "$NAME-data:/data" -v "$NAME-egress:/egress" \
  -e BOTS_SERVICE_SECRET="$SECRET" -e BOTS_TEST_ACCOUNTS="$ADDR_A,$ADDR_B" -e BOTS_IDLE_MS=$IDLE_MS \
  "$IMAGE" >/dev/null
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/healthz"; echo

step "auth: no secret / wrong secret / missing owner / unlisted owner C (all expect 401)"
status_of() { curl -s -o /dev/null -w '%{http_code}' "$@" "$URL"; }
check "no secret: 401" test "$(status_of)" == 401
check "wrong secret: 401" test "$(status_of -H 'authorization: Bearer wrong' -H "x-tinycloud-owner: $A")" == 401
check "missing owner: 401" test "$(status_of -H "authorization: Bearer $SECRET")" == 401
check "unlisted owner: 401" test "$(status_of -H "authorization: Bearer $SECRET" -H "x-tinycloud-owner: $C")" == 401

step "A: list before any message (expect empty, no sandbox started)"
list "$A"; echo; echo "sandboxes: [$(running | tr '\n' ' ')]"
check "empty history starts no sandbox" bash -c "[[ -z \$($DOCKER exec $NAME-supervisor runsc --root=/run/runsc list -quiet) ]]"

step "A: POST 'Reply with exactly: pong' (MOCK model; cold start)"
time reply_a=$(post "$A" "Reply with exactly: pong")
echo "$reply_a"
check "A streams deltas then done" grep -qz 'event: delta.*event: done' <<<"$reply_a"

step "B: POST 'Reply with exactly: pong' (MOCK model; cold start)"
reply_b=$(post "$B" "Reply with exactly: pong")
echo "$reply_b"
check "B streams deltas then done" grep -qz 'event: delta.*event: done' <<<"$reply_b"

step "A: two sends at once (one must get busy)"
post "$A" "first" > /tmp/$NAME-1.sse & sleep 0.3; second=$(post "$A" "second"); echo "$second"
check "second send gets busy" grep -q '"code":"busy"' <<<"$second"
echo "--- list while the first streams: $(list "$A")"
wait; echo "--- first:"; cat /tmp/$NAME-1.sse; rm -f /tmp/$NAME-1.sse

step "lists (done messageId must match the bot message id)"
history_a=$(list "$A"); echo "A: $history_a"
history_b=$(list "$B"); echo "B: $history_b"
done_a=$(grep -o '"messageId":"[^"]*"' <<<"$reply_a" | cut -d'"' -f4)
check "A's done id is its listed reply id" grep -qF "\"id\":\"$done_a\",\"role\":\"bot\"" <<<"$history_a"
check "B's history holds only B's turn" bash -c "[[ \$(grep -o '\"role\":\"user\"' <<<'$history_b' | wc -l) == 1 ]]"

step "two owners, two sandboxes"
echo "bot ids: A=$(bot_id "$A" | cut -c1-12)… B=$(bot_id "$B" | cut -c1-12)…"
running
$DOCKER exec "$NAME-supervisor" sh -c 'ls /data/bots; ls /egress'
check "two running sandboxes" bash -c "[[ \$($DOCKER exec $NAME-supervisor runsc --root=/run/runsc list -quiet | wc -l) == 2 ]]"
echo "all bots together (parent cgroup): memory.max=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/memory.max) pids.max=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/pids.max)"
check "aggregate cgroup caps set" bash -c "[[ \$($DOCKER exec $NAME-supervisor cat /sys/fs/cgroup/bots/memory.max) == $((6144 * 1048576)) && \$($DOCKER exec $NAME-supervisor cat /sys/fs/cgroup/bots/pids.max) == 2048 ]]"

step "containment of A (each line should end in PASS)"
check "gvisor kernel" bash -c "[[ \"\$(sandbox $A uname -r 2>/dev/null)\" != \"\$(uname -r)\" ]]"
check "egress dir holds only the socket" bash -c "[[ \"\$(sandbox $A ls -A /run/egress)\" == egress.sock ]]"
check "egress dir read-only" bash -c "! sandbox $A touch /run/egress/x"
sandbox "$A" sh -c 'echo a-note > /root/bot/a-note; echo a-root > /root/a-root; echo a-tmp > /tmp/a-tmp'
check "B cannot see A's state" bash -c "! sandbox $B cat /root/bot/a-note"
check "B cannot see A's root layer" bash -c "! sandbox $B cat /root/a-root"
check "B cannot see A's /tmp" bash -c "! sandbox $B cat /tmp/a-tmp"
check "host rootfs untouched by A" bash -c "! $DOCKER exec $NAME-supervisor test -e /bot-rootfs/root/a-root"
check "no DNS / network" bash -c "! sandbox $A getent hosts example.com"
check "model key not in sandbox" bash -c "! sandbox $A sh -c 'cat /proc/*/environ; grep -rs . /root/.omp' | grep -qF mock-model-key"
check "model key not in supervisor" bash -c "! $DOCKER exec $NAME-supervisor sh -c 'cat /proc/1/environ' | grep -qF REDPILL"
check "gateway refuses other route" bash -c "sandbox $A bun -e 'const r = await fetch(\"http://127.0.0.1:8080/v1/files\", {headers:{authorization:\"Bearer \"+process.env.BOT_TOKEN}}); process.exit(r.status === 403 ? 0 : 1)'"
check "gateway refuses wrong token" bash -c "sandbox $A bun -e 'const r = await fetch(\"http://127.0.0.1:8080/v1/models\", {headers:{authorization:\"Bearer nope\"}}); process.exit(r.status === 403 ? 0 : 1)'"
check "models filtered to the allowlist" bash -c "sandbox $A bun -e 'const r = await fetch(\"http://127.0.0.1:8080/v1/models\", {headers:{authorization:\"Bearer \"+process.env.BOT_TOKEN}}); const j = await r.json(); process.exit(j.data.map(m => m.id).join() === \"z-ai/glm-5.2\" ? 0 : 1)'"
ID_A=$(bot_id "$A")
echo "A cgroup limits: memory.max=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/$ID_A/memory.max) pids.max=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/$ID_A/pids.max) cpu.max=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/$ID_A/cpu.max)"
echo "A writable layers: $(sandbox "$A" df -h / /tmp /root/bot | tail -3 | tr -s ' ' | tr '\n' ';')"

step "A: writes stop at each cap (root layer 512M, /tmp 256M, state 256M); in-memory writes are charged to A's cgroup"
memory_current() { $DOCKER exec "$NAME-supervisor" cat "/sys/fs/cgroup/bots/$ID_A/memory.current"; }
before=$(memory_current)
sandbox "$A" dd if=/dev/zero of=/root/fill bs=1M count=300 2>/dev/null
echo "A memory.current: before=$(( before / 1048576 ))MiB, after writing 300MiB to the root layer=$(( $(memory_current) / 1048576 ))MiB"
check "root layer refuses writes past its cap" bash -c "! sandbox $A dd if=/dev/zero of=/root/fill2 bs=1M count=400"
check "/tmp refuses writes past its cap" bash -c "! sandbox $A dd if=/dev/zero of=/tmp/fill bs=1M count=300"
check "state filesystem refuses writes past its quota" bash -c "! sandbox $A dd if=/dev/zero of=/root/bot/fill bs=1M count=300"
sandbox "$A" rm -f /root/fill /root/fill2 /tmp/fill /root/bot/fill

step "gateway restart: budgets persist on its volume, the supervisor registers A again"
budget() { $DOCKER exec "$NAME-gateway" cat /var/lib/bots-gateway/budget.json; }
before_restart=$(budget)
echo "budget before: $before_restart"
$DOCKER rm -f "$NAME-gateway" >/dev/null
start_gateway
sleep 2
after_restart=$(budget)
echo "budget after:  $after_restart"
check "budget counters survive a gateway restart" test "$before_restart" == "$after_restart"
reply=$(post "$A" "Reply with exactly: pong")
echo "$reply" | tr '\n' ' '; echo
check "A replies through the restarted gateway" grep -q 'event: done' <<<"$reply"

step "idle stop: wait $(( IDLE_MS / 1000 + 6 ))s, then A and B are stopped"
sleep $(( IDLE_MS / 1000 + 6 ))
echo "sandboxes: [$(running | tr '\n' ' ')]"
check "idle sandboxes stopped" bash -c "[[ -z \$($DOCKER exec $NAME-supervisor runsc --root=/run/runsc list -quiet) ]]"

step "A again after idle stop: restarts on the same session"
reply=$(post "$A" "Reply with exactly: pong")
echo "$reply"
check "A replies after a restart" grep -q 'event: done' <<<"$reply"
history=$(list "$A")
echo "A: $history"
check "A's history kept across restarts (4 turns)" bash -c "[[ \$(grep -o '\"role\":\"bot\"' <<<'$history' | wc -l) == 4 ]]"

step "what the MOCK model received (shape only)"
$DOCKER logs "$NAME-gateway" 2>&1 | grep '"mock":"request"' | tail -2
step "gateway decisions"
$DOCKER logs "$NAME-gateway" 2>&1 | grep '"gateway"' | tail -12
step "supervisor log"
$DOCKER logs "$NAME-supervisor" 2>&1 | tail -20

if [[ $FAILED != 0 ]]; then step "MOCK smoke FAILED (see FAIL lines above)"; exit 1; fi
step "MOCK smoke passed (mock model, not the real one)"
