#!/usr/bin/env bash
# Boot an iOS Simulator, install a Debug simulator build of Exo, grant the microphone, launch it and prove it came
# up. Fails unless, within SMOKE_TIMEOUT seconds:
#   - the debug-only probe in ExoBridgeViewController logs `EXO_SMOKE {json}` with the bundled web app at
#     capacitor://localhost, platform "ios", React mounted into #root, the VoiceNotes plugin visible to JS and
#     its status() answering over the bridge with state "idle" and the 60-minute recording limit, and its
#     readAudioChunk() refusing a missing recording with "not_found";
#   - the app is still running SMOKE_SETTLE seconds later, and left no crash report.
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

mkdir -p "$out"
out=$(cd "$out" && pwd)
failures=()
fail() { failures+=("$1"); echo "::error::iOS smoke: $1"; }
log() { echo "[smoke $(date -u +%H:%M:%S)] $*"; }

# The newest iOS runtime that has an iPhone simulator; `boot` remembers it in device.txt for `run`.
if [ -f "$out/device.txt" ]; then
  read -r runtime udid device <"$out/device.txt"
else
  read -r runtime udid device < <(xcrun simctl list devices available -j | jq -r '
  .devices | to_entries
  | map(select(.key | test("SimRuntime\\.iOS-[0-9]+-[0-9]+")))
  | map({runtime: .key,
         version: (.key | capture("iOS-(?<major>[0-9]+)-(?<minor>[0-9]+)") | [(.major | tonumber), (.minor | tonumber)]),
         iphones: [.value[] | select(.name | startswith("iPhone"))]})
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

reports="$HOME/Library/Logs/DiagnosticReports"
marker="$out/.launched"
touch "$marker"

# --console-pty gives the app a terminal, so its stdout is line-buffered and lands in console.log as it happens.
log "launching $bundle_id"
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
  if [ -z "$probe" ]; then
    probe=$(xcrun simctl spawn "$udid" log show --style compact --last 5m \
      --predicate 'subsystem == "xyz.tinycloud.exo" AND category == "smoke"' 2>/dev/null \
      | grep -a -m1 'EXO_SMOKE ' | sed 's/^.*EXO_SMOKE //' | tr -d '\r')
  fi
  [ -n "$probe" ] && break
done

if [ -n "$probe" ]; then
  log "probe: $probe"
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
check '.voiceNotesStatus.maxDurationMs == 3600000' "VoiceNotes reports the 60-minute recording limit"
check '.voiceNotesReadChunk.code == "not_found"' "VoiceNotes.readAudioChunk() answered over the bridge (missing id: not_found)"
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
  echo "Capacitor log (\`console.log\`):"
  echo
  echo '```'
  grep -a -E '⚡️|EXO_SMOKE|STARTUP JS ERROR' "$out/console.log" | tr -d '\r' | head -40
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
