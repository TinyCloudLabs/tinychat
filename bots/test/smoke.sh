#!/usr/bin/env bash
# Local MOCK-MODEL smoke for the bots service: the real image, real gVisor sandboxes and the real gateway, but the
# model is test/mock-upstream.ts running inside the gateway container (it always answers "pong"). A pass here is
# a mock run, not the happy path against the real model.
#
# Needs Docker (DOCKER="sudo docker" if your user cannot reach the daemon) on a cgroup v2 host.
# SKIP_BUILD=1 reuses $IMAGE. Removes every container, volume and network it creates, also on failure.
# Exits 1 if any containment check fails. CAPS overrides the supervisor's capability set (to try a smaller one); the
# default matches docker-compose.phala.yml.
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
ADDR_D=0x00000000000000000000000000000000000000dd
A=did:pkh:eip155:1:$ADDR_A
B=did:pkh:eip155:1:$ADDR_B
C=did:pkh:eip155:1:0x00000000000000000000000000000000000000cc
D=did:pkh:eip155:1:$ADDR_D
URL=http://127.0.0.1:$PORT/v1/bots/main/messages

cleanup() {
  $DOCKER rm -f "$NAME-supervisor" "$NAME-gateway" >/dev/null 2>&1 || true
  $DOCKER volume rm -f "$NAME-data" "$NAME-egress" "$NAME-budget" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

step() { printf '\n=== %s\n' "$*"; }
bot_id() { printf %s "$1" | sha256sum | cut -c1-64; }
# A settled turn's save pauses the sandbox for its copy; wait that out so an exec never meets a paused sandbox.
sandbox() {
  local id; id=$(bot_id "$1"); shift
  for _ in $(seq 50); do
    $DOCKER exec "$NAME-supervisor" runsc --root=/run/runsc state "bot-${id:0:32}" 2>/dev/null | grep -q '"status": "paused"' || break
    sleep 0.1
  done
  $DOCKER exec "$NAME-supervisor" runsc --root=/run/runsc exec "bot-${id:0:32}" "$@"
}
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

step "supervisor: not privileged (compose capability set, no devices), private cgroup namespace, dummy secret, accounts A, B and D, at most two bots at once, idle stop after ${IDLE_MS} ms"
# Same container settings as docker-compose.phala.yml's bots-supervisor.
CAPS=${CAPS:-SYS_ADMIN SYS_CHROOT SETUID SETGID SETFCAP DAC_OVERRIDE FOWNER FSETID CHOWN KILL}
SUPERVISOR_ARGS=(--cap-drop ALL)
for cap in $CAPS; do SUPERVISOR_ARGS+=(--cap-add "$cap"); done
echo "capabilities: $CAPS"
$DOCKER run -d --name "$NAME-supervisor" "${SUPERVISOR_ARGS[@]}" --cgroupns private --memory 7g \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined -p "127.0.0.1:$PORT:8080" \
  -v "$NAME-data:/data" -v "$NAME-egress:/egress" \
  -e BOTS_SERVICE_SECRET="$SECRET" -e BOTS_TEST_ACCOUNTS="$ADDR_A,$ADDR_B,$ADDR_D" -e BOTS_MAX_RUNNING=2 -e BOTS_IDLE_MS=$IDLE_MS \
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

step "running cap (BOTS_MAX_RUNNING=2): with A and B running, a third owner D is refused"
running_before=$(running | wc -l)
reply_d=$(post "$D" "Reply with exactly: pong")
echo "$reply_d"
check "D is refused at the cap with bot_unavailable" grep -q '"code":"bot_unavailable"' <<<"$reply_d"
check "the cap held: still only A's and B's sandboxes" bash -c "[[ $running_before == 2 && \$($DOCKER exec $NAME-supervisor runsc --root=/run/runsc list -quiet | wc -l) == 2 ]]"

step "no devices: neither the compose nor the supervisor container passes any"
check "compose passes no devices" bash -c "grep -q 'cap_add:' docker-compose.phala.yml && ! grep -qE '^ *devices:' docker-compose.phala.yml"
check "supervisor container has no devices" bash -c "[[ \$($DOCKER inspect -f '{{.State.Running}} {{len .HostConfig.Devices}}' $NAME-supervisor) == 'true 0' ]]"
check "no loop devices in the supervisor" bash -c "$DOCKER exec $NAME-supervisor test -c /dev/null && ! $DOCKER exec $NAME-supervisor sh -c 'ls /dev/loop*'"

step "containment of A (each line should end in PASS)"
# Every negative check first proves the exec it relies on works, so a broken `runsc exec` cannot pass as "refused".
check "runsc exec works in A and B" bash -c "[[ \$(sandbox $A echo ok) == ok && \$(sandbox $B echo ok) == ok ]]"
check "gvisor kernel" bash -c "k=\$(sandbox $A uname -r) && [[ -n \$k && \$k != \"\$(uname -r)\" ]]"
check "egress dir holds only the socket" bash -c "[[ \"\$(sandbox $A ls -A /run/egress)\" == egress.sock ]]"
check "egress dir read-only" bash -c "sandbox $A test -S /run/egress/egress.sock && ! sandbox $A touch /run/egress/x"
sandbox "$A" sh -c 'echo a-note > /root/bot/a-note; echo a-root > /root/a-root; echo a-tmp > /tmp/a-tmp'
check "B cannot see A's state" bash -c "sandbox $A test -s /root/bot/a-note && sandbox $B test -d /root/bot && ! sandbox $B cat /root/bot/a-note"
check "B cannot see A's root layer" bash -c "sandbox $A test -s /root/a-root && sandbox $B true && ! sandbox $B cat /root/a-root"
check "B cannot see A's /tmp" bash -c "sandbox $A test -s /tmp/a-tmp && sandbox $B test -d /tmp && ! sandbox $B cat /tmp/a-tmp"
check "host rootfs untouched by A" bash -c "sandbox $A test -s /root/a-root && $DOCKER exec $NAME-supervisor test -d /bot-rootfs/root && ! $DOCKER exec $NAME-supervisor test -e /bot-rootfs/root/a-root"
check "no DNS / network" bash -c "sandbox $A sh -c 'command -v getent' && ! sandbox $A getent hosts example.com"
check "model key not in sandbox" bash -c "sandbox $A sh -c 'cat /proc/*/environ' | grep -qF BOT_TOKEN && ! sandbox $A sh -c 'cat /proc/*/environ; grep -rs . /root/.omp' | grep -qF mock-model-key"
check "model key not in supervisor" bash -c "$DOCKER exec $NAME-supervisor cat /proc/1/environ | grep -qF BOTS_SERVICE_SECRET && ! $DOCKER exec $NAME-supervisor cat /proc/1/environ | grep -qF REDPILL"
check "gateway refuses other route" bash -c "sandbox $A bun -e 'const r = await fetch(\"http://127.0.0.1:8080/v1/files\", {headers:{authorization:\"Bearer \"+process.env.BOT_TOKEN}}); process.exit(r.status === 403 ? 0 : 1)'"
check "gateway refuses wrong token" bash -c "sandbox $A bun -e 'const r = await fetch(\"http://127.0.0.1:8080/v1/models\", {headers:{authorization:\"Bearer nope\"}}); process.exit(r.status === 403 ? 0 : 1)'"
check "models filtered to the allowlist" bash -c "sandbox $A bun -e 'const r = await fetch(\"http://127.0.0.1:8080/v1/models\", {headers:{authorization:\"Bearer \"+process.env.BOT_TOKEN}}); const j = await r.json(); process.exit(j.data.map(m => m.id).join() === \"z-ai/glm-5.2\" ? 0 : 1)'"
ID_A=$(bot_id "$A")
echo "A cgroup limits: memory.max=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/$ID_A/memory.max) pids.max=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/$ID_A/pids.max) cpu.max=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/$ID_A/cpu.max)"
echo "A writable layers: $(sandbox "$A" df -h / /tmp /root/bot | tail -3 | tr -s ' ' | tr '\n' ';')"
check "A's state is its own tmpfs: 256 MiB, 16384 inodes, nosuid, nodev, noexec" bash -c "o=\$($DOCKER exec $NAME-supervisor findmnt -n -o FSTYPE,OPTIONS /run/bots/$ID_A/state) && [[ \$o == tmpfs* && \$o == *nosuid* && \$o == *nodev* && \$o == *noexec* && \$o == *size=262144k* && \$o == *nr_inodes=16384* ]]"
check "the data volume is mounted nosuid,nodev" bash -c "o=\$($DOCKER exec $NAME-supervisor findmnt -n -o OPTIONS -T /data/bots) && [[ \$o == *nosuid* && \$o == *nodev* ]]"
check "A's state is noexec" bash -c "sandbox $A sh -c 'cp /bin/true /tmp/t && cp /bin/true /root/bot/t' && sandbox $A /tmp/t && ! sandbox $A /root/bot/t"
sandbox "$A" rm -f /tmp/t /root/bot/t
check "a settled turn is saved to disk while A runs" bash -c "$DOCKER exec $NAME-supervisor runsc --root=/run/runsc list -quiet | grep -q bot-${ID_A:0:32} && $DOCKER exec $NAME-supervisor sh -c 'ls -A /data/bots/$ID_A/state/sessions/main | grep -q .'"

step "A: writes stop at each cap (root layer 512M, /tmp 256M, state 256M); in-memory writes are charged to A's cgroup"
memory_current() { $DOCKER exec "$NAME-supervisor" cat "/sys/fs/cgroup/bots/$ID_A/memory.current"; }
before=$(memory_current)
sandbox "$A" dd if=/dev/zero of=/root/fill bs=1M count=300 2>/dev/null
middle=$(memory_current)
echo "A memory.current: before=$(( before / 1048576 ))MiB, after writing 300MiB to the root layer=$(( middle / 1048576 ))MiB"
sandbox "$A" dd if=/dev/zero of=/root/bot/charge bs=1M count=100 2>/dev/null
after=$(memory_current)
echo "A memory.current: after also writing 100MiB to the state tmpfs=$(( after / 1048576 ))MiB"
check "state writes are charged to A's cgroup" bash -c "sandbox $A test -s /root/bot/charge && (( $after - $middle >= 90 * 1048576 ))"
sandbox "$A" rm -f /root/bot/charge
check "root layer refuses writes past its cap" bash -c "! sandbox $A dd if=/dev/zero of=/root/fill2 bs=1M count=400 && sandbox $A test -s /root/fill2"
check "/tmp refuses writes past its cap" bash -c "! sandbox $A dd if=/dev/zero of=/tmp/fill bs=1M count=300 && sandbox $A test -s /tmp/fill"
check "state filesystem refuses writes past its quota" bash -c "! sandbox $A dd if=/dev/zero of=/root/bot/fill bs=1M count=300 && sandbox $A test -s /root/bot/fill"
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

step "gateway with an unreadable budget file refuses to start: one operator line, non-zero exit"
saved_budget=$(budget)
$DOCKER rm -f "$NAME-gateway" >/dev/null
$DOCKER run --rm -v "$NAME-budget:/b" --user 65532:65532 --entrypoint sh "$IMAGE" -c 'echo broken > /b/budget.json'
start_gateway
sleep 3
state=$($DOCKER inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$NAME-gateway")
refusal=$($DOCKER logs "$NAME-gateway" 2>&1 | grep '"refusing_to_start"' || true)
echo "gateway: $state"; echo "$refusal"
check "unreadable budget file: the gateway exits 78" test "$state" == "exited 78"
check "unreadable budget file: one line names the reason" grep -q 'budget.json is unreadable' <<<"$refusal"
$DOCKER run --rm -v "$NAME-budget:/b" --user 65532:65532 -e SAVED="$saved_budget" --entrypoint sh "$IMAGE" -c 'printf %s "$SAVED" > /b/budget.json'
$DOCKER rm -f "$NAME-gateway" >/dev/null
start_gateway
sleep 2
check "restored budget file: the gateway starts with the saved counters" test "$(budget)" == "$saved_budget"

step "A: plant saved-state cases (a note, a setuid file, symlinks to /etc and .., 20 MiB of data) for the idle stop to save"
sandbox "$A" sh -c 'echo kept > /root/bot/note && cp /bin/true /root/bot/suid && chmod 4755 /root/bot/suid && ln -s /etc /root/bot/etc-link && ln -s .. /root/bot/up-link && dd if=/dev/urandom of=/root/bot/blob bs=1M count=20 2>/dev/null'
XATTR=0
if sandbox "$A" sh -c 'command -v setfattr' >/dev/null 2>&1; then
  sandbox "$A" setfattr -n user.planted -v 1 /root/bot/note && XATTR=1
else
  echo "no setfattr in the sandbox: the unit tests cover xattrs"
fi
etc_hash() { $DOCKER exec "$NAME-supervisor" sh -c "find /etc -xdev -printf '%p %s %T@\n' | sort | sha256sum"; }
etc_before=$(etc_hash)
check "planted: a note, a setuid file (4755), symlinks to /etc and .." bash -c "[[ \$(sandbox $A cat /root/bot/note) == kept && \$(sandbox $A stat -c %a /root/bot/suid) == 4755 && \$(sandbox $A readlink /root/bot/etc-link) == /etc && \$(sandbox $A readlink /root/bot/up-link) == .. ]]"

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

step "A's state after the idle stop and restart"
check "state persists across a stop and start" bash -c "[[ \$(sandbox $A cat /root/bot/note) == kept ]]"
check "the setuid bit is dropped by the save and restore" bash -c "sandbox $A test -f /root/bot/suid && [[ \$(sandbox $A stat -c %a /root/bot/suid) == 755 ]]"
check "symlinks to /etc and .. come back as the same symlinks" bash -c "[[ \$(sandbox $A readlink /root/bot/etc-link) == /etc && \$(sandbox $A readlink /root/bot/up-link) == .. ]]"
check "the saved copy holds them as symlinks" bash -c "$DOCKER exec $NAME-supervisor test -L /data/bots/$ID_A/state/etc-link && $DOCKER exec $NAME-supervisor test -L /data/bots/$ID_A/state/up-link"
if [[ $XATTR == 1 ]]; then
  check "xattrs are dropped" bash -c "sandbox $A test -f /root/bot/note && [[ -z \$(sandbox $A getfattr -d /root/bot/note) ]]"
fi
check "supervisor /etc unchanged" test "$(etc_hash)" == "$etc_before"
check "A's directories hold only their own entries" test "$($DOCKER exec "$NAME-supervisor" ls -A "/data/bots/$ID_A") $($DOCKER exec "$NAME-supervisor" ls -A "/run/bots/$ID_A" | tr '\n' ' ')" == "state config.json state "
restore_memory=$($DOCKER exec "$NAME-supervisor" cat /sys/fs/cgroup/bots/restore/memory.current)
echo "/bots/restore memory.current: $(( restore_memory / 1048576 ))MiB"
check "the restored state is charged under /bots" bash -c "[[ \$(sandbox $A stat -c %s /root/bot/blob) == 20971520 ]] && (( $restore_memory >= 20 * 1048576 ))"

step "A: special files. A FIFO the bot makes stays inside gVisor; one on the tmpfs itself stops the next save, and the previous copy stays"
sandbox "$A" sh -c 'echo later > /root/bot/note2 && mkfifo /root/bot/fifo'
check "A cannot create a device node in its state" bash -c "sandbox $A test -p /root/bot/fifo && ! sandbox $A mknod /root/bot/null c 1 3"
check "A's FIFO never reaches the host tmpfs" bash -c "sandbox $A test -p /root/bot/fifo && $DOCKER exec $NAME-supervisor test -s /run/bots/$ID_A/state/note2 && ! $DOCKER exec $NAME-supervisor test -e /run/bots/$ID_A/state/fifo"
$DOCKER exec "$NAME-supervisor" mkfifo "/run/bots/$ID_A/state/host-fifo"
check "planted: a FIFO on A's tmpfs, from the supervisor side" $DOCKER exec "$NAME-supervisor" test -p "/run/bots/$ID_A/state/host-fifo"
sleep $(( IDLE_MS / 1000 + 6 ))
check "idle stop: A stopped" bash -c "[[ -z \$($DOCKER exec $NAME-supervisor runsc --root=/run/runsc list -quiet) ]]"
check "the save refused the FIFO (snapshot_failed, special_file)" bash -c "$DOCKER logs $NAME-supervisor 2>&1 | grep '\"snapshot_failed\"' | grep -q '\"cause\":\"special_file\"'"
reply=$(post "$A" "Reply with exactly: pong")
check "A replies after the restart" grep -q 'event: done' <<<"$reply"
check "the previous copy came back: the note is there; no FIFO, no later note" bash -c "[[ \$(sandbox $A cat /root/bot/note) == kept ]] && ! sandbox $A test -e /root/bot/fifo && ! sandbox $A test -e /root/bot/host-fifo && ! sandbox $A test -e /root/bot/note2"
check "every stop was confirmed (three stops logged, no teardown_unconfirmed)" bash -c "logs=\$($DOCKER logs $NAME-supervisor 2>&1) && [[ \$(grep -c '\"bots\":\"stopped\"' <<<\"\$logs\") -ge 3 ]] && ! grep -q teardown_unconfirmed <<<\"\$logs\""

step "what the MOCK model received (shape only)"
$DOCKER logs "$NAME-gateway" 2>&1 | grep '"mock":"request"' | tail -2
step "gateway decisions"
$DOCKER logs "$NAME-gateway" 2>&1 | grep '"gateway"' | tail -12
step "supervisor log"
$DOCKER logs "$NAME-supervisor" 2>&1 | tail -20

if [[ $FAILED != 0 ]]; then step "MOCK smoke FAILED (see FAIL lines above)"; exit 1; fi
step "MOCK smoke passed (mock model, not the real one)"
