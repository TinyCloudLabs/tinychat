#!/usr/bin/env bash
# TC-3677: on a Release simulator build of TinyCloud One compiled with the CI-only EXO_FRAME_PROBE condition
# (mobile/ios/App/App/FrameProbe.swift), check that an app in a frame inside One cannot reach the native bridge, and
# that a link or window.open in a frame opens outside One and never replaces One's main view.
# Installs and launches the app on the simulator that `ios-simulator-smoke.sh boot <out-dir>` chose
# (<out-dir>/device.txt), waits for the probe's `EXO_FRAME_PROBE {json}` line and fails unless:
#   - the build is Release;
#   - One's own call to the probe plugin reaches native and is answered (so the counters below can count);
#   - no frame's bridge message reached Capacitor: no plugin call from a frame, no answer to a frame's callback id,
#     no Preferences key a frame tried to set;
#   - the two local frames (opaque: One's sandbox without allow-same-origin; unsandboxed: no sandbox) loaded and ran,
#     and every loaded frame saw the bridge handler as "object" or "undefined";
#   - in every loaded frame window.open got no window and its URL, and a target=_blank link's, were handed to the
#     system; the unsandboxed frame's target=_top link was handed to the system too;
#   - One's main frame was never navigated: no main-frame navigation allowed, the same URL and page afterwards;
#   - the app's `EXO_FRAME_PROBE_HANDOFF {json}` line says the system opened a handed-off URL (Safari);
#   - the app left no crash report.
# One's real Explorer frame (over the network) is checked like the local frames when it loads; when it does not
# load, the run warns and checks the local frames only.
# Writes one.png (One with the probe's frames), outside.png (after the hand-off), probe.json, handoff.json and
# summary.md to <out-dir>. The app's raw console output stays private.
#
# Usage (macOS with Xcode, jq): mobile/scripts/ios-frame-probe.sh <App.app> <out-dir>
set -uo pipefail

usage="usage: ios-frame-probe.sh <App.app> <out-dir>"
app=${1:?$usage}
out=${2:?$usage}
bundle_id=xyz.tinycloud.home
timeout_s=${FRAME_PROBE_TIMEOUT:-240}
handoff_timeout_s=${FRAME_PROBE_HANDOFF_TIMEOUT:-60}
outside_settle_s=${FRAME_PROBE_OUTSIDE_SETTLE:-3}

mkdir -p "$out"
out=$(cd "$out" && pwd)
failures=()
fail() { failures+=("$1"); echo "::error::iOS frame probe: $1"; }
log() { echo "[frame-probe $(date -u +%H:%M:%S)] $*"; }

[ -s "$out/device.txt" ] || { echo "::error::no $out/device.txt: run ios-simulator-smoke.sh boot $out first"; exit 1; }
read -r runtime udid device <"$out/device.txt"
[ -d "$app" ] || { echo "::error::no app bundle at $app"; exit 1; }
log "device: $device ($udid), runtime ${runtime##*.}"

xcrun simctl bootstatus "$udid" -b >/dev/null || { echo "::error::simulator $udid did not boot"; exit 1; }
xcrun simctl install "$udid" "$app" || { echo "::error::install failed"; exit 1; }

