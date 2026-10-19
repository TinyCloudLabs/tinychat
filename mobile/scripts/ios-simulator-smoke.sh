#!/usr/bin/env bash
# Boot an iOS Simulator, install a Debug simulator build of Exo, grant the microphone, launch it and prove it came
# up. Fails unless, within SMOKE_TIMEOUT seconds:
#   - the debug-only probe in ExoBridgeViewController logs `EXO_SMOKE {json}` with the bundled web app at
#     capacitor://localhost, platform "ios", React mounted into #root, the VoiceNotes plugin visible to JS and
#     its status() answering over the bridge with state "idle" and the 3-hour recording limit, and its
#     readAudioChunk() refusing a missing recording with "not_found", and the web app's PWA service worker skipped;
#   - the Debug-only Location plugin (TC-524 spike) is visible to JS and its status() reports the Debug Info.plist
#     keys (usage strings and the location background mode);
#   - the app is still running SMOKE_SETTLE seconds later, and left no crash report.
# With location granted ("Always") and a simulated position set, the app also runs a location capture probe
# (EXO_LOCATION_SMOKE=1 in its environment) and logs `EXO_LOCATION_SMOKE {json}`; its results are reported in the
# summary but do not fail the job (simulated location delivery is not a property of the app).
# Writes screenshot.png, sanitized console.log, allowlisted unified.log and app-unified-stream.log, structural
# liveness/launch evidence, and summary.md to <out-dir>; crash reports are counted but never copied.
#
# Usage (macOS with Xcode, jq):
#   mobile/scripts/ios-simulator-smoke.sh boot <out-dir>           pick the simulator and start booting it, so the
#                                                                  first boot overlaps the app build (optional)
#   mobile/scripts/ios-simulator-smoke.sh run <App.app> <out-dir>  the smoke test
set -uo pipefail

usage="usage: ios-simulator-smoke.sh boot <out-dir> | run <App.app> <out-dir>"
command=${1:?$usage}
case "$command" in
  boot) out=${2:?$usage} ;;
  run) app=${2:?$usage}; out=${3:?$usage} ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
bundle_id=xyz.tinycloud.exo
timeout_s=${SMOKE_TIMEOUT:-120}
settle_s=${SMOKE_SETTLE:-10}
# Post-publication observation gap that fails the run; the 30 s default is the documented contract.
gap_fail_s=${SMOKE_GAP_FAIL_S:-30}
capture_smoke=${EXO_CAPTURE_SMOKE:-1}
location_smoke=${EXO_LOCATION_SMOKE:-1}

mkdir -p "$out"
out=$(cd "$out" && pwd)
failures=()
fail() { failures+=("$1"); echo "::error::iOS smoke: $1"; }
log() { echo "[smoke $(date -u +%H:%M:%S)] $*"; }
# Stage names and UTC wall epochs are fixed structural fields; no command output or app content.
time_stage() {
  local stage=$1 started status wall_start wall_end
  shift
  started=$SECONDS
  wall_start=$(date -u +%s)
  "$@"
  status=$?
  wall_end=$(date -u +%s)
  printf '%s start_epoch_s=%s end_epoch_s=%s duration_s=%s\n' \
    "$stage" "$wall_start" "$wall_end" "$((SECONDS - started))" >>"$out/stage-timings.log"
  return "$status"
}

if [ "$command" = run ]; then : >"$out/stage-timings.log"; fi
# The newest iOS runtime that has an iPhone simulator; `boot` remembers it in device.txt for `run`.
if [ -f "$out/device.txt" ]; then
  read -r runtime udid device <"$out/device.txt"
