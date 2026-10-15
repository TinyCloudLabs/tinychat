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
# Always writes screenshot.png, console.log (the app's stdout/stderr: Capacitor's "⚡️" lines and the WebView
# console), unified.log (os_log of the App process), any crash reports and summary.md to <out-dir>.
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
capture_smoke=${EXO_CAPTURE_SMOKE:-1}
location_smoke=${EXO_LOCATION_SMOKE:-1}

mkdir -p "$out"
out=$(cd "$out" && pwd)
failures=()
fail() { failures+=("$1"); echo "::error::iOS smoke: $1"; }
log() { echo "[smoke $(date -u +%H:%M:%S)] $*"; }

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
plutil -lint "$app/PrivacyInfo.xcprivacy" || fail "App.app has no valid PrivacyInfo.xcprivacy"

log "waiting for the simulator to finish booting"
xcrun simctl bootstatus "$udid" -b >/dev/null || { echo "::error::simulator $udid did not boot"; exit 1; }
log "booted; installing $app"
xcrun simctl install "$udid" "$app" || { echo "::error::install failed"; exit 1; }
xcrun simctl privacy "$udid" grant microphone "$bundle_id" || fail "could not grant the microphone"
# TC-524 location probe: "Always" and a simulated position (Apple Park). Informational; see the header.
xcrun simctl privacy "$udid" grant location-always "$bundle_id" || log "could not grant location-always"
xcrun simctl location "$udid" set 37.3349,-122.0090 || log "could not set a simulated location"

reports="$HOME/Library/Logs/DiagnosticReports"
marker="$out/.launched"
touch "$marker"

# Raw simulator output stays outside the uploaded artifact; only allowlisted event names and times are retained.
private_logs=$(mktemp -d)
stream_pid=""
cleanup_smoke() {
  if [ -n "$stream_pid" ]; then kill "$stream_pid" 2>/dev/null || true; wait "$stream_pid" 2>/dev/null || true; fi
  rm -rf "$private_logs"
}
trap cleanup_smoke EXIT
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
  kill -0 "$1" 2>/dev/null || return 1
  # An exited child may remain a zombie until the launcher is reaped; kill -0 alone still succeeds.
  local state
  state=$(ps -p "$1" -o stat= 2>/dev/null) || return 1
  case "$state" in *Z*) return 1 ;; esac
}

# Begin the app-process unified stream before simctl launch. It is stopped and sanitized before upload.
xcrun simctl spawn "$udid" log stream --style compact --info --debug \
  --predicate 'process == "App"' \
  >"$private_logs/stream.log" 2>"$private_logs/stream.err" &
stream_pid=$!
sleep 1
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

# The simctl launch line can report an app PID before launchctl lists its job.
simctl_pid=""
pid=""
probe=""
process_exited=0
deadline=$((SECONDS + timeout_s))
while [ "$SECONDS" -lt "$deadline" ]; do
  sleep 2
  observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -z "$simctl_pid" ]; then
    simctl_pid=$(awk -v app="$bundle_id:" '$1 == app { gsub(/\r/, "", $2); if ($2 ~ /^[0-9]+$/) { print $2; exit } }' \
      "$private_logs/console.log" 2>/dev/null)
    if [ -n "$simctl_pid" ]; then
      printf 'simctl launch pid %s observed %s\n' "$simctl_pid" "$observed_at" >>"$out/launch-timeline.log"
      log "simctl launch reported pid $simctl_pid"
    fi
  fi
  if [ -n "$simctl_pid" ]; then
    if ! app_pid_alive "$simctl_pid"; then
      printf '%s simctl pid %s exited\n' "$observed_at" "$simctl_pid" >>"$out/liveness.log"
      fail "the app exited or crashed after simctl launch (pid $simctl_pid)"
      process_exited=1
      break
    fi
    printf '%s simctl pid %s alive\n' "$observed_at" "$simctl_pid" >>"$out/liveness.log"
  fi
  # launchd's job for the app: "<pid> <status> UIKitApplication:xyz.tinycloud.exo[...]".
  # Simulator app processes are host processes, so check the PID and reject an unreaped zombie.
  observed_pid=$(xcrun simctl spawn "$udid" launchctl list 2>/dev/null | awk -v job="UIKitApplication:$bundle_id" 'index($3, job) == 1 && $1 ~ /^[0-9]+$/ { print $1; exit }')
  if [ -z "$pid" ] && [ -n "$observed_pid" ]; then
    pid=$observed_pid
    printf 'pid %s observed %s\n' "$pid" "$observed_at" >>"$out/launch-timeline.log"
    log "running as pid $pid"
  fi
  if [ -n "$pid" ]; then
    if [ "$observed_pid" != "$pid" ] || ! app_pid_alive "$pid"; then
      printf '%s pid %s exited or disappeared\n' "$observed_at" "$pid" >>"$out/liveness.log"
      fail "the app exited or crashed after launch (pid $pid)"
      process_exited=1
      break
    fi
    printf '%s pid %s alive\n' "$observed_at" "$pid" >>"$out/liveness.log"
  else
    printf '%s pid not yet observed\n' "$observed_at" >>"$out/liveness.log"
  fi
  if [ -z "$probe" ] && [ "$SECONDS" -lt "$deadline" ]; then
    probe=$(mounted_probe "$private_logs/console.log")
    if [ -n "$probe" ]; then
      printf 'mounted app-page probe observed %s\n' "$observed_at" >>"$out/launch-timeline.log"
      log "mounted app-page probe received"
    fi
  fi