private_logs=$(mktemp -d)
launcher=""
stop_app() {
  xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true
  if [ -n "$launcher" ]; then
    kill "$launcher" 2>/dev/null || true
    wait "$launcher" 2>/dev/null || true
    launcher=""
  fi
}
cleanup() {
  trap - EXIT
  stop_app
  rm -rf "$private_logs"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

reports="$HOME/Library/Logs/DiagnosticReports"
touch "$private_logs/launched"

# The first line carrying `<prefix> ` followed by a JSON object.
probe_line() {
  grep -a "$1 " "$private_logs/console.log" 2>/dev/null | sed "s/^.*$1 //" | tr -d '\r' |
    while IFS= read -r candidate; do
      if jq -e 'type == "object"' >/dev/null 2>&1 <<<"$candidate"; then
        printf '%s\n' "$candidate"
        break
      fi
    done
}
screenshot() {
  xcrun simctl io "$udid" screenshot "$out/$1" >/dev/null 2>&1 || fail "screenshot $1 failed"
}

# --console-pty gives the app a terminal, so its stdout is line-buffered; simctl stays attached while the app runs.
log "launching $bundle_id"
xcrun simctl launch --console-pty "$udid" "$bundle_id" >"$private_logs/console.log" 2>&1 &
launcher=$!

probe=""
deadline=$((SECONDS + timeout_s))
while [ "$SECONDS" -lt "$deadline" ]; do
  probe=$(probe_line EXO_FRAME_PROBE)
  [ -n "$probe" ] && break
  if ! kill -0 "$launcher" 2>/dev/null; then
    fail "the app exited before the frame probe reported"
    break
  fi
  sleep 1
done

handoff=""
if [ -n "$probe" ]; then
  log "frame probe reported"
  # The app keeps One on screen for 5 s after the line, then hands a URL to the system.
  screenshot one.png
  handoff_deadline=$((SECONDS + handoff_timeout_s))
  while [ "$SECONDS" -lt "$handoff_deadline" ]; do
    handoff=$(probe_line EXO_FRAME_PROBE_HANDOFF)
    [ -n "$handoff" ] && break
    sleep 1
  done
  log "hand-off: $([ -n "$handoff" ] && echo reported || echo none)"
  sleep "$outside_settle_s"
  screenshot outside.png
else
  [ "${#failures[@]}" -gt 0 ] || fail "no EXO_FRAME_PROBE line within ${timeout_s}s (was the app built with EXO_FRAME_PROBE?)"
  screenshot one.png
fi
stop_app

crash_count=$(find "$reports" -newer "$private_logs/launched" -type f \( -name 'App-*' -o -name 'App_*' \) 2>/dev/null |
  wc -l | tr -d '[:space:]')
if [ "${crash_count:-0}" -gt 0 ]; then fail "crash report(s) detected: $crash_count"; fi

if [ -n "$probe" ]; then jq . <<<"$probe" >"$out/probe.json"; fi
if [ -n "$handoff" ]; then jq . <<<"$handoff" >"$out/handoff.json"; fi

checks=()
check() { # check <json> <jq filter> <description>
  if [ -n "$1" ] && jq -e "$2" >/dev/null 2>&1 <<<"$1"; then
    checks+=("- [x] $3")
  else
    checks+=("- [ ] $3")
    fail "$3"
  fi
}
check "$probe" '.configuration == "Release"' "Release build"
check "$probe" '(.main.href | startswith("capacitor://localhost")) and .main.answered == true and .pings.main >= 1' \
  "One's own call to the probe plugin reaches native and is answered (the counters work)"
check "$probe" '.frames.opaque.ready == true and .frames.unsandboxed.ready == true' \
  "the opaque and unsandboxed frames loaded and ran"
check "$probe" '[.frames[] | select(.ready == true) | .bridge] | length > 0 and all(. == "object" or . == "undefined")' \
  "every frame saw the bridge handler as object or undefined"
check "$probe" '.pings.framed == 0' "0 bridge messages from a frame reached Capacitor"
check "$probe" '.answers == 0' "no plugin answered a frame's call"
check "$probe" '(.stored | length) > 0 and (.stored | all(. == null))' "no Preferences key a frame tried to set was set"
check "$probe" '[.frames[] | select(.ready == true)] | length > 0 and all(.open == "null" and .openHanded == true and .blankHanded == true)' \
  "window.open and target=_blank links in every frame went to the system browser; window.open got no window in One"
check "$probe" '.frames.unsandboxed.topHanded == true' "a frame's target=_top link went to the system browser"
check "$probe" '.topNavigations.allowed == 0 and .main.unchanged == true and .main.marker == true' \
  "One's main view never navigated: the same URL and page after every frame action"
check "$handoff" '.opened == true' "the system opened a handed-off URL outside One"
explorer="not reported"
if [ -n "$probe" ]; then
  if jq -e '.frames.explorer.ready == true' >/dev/null 2>&1 <<<"$probe"; then
    explorer="loaded and checked"
    checks+=("- [x] (info) One's Explorer frame loaded and was checked like the local frames")
  else
    explorer="did not load"
    checks+=("- [ ] (info) One's Explorer frame loaded and was checked like the local frames")
    echo "::warning::iOS frame probe: One's Explorer frame did not load (network or its frame policy); only the local frames were checked"
  fi
fi

{
  echo "### iOS frame probe (Release simulator build)"
  echo
  echo "Device: $device, runtime \`${runtime##*.}\`"
  echo
  printf '%s\n' "${checks[@]}"
  echo
  echo "Explorer frame: $explorer"
  echo
  echo "Probe:"
  echo
  echo '```json'
  echo "${probe:-none}"
  echo '```'
  echo
  echo "Hand-off:"
  echo
  echo '```json'
  echo "${handoff:-none}"
  echo '```'
  if [ "${#failures[@]}" -gt 0 ]; then
    echo
    echo "**Failed:**"
    printf -- '- %s\n' "${failures[@]}"
  fi
} >"$out/summary.md"

cat "$out/summary.md"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$out/summary.md" >>"$GITHUB_STEP_SUMMARY"; fi
[ -z "$probe" ] || echo "EXO_FRAME_PROBE $probe"
[ -z "$handoff" ] || echo "EXO_FRAME_PROBE_HANDOFF $handoff"

if [ "${#failures[@]}" -gt 0 ]; then
  echo "iOS frame probe FAILED:"
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
echo "iOS frame probe passed"