else
  read -r runtime udid device < <(xcrun simctl list devices available -j | jq -r \
  --arg chosen_runtime "${EXO_SMOKE_RUNTIME:-}" --arg chosen_device "${EXO_SMOKE_DEVICE_TYPE:-}" '
  .devices | to_entries
  | map(select(.key | test("SimRuntime\\.iOS-[0-9]+-[0-9]+")))
  | map(select($chosen_runtime == "" or .key == $chosen_runtime))
  | map({runtime: .key,
         version: (.key | capture("iOS-(?<major>[0-9]+)-(?<minor>[0-9]+)") | [(.major | tonumber), (.minor | tonumber)]),
         iphones: [.value[] | select((.deviceTypeIdentifier | contains("iPhone")) and
           ($chosen_device == "" or .name == $chosen_device or .deviceTypeIdentifier == $chosen_device))]})
  | map(select(.iphones | length > 0))
  | sort_by(.version) | last // empty
  | "\(.runtime) \(.iphones[0].udid) \(.iphones[0].name)"')
  [ -n "${udid:-}" ] || { echo "::error::no available iPhone simulator"; xcrun simctl list devices available; exit 1; }
  echo "$runtime $udid $device" >"$out/device.txt"
fi
log "device: $device ($udid), runtime ${runtime##*.}"

if [ "$command" = boot ]; then
  xcrun simctl boot "$udid" 2>&1 | grep -v 'current state: Booted' || true
  log "boot requested"
  exit 0
fi

[ -d "$app" ] || { echo "::error::no app bundle at $app"; exit 1; }
time_stage main.privacy-lint plutil -lint "$app/PrivacyInfo.xcprivacy" || fail "App.app has no valid PrivacyInfo.xcprivacy"

log "waiting for the simulator to finish booting"
time_stage main.bootstatus xcrun simctl bootstatus "$udid" -b >/dev/null || { echo "::error::simulator $udid did not boot"; exit 1; }
log "booted; installing $app"
time_stage main.install xcrun simctl install "$udid" "$app" || { echo "::error::install failed"; exit 1; }
time_stage main.microphone-grant xcrun simctl privacy "$udid" grant microphone "$bundle_id" || fail "could not grant the microphone"
# TC-524 location probe: "Always" and a simulated position (Apple Park). Informational; see the header.
time_stage main.location-grant xcrun simctl privacy "$udid" grant location-always "$bundle_id" || log "could not grant location-always"
time_stage main.location-set xcrun simctl location "$udid" set 37.3349,-122.0090 || log "could not set a simulated location"

reports="$HOME/Library/Logs/DiagnosticReports"
marker="$out/.launched"
touch "$marker"

# Raw simulator output stays outside the uploaded artifact; only allowlisted event names and times are retained.
private_logs=$(mktemp -d)
stream_pid=""
watcher_pid=""
observer_pid=""
clock_pid=""
launcher=""
app_launched=0
# Job control gives every background job its own process group, so stopping a job also stops its sleep, ps and
# simctl children instead of leaving them writing into a removed directory.
set -m
stop_job() {
  [ -n "$1" ] || return 0
  kill -TERM -- "-$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}
cleanup_smoke() {
  trap - INT TERM EXIT
  stop_job "$watcher_pid"
  stop_job "$observer_pid"
  stop_job "$clock_pid"
  if [ "$app_launched" -eq 1 ]; then xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true; fi
  stop_job "$launcher"
  stop_job "$stream_pid"
  # Workers are gone, so a lock they held can no longer be released by them.
  rmdir "$private_logs/publication.lock" 2>/dev/null || true
  rm -rf "$private_logs"
}
trap cleanup_smoke EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
safe_log_lines() {
  awk '{
    time = substr($0, 1, 19)
    if (time !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/) time = "timestamp-unavailable"
    if (index($0, "EXO_WEB_APP_READY")) print time " EXO_WEB_APP_READY"
    else if (index($0, "EXO_SMOKE ")) print time " EXO_SMOKE"
    else if (index($0, "EXO_LOCATION_SMOKE ")) print time " EXO_LOCATION_SMOKE"
    else if (index($0, "scene willConnect")) print time " scene willConnect"
    else if (index($0, "sceneDidBecomeActive")) print time " sceneDidBecomeActive"
    else if (index($0, "setAppActive(true)")) print time " setAppActive(true)"
    else if (index($0, "WebView load start")) print time " WebView load start"
    else if (index($0, "WebView didCommit")) print time " WebView didCommit"
  }' "$1" >"$2"
}
mounted_probe() {
  grep -a 'EXO_SMOKE ' "$1" 2>/dev/null | sed 's/^.*EXO_SMOKE //' | tr -d '\r' |
    while IFS= read -r candidate; do
      if jq -e '(.href | startswith("capacitor://localhost")) and .mounted == true' \
        >/dev/null 2>&1 <<<"$candidate"; then
        printf '%s\n' "$candidate"
        break
      fi
    done
}
app_pid_alive() {
  local state
  state=$(ps -p "$1" -o stat= 2>/dev/null) || return 1
  [ -n "$state" ] && [[ "$state" != *Z* ]]
}
# Darwin's binary kinfo_proc begins with extern_proc.p_starttime, a 64-bit-ABI timeval: tv_sec is 8 bytes and
# tv_usec is a 32-bit suseconds_t followed by 4 padding bytes (the padding is not guaranteed to be zero).
# Read exactly 12 bytes as three little-endian (x86_64 and arm64) 32-bit words: sec_lo sec_hi usec.
# Never place the binary record in a shell variable or upload it.
kernel_start_time() {
  local raw sec_lo sec_hi micros extra seconds
  raw=$(sysctl -b "kern.proc.pid.$1" 2>/dev/null | od -An -tu4 -N12 -v) || return 1
  read -r sec_lo sec_hi micros extra <<<"$raw"
  [[ "$sec_lo" =~ ^[0-9]+$ && "$sec_hi" =~ ^[0-9]+$ && "$micros" =~ ^[0-9]+$ && -z "$extra" ]] || return 1
  seconds=$((sec_hi * 4294967296 + sec_lo))
  [ "$seconds" -ge 946684800 ] && [ "$seconds" -le 4102444800 ] && [ "$micros" -lt 1000000 ] || return 1
  printf '%s.%06d\n' "$seconds" "$micros"
}
# Output only a fixed source label plus a private start token. Exit 1 means absent/zombie;
# exit 2 means a live PID whose required start-time telemetry is unavailable.
process_identity() {
  local pid=$1 required_source=${2:-} details state kernel_start lstart elapsed
  local -x LC_ALL=C
  details=$(time_stage identity.ps ps -p "$pid" -o stat= -o lstart= -o etime= 2>/dev/null) || return 1
  [[ "$details" =~ ^[[:space:]]*([^[:space:]]+) ]] || return 1
  state=${BASH_REMATCH[1]}
  [[ "$state" != *Z* ]] || return 1
  if [ "$required_source" != ps-lstart-etime-coarse ]; then
    if kernel_start=$(time_stage identity.kernel-start kernel_start_time "$pid"); then
      printf 'kernel-us %s\n' "$kernel_start"
      return 0
    fi
    [ "$required_source" != kernel-us ] || return 2
  fi
  if [[ "$details" =~ ^[[:space:]]*[^[:space:]]+[[:space:]]+([[:alpha:]]{3}[[:space:]]+[[:alpha:]]{3}[[:space:]]+[[:digit:]]{1,2}[[:space:]]+[[:digit:]]{2}:[[:digit:]]{2}:[[:digit:]]{2}[[:space:]]+[[:digit:]]{4})[[:space:]]+([0-9:-]+)[[:space:]]*$ ]]; then
    lstart=${BASH_REMATCH[1]// /_}
    elapsed=${BASH_REMATCH[2]}
    [[ "$elapsed" =~ ^[0-9]+(-[0-9]{1,2})?(:[0-9]{2}){1,2}$ ]] || return 2
    printf 'ps-lstart-etime-coarse %s\n' "$lstart"
    return 0
  fi
  return 2
}
# Serialize only publication commits, not identity queries or the potentially slow rename.
# A .pid record is private staging until its .ready line commits the completed epoch.
publication_lock() {
  while [ "$SECONDS" -lt "$deadline" ]; do
    if mkdir "$private_logs/publication.lock" 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  return 1
}
first_published_source() {
  local file epoch order best="" selected="" pid source start
  for file in simctl launchctl; do
    [ -s "$private_logs/$file.ready" ] || continue
    read -r epoch order <"$private_logs/$file.ready" || continue
    [[ "$order" =~ ^[0-9]+$ ]] || continue
    if [ -z "$best" ] || [ "$order" -lt "$best" ]; then
      read -r pid source start <"$private_logs/$file.pid" || continue
      best=$order
      selected=$source
    fi
  done
  printf '%s\n' "$selected"
}
publication_failure() {
  if [ "$1" -eq 1 ]; then
    : >"$private_logs/publication.exited"
  else
    : >"$private_logs/publication.start-missing"
    printf 'start-time unavailable at publication\n' >>"$out/launch-timeline.log"
  fi
}
publish_verified_pid() {
  local origin=$1 candidate=$2 epoch source token identity status=0 selected order
  identity=$(time_stage "$origin.pid-identity" process_identity "$candidate") || status=$?
  if [ "$status" -ne 0 ]; then publication_failure "$status"; return 1; fi
  read -r source token <<<"$identity"
  [ "$SECONDS" -lt "$deadline" ] || return 1
  printf '%s %s %s\n' "$candidate" "$source" "$token" >"$private_logs/$origin.pid.tmp.$$"
  # This rename may stall: readers must never use its contents without a later .ready.
  time_stage "$origin.publish-rename" mv "$private_logs/$origin.pid.tmp.$$" "$private_logs/$origin.pid" || return 1
  while [ "$SECONDS" -lt "$deadline" ]; do
    time_stage "$origin.publish-lock" publication_lock || return 1
    selected=$(first_published_source)
    if [ -n "$selected" ] && [ "$selected" != "$source" ]; then
      time_stage "$origin.publish-unlock" rmdir "$private_logs/publication.lock"
      status=0
      identity=$(time_stage "$origin.pid-identity-source" process_identity "$candidate" "$selected") || status=$?
      if [ "$status" -ne 0 ]; then publication_failure "$status"; return 1; fi
      read -r source token <<<"$identity"
      printf '%s %s %s\n' "$candidate" "$source" "$token" >"$private_logs/$origin.pid"
      continue
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      time_stage "$origin.publish-unlock" rmdir "$private_logs/publication.lock"
      return 1
    fi
    order=0
    if [ -s "$private_logs/publication.order" ]; then read -r order <"$private_logs/publication.order"; fi
    order=$((order + 1))
    printf '%s\n' "$order" >"$private_logs/publication.order"
    epoch=$(date -u +%s)
    if [ "$SECONDS" -lt "$deadline" ]; then
      # Readers take no lock: a .ready file must never be visible until it is complete.
      if ! { printf '%s %s\n' "$epoch" "$order" >"$private_logs/$origin.ready.tmp.$$" &&
             mv "$private_logs/$origin.ready.tmp.$$" "$private_logs/$origin.ready"; }; then
        time_stage "$origin.publish-unlock" rmdir "$private_logs/publication.lock"
        return 1
      fi
      time_stage "$origin.publish-unlock" rmdir "$private_logs/publication.lock"
      return 0
    fi
    time_stage "$origin.publish-unlock" rmdir "$private_logs/publication.lock"
    return 1
  done
  return 1
}
published_at() {
  local epoch order
  read -r epoch order <"$private_logs/$1.ready" || return 1
  date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ
}

# Begin the app-process unified stream before simctl launch. It is stopped and sanitized before upload.
xcrun simctl spawn "$udid" log stream --style compact --info --debug \
  --predicate 'process == "App"' \
  >"$private_logs/stream.log" 2>"$private_logs/stream.err" &
stream_pid=$!
time_stage main.stream-start sleep 1
if ! kill -0 "$stream_pid" 2>/dev/null; then fail "app unified log stream could not start"; fi
printf 'stream requested %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$out/launch-timeline.log"
: >"$out/liveness.log"

# --console-pty gives the app a terminal, so its stdout is line-buffered as it happens.
launch_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
launch_log_at=$(date -u '+%Y-%m-%d %H:%M:%S')
deadline_epoch=$(($(date -u +%s) + timeout_s))
deadline_log_at=$(date -u -r "$deadline_epoch" '+%Y-%m-%d %H:%M:%S' 2>/dev/null ||
  date -u -d "@$deadline_epoch" '+%Y-%m-%d %H:%M:%S')
printf 'launch requested %s\n' "$launch_at" >>"$out/launch-timeline.log"
log "launching $bundle_id at $launch_at"
SIMCTL_CHILD_EXO_LOCATION_SMOKE="$location_smoke" SIMCTL_CHILD_EXO_CAPTURE_SMOKE="$capture_smoke" \
  xcrun simctl launch --console-pty "$udid" "$bundle_id" >"$private_logs/console.log" 2>&1 &
launcher=$!
app_launched=1

# App PID discovery parses private console output in a separate process: it cannot delay the heartbeat.
# Only a bundle-qualified numeric simctl result may be published as an app PID.
scan_simctl_pid() {
  awk -v app="$bundle_id:" '$1 == app { gsub(/\r/, "", $2); if ($2 ~ /^[0-9]+$/) { print $2; exit } }' \
    "$private_logs/console.log" 2>/dev/null
}
observe_simctl_pid() {
  local candidate
  while [ "$SECONDS" -lt "$deadline" ] && [ ! -f "$private_logs/observer.stop" ]; do
    candidate=$(time_stage observer.pid-scan scan_simctl_pid)
    if [ -n "$candidate" ]; then
      if [ "$SECONDS" -lt "$deadline" ] && [ ! -f "$private_logs/observer.stop" ]; then
        publish_verified_pid simctl "$candidate"
        if [ -s "$private_logs/simctl.ready" ]; then
          printf 'simctl launch pid %s observed %s\n' "$candidate" "$(published_at simctl)" >>"$out/launch-timeline.log"
        fi
        : >"$private_logs/observer.complete"
        return 0
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ] || [ -f "$private_logs/observer.stop" ]; then break; fi
    time_stage observer.sleep sleep 2
  done
  : >"$private_logs/observer.complete"
}

# Only verified app PIDs from simctl or its matching launchctl job are checked.
watch_liveness() {
  local epoch last_epoch=$launch_epoch first_pid_epoch="" first_alive_epoch="" proof_gap_reported=0 interval_start gap
  local anchor_pid="" anchor_source="" anchor_start="" simctl_pid="" identity state status
  refresh_pid_publications() {
    local file candidate_pid published_epoch candidate_source candidate_start order first_file="" first_order=""
    if [ -z "$anchor_pid" ]; then
      # Both sources can finish before this process wakes; use commit order, not filename order.
      for file in simctl launchctl; do
        [ -s "$private_logs/$file.ready" ] || continue
        read -r published_epoch order <"$private_logs/$file.ready" || continue
        [[ "$published_epoch" =~ ^[0-9]+$ && "$order" =~ ^[0-9]+$ ]] || return 1
        if [ -z "$first_order" ] || [ "$order" -lt "$first_order" ]; then
          first_order=$order
          first_file=$file
        fi
      done
      if [ -n "$first_file" ]; then
        read -r anchor_pid anchor_source anchor_start <"$private_logs/$first_file.pid" || return 1
        printf '%s %s %s\n' "$anchor_pid" "$anchor_source" "$anchor_start" >"$private_logs/identity.anchor"
      fi
    fi
    for file in simctl launchctl; do
      [ -s "$private_logs/$file.ready" ] || continue
      read -r published_epoch order <"$private_logs/$file.ready" || continue
      read -r candidate_pid candidate_source candidate_start <"$private_logs/$file.pid" || return 1
      [[ "$candidate_pid" =~ ^[0-9]+$ && "$published_epoch" =~ ^[0-9]+$ &&
        "$order" =~ ^[0-9]+$ && "$candidate_source" =~ ^(kernel-us|ps-lstart-etime-coarse)$ &&
        "$candidate_start" =~ ^[a-zA-Z0-9_.:]+$ ]] || return 1
      if [ "$candidate_pid" != "$anchor_pid" ] || [ "$candidate_source" != "$anchor_source" ] ||
           [ "$candidate_start" != "$anchor_start" ]; then
        printf '%s pid %s identity changed\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$anchor_pid" >>"$out/liveness.log"
        : >"$private_logs/watcher.identity-changed"
        return 1
      fi
      if [ "$file" = simctl ]; then simctl_pid=$candidate_pid; fi
      if [ -z "$first_pid_epoch" ] || [ "$published_epoch" -lt "$first_pid_epoch" ]; then
        first_pid_epoch=$published_epoch
      fi
    done
  }
  check_first_alive_gap() {
    local proof_gap
    if [ -n "$first_pid_epoch" ] && [ -z "$first_alive_epoch" ] &&
       [ "$first_pid_epoch" -le "$1" ]; then
      proof_gap=$(($1 - first_pid_epoch))
      if [ "$proof_gap" -gt 5 ] && [ "$proof_gap_reported" -eq 0 ]; then
        printf '%s diagnostic PID-alive proof gap %ss\n' "$2" "$proof_gap" >>"$out/liveness.log"
        proof_gap_reported=1
      fi
      if [ "$proof_gap" -gt "$gap_fail_s" ]; then : >"$private_logs/watcher.gap"; fi
    fi
  }
  record_liveness() {
    local observed_epoch observed_at state=$1
    observed_epoch=$(date -u +%s)
    refresh_pid_publications || return 1
    observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gap=$((observed_epoch - last_epoch))
    if [ -z "$first_pid_epoch" ] || [ "$first_pid_epoch" -gt "$observed_epoch" ]; then
      if [ "$gap" -gt 5 ]; then
        printf '%s pre-PID observation gap %ss\n' "$observed_at" "$gap" >>"$out/liveness.log"
      fi
    else
      if [ "$first_pid_epoch" -gt "$last_epoch" ]; then
        gap=$((first_pid_epoch - last_epoch))
        if [ "$gap" -gt 5 ]; then
          printf '%s pre-PID observation gap %ss\n' "$observed_at" "$gap" >>"$out/liveness.log"
        fi
      fi
      interval_start=$last_epoch
      if [ "$first_pid_epoch" -gt "$interval_start" ]; then interval_start=$first_pid_epoch; fi
      gap=$((observed_epoch - interval_start))
      if [ "$gap" -gt 5 ]; then
        printf '%s diagnostic observation gap %ss\n' "$observed_at" "$gap" >>"$out/liveness.log"
      fi
      if [ "$gap" -gt "$gap_fail_s" ]; then : >"$private_logs/watcher.gap"; fi
    fi
    check_first_alive_gap "$observed_epoch" "$observed_at"
    if [ "$state" = "pid not yet observed" ] && [ -n "$first_pid_epoch" ]; then
      state="pid published; liveness check pending"
    fi
    printf '%s %s\n' "$observed_at" "$state" >>"$out/liveness.log"
    if [ "${2:-}" = alive ] && [ "$SECONDS" -lt "$deadline" ]; then
      if [ -z "$first_alive_epoch" ]; then first_alive_epoch=$observed_epoch; fi
      : >"$private_logs/watcher.alive"
    fi
    last_epoch=$observed_epoch
  }
  observe_identity() {
    local stage=$1
    status=0
    identity=$(time_stage "$stage" process_identity "$anchor_pid" "$anchor_source") || status=$?
    if [ -n "$simctl_pid" ]; then state="simctl pid $anchor_pid"; else state="pid $anchor_pid"; fi
    if [ "$status" -eq 1 ]; then
      record_liveness "$state exited" || return 1
      : >"$private_logs/watcher.exited"
      return 1
    elif [ "$status" -ne 0 ]; then
      record_liveness "$state start time unavailable" || return 1
      : >"$private_logs/watcher.start-missing"
      return 1
    fi
    local observed_source observed_start
    read -r observed_source observed_start <<<"$identity"
    if [ "$observed_source" != "$anchor_source" ] || [ "$observed_start" != "$anchor_start" ]; then
      record_liveness "$state identity changed" || return 1
      : >"$private_logs/watcher.identity-changed"
      return 1
    fi
    record_liveness "$state alive" alive
  }
  sample_liveness() {
    time_stage heartbeat.sleep sleep 2
    refresh_pid_publications || return 1
    if [ -n "$anchor_pid" ]; then
      observe_identity heartbeat.pid-check
    else
      record_liveness "pid not yet observed"
    fi
  }
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! time_stage heartbeat sample_liveness; then return 1; fi
  done
  refresh_pid_publications || return 1
  if [ -n "$anchor_pid" ]; then
    observe_identity heartbeat.terminal-pid-check || return 1
  else
    record_liveness "pid not yet observed" || return 1
  fi
  : >"$private_logs/watcher.complete"
}
# An app-independent scheduler clock; each printed interval is observed, never synthesized.
bare_clock() {
  local started ended
  while [ "$SECONDS" -lt "$deadline" ]; do
    started=$(date -u +%s)
    sleep 2
    ended=$(date -u +%s)
    printf 'clock start_epoch_s=%s end_epoch_s=%s duration_s=%s\n' \
      "$started" "$ended" "$((ended - started))" >>"$out/clock-diagnostic.log"
  done
}

discover_launchctl_pid() {
  xcrun simctl spawn "$udid" launchctl list 2>/dev/null |
    awk -v job="UIKitApplication:$bundle_id" 'index($3, job) == 1 && $1 ~ /^[0-9]+$/ { print $1; exit }'
}
parse_location_probe() {
  grep -a -m1 'EXO_LOCATION_SMOKE ' "$private_logs/console.log" 2>/dev/null |
    sed 's/^.*EXO_LOCATION_SMOKE //' | tr -d '\r'
}
count_crash_reports() {
  find "$reports" -newer "$marker" -type f \( -name 'App-*' -o -name 'App_*' -o -name 'ExoWidgets*' \) \
    -exec sh -c 'for report do printf x; done' sh {} + 2>/dev/null | wc -c | tr -d '[:space:]'
}

simctl_pid=""
pid=""
probe=""
process_exited=0
deadline=$((SECONDS + timeout_s))
launch_epoch=$((deadline_epoch - timeout_s))
observe_simctl_pid &
observer_pid=$!
watch_liveness &
watcher_pid=$!
: >"$out/clock-diagnostic.log"
bare_clock &
clock_pid=$!
while [ "$SECONDS" -lt "$deadline" ]; do
  time_stage main.poll-sleep sleep 2
  if [ -f "$private_logs/watcher.exited" ]; then process_exited=1; break; fi
  # launchd's job for the app: "<pid> <status> UIKitApplication:xyz.tinycloud.exo[...]".
  observed_pid=$(time_stage main.launchctl-list discover_launchctl_pid)
  if [ -z "$pid" ] && [ -n "$observed_pid" ]; then
    if [ "$SECONDS" -lt "$deadline" ]; then
      pid=$observed_pid
      publish_verified_pid launchctl "$pid"
      if [ -s "$private_logs/launchctl.ready" ]; then
        printf 'pid %s observed %s\n' "$pid" "$(published_at launchctl)" >>"$out/launch-timeline.log"
        log "running as pid $pid"
      fi
    fi
  fi
  if [ -n "$pid" ] && [ "$observed_pid" != "$pid" ]; then
    printf '%s pid %s disappeared from launchctl\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pid" >>"$out/liveness.log"
    fail "the app exited or crashed after launch (pid $pid)"
    process_exited=1
    break
  fi
  if [ -z "$probe" ] && [ "$SECONDS" -lt "$deadline" ]; then
    candidate=$(time_stage main.probe-parse mounted_probe "$private_logs/console.log")
    if [ -n "$candidate" ] && [ "$SECONDS" -lt "$deadline" ]; then
      probe=$candidate
      printf 'mounted app-page probe observed %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$out/launch-timeline.log"
      log "mounted app-page probe received"
    fi
  fi
done
if [ "$process_exited" -eq 1 ] && [ ! -f "$private_logs/watcher.exited" ]; then
  kill "$watcher_pid" 2>/dev/null || true
fi
if [ "$process_exited" -eq 1 ]; then
  : >"$private_logs/observer.stop"
fi
watcher_failed=0
time_stage main.watcher-wait wait "$watcher_pid" 2>/dev/null || watcher_failed=1
watcher_pid=""
observer_failed=0
time_stage main.observer-wait wait "$observer_pid" 2>/dev/null || observer_failed=1
observer_pid=""
time_stage main.clock-wait wait "$clock_pid" 2>/dev/null ||
  printf 'clock diagnostic incomplete\n' >>"$out/clock-diagnostic.log"
clock_pid=""
if [ "$process_exited" -eq 0 ] && { [ "$observer_failed" -ne 0 ] || [ ! -f "$private_logs/observer.complete" ]; }; then
  fail "simctl PID observer did not complete through the probe deadline"
fi
if [ -s "$private_logs/simctl.ready" ]; then
  read -r simctl_pid simctl_source simctl_start <"$private_logs/simctl.pid"
else
  printf 'simctl launch pid not reported\n' >>"$out/launch-timeline.log"
fi
if [ -s "$private_logs/identity.anchor" ]; then
  read -r expected_pid expected_source expected_start <"$private_logs/identity.anchor"
  printf 'start-time source %s\n' "$expected_source" >>"$out/launch-timeline.log"
fi
if [ -f "$private_logs/publication.start-missing" ]; then fail "process start time unavailable at PID publication"; fi
if [ -f "$private_logs/publication.exited" ]; then fail "app process exited during liveness"; fi
if [ -f "$private_logs/watcher.start-missing" ]; then fail "process start time unavailable during liveness"; fi
if [ -f "$private_logs/watcher.identity-changed" ]; then fail "app process identity changed"; fi
if [ -f "$private_logs/watcher.exited" ]; then
  process_exited=1
  fail "app process exited during liveness"
fi
if [ -f "$private_logs/watcher.gap" ]; then fail "liveness observation gap exceeded ${gap_fail_s}s"; fi
if [ "$process_exited" -eq 0 ] && { [ "$watcher_failed" -ne 0 ] || [ ! -f "$private_logs/watcher.complete" ]; }; then
  fail "liveness watcher did not complete through the probe deadline"
fi

if [ -z "$probe" ] && [ "$process_exited" -eq 0 ]; then
  # A PTY can lose a late stdout line; accept only the same mounted app-page payload from os_log.
  time_stage main.fallback-log-show xcrun simctl spawn "$udid" log show --style compact --start "$launch_log_at" --end "$deadline_log_at" --info \
    --predicate 'process == "App" AND subsystem == "xyz.tinycloud.exo" AND category == "smoke"' \
    >"$private_logs/smoke-fallback.log" 2>/dev/null || true
  time_stage main.fallback-sanitize safe_log_lines "$private_logs/smoke-fallback.log" "$out/smoke-fallback.log"
  probe=$(time_stage main.fallback-probe-parse mounted_probe "$private_logs/smoke-fallback.log")
  if [ -n "$probe" ]; then
    printf 'mounted app-page fallback probe observed %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$out/launch-timeline.log"
  fi
fi

location_probe=""
if [ -n "$probe" ] && [ "$process_exited" -eq 0 ]; then
  # The location probe captures for about 15 s after the main probe; give it up to 60 s.
  location_deadline=$((SECONDS + 60))
  while [ "$location_smoke" = 1 ] && [ -z "$location_probe" ] && [ "$SECONDS" -lt "$location_deadline" ]; do
    time_stage main.location-sleep sleep 2
    if [ -n "$pid" ] && ! time_stage main.location-pid-check app_pid_alive "$pid"; then break; fi
    location_probe=$(time_stage main.location-probe-parse parse_location_probe)
  done
  log "location probe: $([ -n "$location_probe" ] && echo received || echo none)"
  log "letting it run ${settle_s}s more"
  time_stage main.settle sleep "$settle_s"
elif [ "${#failures[@]}" -eq 0 ]; then
  fail "no EXO_SMOKE probe line within ${timeout_s}s (is ExoBridgeViewController the root view controller?)"
fi
if [ ! -f "$private_logs/watcher.alive" ]; then
  fail "no app PID-alive observation before probe deadline"
fi
if [ "$process_exited" -eq 0 ] && [ -n "${expected_pid:-}" ]; then
  final_pid=${simctl_pid:-$pid}
  if [ "$final_pid" != "$expected_pid" ]; then
    fail "app process identity changed"
  else
    final_status=0
    final_identity=$(time_stage main.final-pid-check process_identity "$final_pid" "$expected_source") || final_status=$?
    if [ "$final_status" -eq 1 ]; then
      printf '%s pid %s exited after probe deadline\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$final_pid" >>"$out/liveness.log"
      fail "the app was not running ${settle_s}s after the probe (pid $final_pid)"
    elif [ "$final_status" -ne 0 ]; then
      fail "process start time unavailable during liveness"
    elif [ "$final_identity" != "$expected_source $expected_start" ]; then
      fail "app process identity changed"
    fi
  fi
fi
if [ -z "$pid" ]; then
  fail "launchctl did not report an app pid before the probe deadline"
fi

log "collecting screenshot and logs"
time_stage main.screenshot xcrun simctl io "$udid" screenshot "$out/screenshot.png" >/dev/null 2>&1 || fail "screenshot failed"
time_stage main.unified-log-show xcrun simctl spawn "$udid" log show --style compact --last 10m --info --debug \
  --predicate 'process == "App"' \
  >"$private_logs/unified.log" 2>/dev/null || true
time_stage main.terminate xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true
time_stage main.launcher-wait wait "$launcher" 2>/dev/null || true
launcher=""
app_launched=0
kill "$stream_pid" 2>/dev/null || true
time_stage main.stream-wait wait "$stream_pid" 2>/dev/null || true
stream_pid=""
time_stage main.stream-sanitize safe_log_lines "$private_logs/stream.log" "$out/app-unified-stream.log"
time_stage main.unified-sanitize safe_log_lines "$private_logs/unified.log" "$out/unified.log"
crash_count=$(time_stage main.crash-count count_crash_reports)
if [ "$crash_count" -gt 0 ]; then
  fail "crash report(s) detected: $crash_count"
  printf 'count=%s\n' "$crash_count" >"$out/crash-reports.txt"
fi

checks=()
check() { # check <jq filter> <description>
  if [ -n "$probe" ] && time_stage main.check jq -e "$1" >/dev/null 2>&1 <<<"$probe"; then
    checks+=("- [x] $2")
  else
    checks+=("- [ ] $2")
    fail "$2"
  fi
}
check '.href | startswith("capacitor://localhost")' "bundled web app loaded from capacitor://localhost"
check '.platform == "ios"' 'Capacitor platform is "ios"'
check '.mounted == true' "React mounted into #root"
check '.voiceNotesHeader == true and .voiceNotesAvailable == true' "VoiceNotes plugin registered and visible to JS"
check '.voiceNotesStatus.state == "idle"' "VoiceNotes.status() answered over the bridge (state idle)"
check '.voiceNotesStatus.maxDurationMs == 10800000' "VoiceNotes reports the 3-hour recording limit"
check '.voiceNotesReadChunk.code == "not_found"' "VoiceNotes.readAudioChunk() answered over the bridge (missing id: not_found)"
check '.voiceNotesInputs.listed == true and .voiceNotesInputs.reset == true and .voiceNotesInputs.count >= 0' \
  "VoiceNotes.listInputs() and selectInput(null) answered over the bridge"
if [ "$capture_smoke" = 1 ]; then
  check '.recovery == "ok"' "stopped journal and ADTS segments recovered into a committed note"
  check '.accountFailpoint == "ok"' "Debug account-state failpoint rejects an acknowledged write"
  check '.capture.committed == true and .capture.sampleRate == 48000 and .capture.channels == 1' \
    "synthetic sine passed the AAC writer, muxer and native commit"
  check '.capture.sessionsGone == true and .capture.legacyHeld == true and .capture.orphanHeld == true' \
    "capture cleanup, v1 pair and runtime orphan import retain ownerUnknown"
  check '.capture.pauseSequenceValid == true' \
    "capture pause, resume and segment-close journal sequence"
  check '.transitions.epochDuringRetry == true and .transitions.staleTapIgnored == true and .transitions.staleAttachRejected == true and .transitions.pausedCallIgnored == true and .transitions.newSegmentAllowed == true and .transitions.noOldNotice == true and .transitions.stopRejectsAttach == true and .transitions.noEndedNotice == true and .transitions.manualAfterFailedRestart == true and .transitions.stopDuringBackoff == true and .transitions.backgroundRefusal == true and .transitions.recordedLimitMs == 10800000 and .transitions.sessionInactive == true' \
    "capture transition gate rejects stale starts and notifications, leaves the session inactive, and excludes pauses from the limit"
  check '.transitions.live.inactiveOnPause == true and .transitions.live.stayedPaused == true and .transitions.live.resumedRecording == true and .transitions.live.newSegment == true and .transitions.live.noPauseSpan == true and .transitions.live.routeUnchanged == true and .transitions.live.stalledRebuild == true and .transitions.live.silencedClosedForCall == true and .transitions.live.inactiveAfterDiscard == true' \
    "live iOS engine deactivates on Pause, ignores a call while paused, and resumes into a new segment"
  check '(.capture.probedDurationMs - .capture.durationMs | fabs) <= 100' \
    "capture duration matches the native file probe within 100 ms"
fi
check '.serviceWorkerDecision == "skip:capacitor" and .serviceWorkerRegistrations == 0' "the web app's PWA service worker is not registered in the shell"
check '.locationAvailable == true and .locationStatus.platform == "ios"' "Location plugin (Debug-only TC-524 spike) registered and answering status()"
check '.locationStatus.declared.foreground == true and .locationStatus.declared.background == true and .locationStatus.declared.backgroundExecution == true' \
  "Debug Info.plist has the location usage strings and the location background mode"
# Informational (never fails the job): the capture probe.
note() { # note <jq filter> <description>
  if [ -n "$location_probe" ] && time_stage main.note jq -e "$1" >/dev/null 2>&1 <<<"$location_probe"; then
    checks+=("- [x] (info) $2")
  else
    checks+=("- [ ] (info) $2")
  fi
}
note '.before.permission == "background"' "location authorization is Always (granted by simctl)"
note '.started.active == true' "Location.start() began a continuous capture"
note '.pending.samples > 0' "the native queue recorded location samples"
loads=$(time_stage main.load-count grep -a -c 'Loading app at capacitor://localhost' "$private_logs/console.log" || true)
[ "${loads:-0}" -le 1 ] || fail "the web app was loaded $loads times (two bridges?)"
time_stage main.console-sanitize safe_log_lines "$private_logs/console.log" "$out/console.log"

{
  echo "### iOS Simulator smoke"
  echo
  echo "Device: $device, runtime \`${runtime##*.}\`"
  echo
  printf '%s\n' "${checks[@]}"
  echo
  echo "Probe: \`$([ -n "$probe" ] && echo 'committed app page, React mounted' || echo none)\`"
  echo
  # Health spike (TC-525), informational: what HealthKit says to this unsigned build.
  if [ -n "$probe" ] && time_stage main.health-check jq -e '.healthHeader == true' >/dev/null 2>&1 <<<"$probe"; then
    echo "Health plugin (not gated): available"
    echo
  fi
  echo "Location probe: \`$([ -n "$location_probe" ] && echo received || echo none)\`"
  echo
  echo "Capacitor log (\`console.log\`):"
  echo
  echo '```'
  cat "$out/console.log"
  echo '```'
  if [ "${#failures[@]}" -gt 0 ]; then
    echo
    echo "**Failed:**"
    printf -- '- %s\n' "${failures[@]}"
  fi
} >"$out/summary.md"

cat "$out/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$out/summary.md" >>"$GITHUB_STEP_SUMMARY"

if [ "${#failures[@]}" -gt 0 ]; then
  echo "iOS smoke FAILED:"
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
echo "iOS smoke passed"
