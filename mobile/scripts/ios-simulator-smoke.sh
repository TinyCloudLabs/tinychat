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
         iphones: [.value[] | select((.name | startswith("iPhone")) and
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

# --console-pty gives the app a terminal, so its stdout is line-buffered and lands in console.log as it happens.
log "launching $bundle_id"
SIMCTL_CHILD_EXO_LOCATION_SMOKE="$location_smoke" SIMCTL_CHILD_EXO_CAPTURE_SMOKE="$capture_smoke" \
  xcrun simctl launch --console-pty "$udid" "$bundle_id" >"$out/console.log" 2>&1 &
launcher=$!

pid=""
probe=""
deadline=$((SECONDS + timeout_s))
while [ "$SECONDS" -lt "$deadline" ]; do
  sleep 2
  if [ -z "$pid" ]; then
    # launchd's job for the app: "<pid> <status> UIKitApplication:xyz.tinycloud.exo[...]". The simulator's
    # processes are host processes, so kill -0 can watch it.
    pid=$(xcrun simctl spawn "$udid" launchctl list 2>/dev/null | awk -v job="UIKitApplication:$bundle_id" 'index($3, job) == 1 && $1 ~ /^[0-9]+$/ { print $1; exit }')
    [ -n "$pid" ] && log "running as pid $pid"
  fi
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    fail "the app exited or crashed after launch (pid $pid)"
    break
  fi
  probe=$(grep -a -m1 'EXO_SMOKE ' "$out/console.log" 2>/dev/null | sed 's/^.*EXO_SMOKE //' | tr -d '\r')
  [ -n "$probe" ] && break
done

location_probe=""
if [ -n "$probe" ]; then
  log "probe: $probe"
  # The location probe captures for about 15 s after the main probe; give it up to 60 s.
  location_deadline=$((SECONDS + 60))
  while [ "$location_smoke" = 1 ] && [ -z "$location_probe" ] && [ "$SECONDS" -lt "$location_deadline" ]; do
    sleep 2
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then break; fi
    location_probe=$(grep -a -m1 'EXO_LOCATION_SMOKE ' "$out/console.log" 2>/dev/null | sed 's/^.*EXO_LOCATION_SMOKE //' | tr -d '\r')
  done
  log "location probe: ${location_probe:-none}"
  log "letting it run ${settle_s}s more"
  sleep "$settle_s"
elif [ "${#failures[@]}" -eq 0 ]; then
  fail "no EXO_SMOKE probe line within ${timeout_s}s (is ExoBridgeViewController the root view controller?)"
fi
if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
  case " ${failures[*]} " in *"exited or crashed"*) ;; *) fail "the app was not running ${settle_s}s after the probe (pid $pid)" ;; esac
elif [ -z "$pid" ]; then
  fail "simctl launch never reported a pid"
fi

log "collecting screenshot and logs"
xcrun simctl io "$udid" screenshot "$out/screenshot.png" >/dev/null 2>&1 || fail "screenshot failed"
xcrun simctl spawn "$udid" log show --style compact --last 10m --info --debug \
  --predicate 'process == "App" OR subsystem == "xyz.tinycloud.exo"' >"$out/unified.log" 2>&1 || true
crashes=$(find "$reports" -newer "$marker" -type f \( -name 'App-*' -o -name 'App_*' \) 2>/dev/null || true)
if [ -n "$crashes" ]; then
  fail "crash report(s): $(echo "$crashes" | xargs -n1 basename | tr '\n' ' ')"
  mkdir -p "$out/crashes"
  echo "$crashes" | while read -r file; do cp "$file" "$out/crashes/"; done
fi
xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true
wait "$launcher" 2>/dev/null || true

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
if [ "$capture_smoke" = 1 ]; then
  check '.capture.committed == true and .capture.sampleRate == 48000 and .capture.channels == 1' \
    "synthetic sine passed the AAC writer, muxer and native commit"
  check '.capture.sessionsGone == true and .capture.legacyHeld == true' \
    "capture cleanup and legacy ownerUnknown probe"
  check '.capture.pauseSequenceValid == true' \
    "capture pause, resume and segment-close journal sequence"
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
loads=$(grep -a -c 'Loading app at capacitor://localhost' "$out/console.log" || true)
[ "${loads:-0}" -le 1 ] || fail "the web app was loaded $loads times (two bridges?)"

{
  echo "### iOS Simulator smoke"
  echo
  echo "Device: $device, runtime \`${runtime##*.}\`"
  echo
  printf '%s\n' "${checks[@]}"
  echo
  echo "Probe: \`${probe:-none}\`"
  echo
  # Health spike (TC-525), informational: what HealthKit says to this unsigned build.
  if [ -n "$probe" ] && jq -e '.healthHeader == true' >/dev/null 2>&1 <<<"$probe"; then
    echo "Health plugin (not gated): \`$(jq -c '.health // null' <<<"$probe")\`"
    echo
  fi
  echo "Location probe: \`${location_probe:-none}\`"
  echo
  echo "Capacitor log (\`console.log\`):"
  echo
  echo '```'
  grep -a -E '⚡️|EXO_SMOKE|EXO_LOCATION|STARTUP JS ERROR' "$out/console.log" | tr -d '\r' | head -60
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