done

if [ -z "$probe" ] && [ "$process_exited" -eq 0 ]; then
  # A PTY can lose a late stdout line; accept only the same mounted app-page payload from os_log.
  xcrun simctl spawn "$udid" log show --style compact --start "$launch_log_at" --end "$deadline_log_at" --info \
    --predicate 'process == "App" AND subsystem == "xyz.tinycloud.exo" AND category == "smoke"' \
    >"$private_logs/smoke-fallback.log" 2>/dev/null || true
  safe_log_lines "$private_logs/smoke-fallback.log" "$out/smoke-fallback.log"
  probe=$(mounted_probe "$private_logs/smoke-fallback.log")
  if [ -n "$probe" ]; then
    printf 'mounted app-page fallback probe observed %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$out/launch-timeline.log"
  fi
fi

location_probe=""
if [ -n "$probe" ] && [ "$process_exited" -eq 0 ]; then
  # The location probe captures for about 15 s after the main probe; give it up to 60 s.
  location_deadline=$((SECONDS + 60))
  while [ "$location_smoke" = 1 ] && [ -z "$location_probe" ] && [ "$SECONDS" -lt "$location_deadline" ]; do
    sleep 2
    if [ -n "$pid" ] && ! app_pid_alive "$pid"; then break; fi
    location_probe=$(grep -a -m1 'EXO_LOCATION_SMOKE ' "$private_logs/console.log" 2>/dev/null | sed 's/^.*EXO_LOCATION_SMOKE //' | tr -d '\r')
  done
  log "location probe: $([ -n "$location_probe" ] && echo received || echo none)"
  log "letting it run ${settle_s}s more"
  sleep "$settle_s"
elif [ "${#failures[@]}" -eq 0 ]; then
  fail "no EXO_SMOKE probe line within ${timeout_s}s (is ExoBridgeViewController the root view controller?)"
fi
if [ "$process_exited" -eq 0 ] && [ -n "$simctl_pid" ] && ! app_pid_alive "$simctl_pid"; then
  printf '%s simctl pid %s exited after probe deadline\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$simctl_pid" >>"$out/liveness.log"
  fail "the app was not running ${settle_s}s after the probe (simctl pid $simctl_pid)"
elif [ "$process_exited" -eq 0 ] && [ -n "$pid" ] && ! app_pid_alive "$pid"; then
  printf '%s pid %s exited after probe deadline\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pid" >>"$out/liveness.log"
  fail "the app was not running ${settle_s}s after the probe (pid $pid)"
elif [ -z "$pid" ]; then
  fail "launchctl never reported an app pid"
fi

log "collecting screenshot and logs"
xcrun simctl io "$udid" screenshot "$out/screenshot.png" >/dev/null 2>&1 || fail "screenshot failed"
xcrun simctl spawn "$udid" log show --style compact --last 10m --info --debug \
  --predicate 'process == "App"' \
  >"$private_logs/unified.log" 2>/dev/null || true
xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true
wait "$launcher" 2>/dev/null || true
kill "$stream_pid" 2>/dev/null || true
wait "$stream_pid" 2>/dev/null || true
stream_pid=""
safe_log_lines "$private_logs/stream.log" "$out/app-unified-stream.log"
safe_log_lines "$private_logs/unified.log" "$out/unified.log"
crash_count=$(find "$reports" -newer "$marker" -type f \( -name 'App-*' -o -name 'App_*' -o -name 'ExoWidgets*' \) \
  -exec sh -c 'for report do printf x; done' sh {} + 2>/dev/null | wc -c | tr -d '[:space:]')
if [ "$crash_count" -gt 0 ]; then
  fail "crash report(s) detected: $crash_count"
  printf 'count=%s\n' "$crash_count" >"$out/crash-reports.txt"
fi

checks=()
check() { # check <jq filter> <description>
  if [ -n "$probe" ] && jq -e "$1" >/dev/null 2>&1 <<<"$probe"; then
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
  if [ -n "$location_probe" ] && jq -e "$1" >/dev/null 2>&1 <<<"$location_probe"; then
    checks+=("- [x] (info) $2")
  else
    checks+=("- [ ] (info) $2")
  fi
}
note '.before.permission == "background"' "location authorization is Always (granted by simctl)"
note '.started.active == true' "Location.start() began a continuous capture"
note '.pending.samples > 0' "the native queue recorded location samples"
loads=$(grep -a -c 'Loading app at capacitor://localhost' "$private_logs/console.log" || true)
[ "${loads:-0}" -le 1 ] || fail "the web app was loaded $loads times (two bridges?)"
safe_log_lines "$private_logs/console.log" "$out/console.log"

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
  if [ -n "$probe" ] && jq -e '.healthHeader == true' >/dev/null 2>&1 <<<"$probe"; then
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
