#!/usr/bin/env bash
# Health spike (TC-525): does HealthKit authorize in the iOS Simulator without an Apple team or profile?
#
# Installs an AD-HOC SIGNED Debug simulator build of Exo (CODE_SIGN_IDENTITY=-, "Sign to Run Locally": the HealthKit
# entitlements in App/App.entitlements are embedded the way any local simulator build has them), launches it with
# EXO_HEALTH_PROBE=1 and records what ExoBridgeViewController's HealthKit probe logs, one `EXO_HEALTH_PROBE {json}`
# line per step: availability, authorization status, the authorization request, sample data, a 7-day read,
# background delivery and the status afterwards. When AXe (https://github.com/cameroncooke/AXe) is installed it answers
# each Health sheet ("Turn On All", then "Allow", tapped by position); without it the first request stays open and the
# later steps never run.
#
# Informational only (CI runs it with continue-on-error). Exits 0 when the 7-day read succeeded. Writes
# entitlements.txt, console.log, probe.jsonl, sheet-*.png, after.png, axe.log and summary.md to <out-dir>.
#
# Usage (macOS with Xcode, jq):
#   mobile/scripts/ios-health-probe.sh <App.app> <out-dir> [<device.txt written by ios-simulator-smoke.sh>]
set -uo pipefail

usage="usage: ios-health-probe.sh <App.app> <out-dir> [<device.txt>]"
app=${1:?$usage}
out=${2:?$usage}
device_file=${3:-}
bundle_id=xyz.tinycloud.exo
timeout_s=${HEALTH_PROBE_TIMEOUT:-120}

mkdir -p "$out"
out=$(cd "$out" && pwd)
log() { echo "[health $(date -u +%H:%M:%S)] $*"; }

if [ -n "$device_file" ] && [ -f "$device_file" ]; then
  read -r runtime udid device <"$device_file"
else
  read -r udid device < <(xcrun simctl list devices booted -j | jq -r '[.devices[][]] | first | "\(.udid) \(.name)"')
  runtime=unknown
fi
[ -n "${udid:-}" ] && [ "$udid" != null ] || { echo "::error::no booted simulator"; exit 1; }
[ -d "$app" ] || { echo "::error::no app bundle at $app"; exit 1; }
log "device: $device ($udid), runtime ${runtime##*.}"
xcrun simctl bootstatus "$udid" -b >/dev/null || { echo "::error::simulator $udid did not boot"; exit 1; }

# What the binary carries. A simulator app's entitlements live in the __TEXT,__entitlements section the linker
# writes (the ad-hoc signature itself carries none); an unsigned build (CODE_SIGNING_ALLOWED=NO) has neither.
{
  echo "## codesign -dv"
  codesign -dv "$app" 2>&1
  echo
  echo "## codesign -d --entitlements (signature)"
  codesign -d --entitlements - "$app" 2>&1
  echo
  echo "## __TEXT,__entitlements section"
  otool -l "$app/App" | grep -A4 -E 'sectname __entitlements' || echo "(no __entitlements section)"
  echo
  # What the linker put in that section: Xcode's App.app-Simulated.xcent, next to the build products.
  xcent=$(find "$app/../../../Intermediates.noindex" -name 'App.app-Simulated.xcent' 2>/dev/null | head -1)
  echo "## ${xcent:-App.app-Simulated.xcent (not found)}"
  [ -n "$xcent" ] && plutil -p "$xcent"
} >"$out/entitlements.txt" 2>&1
cat "$out/entitlements.txt"

xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true
xcrun simctl uninstall "$udid" "$bundle_id" >/dev/null 2>&1 || true
xcrun simctl install "$udid" "$app" || { echo "::error::install failed"; exit 1; }

# Probe lines, oldest first, as JSON: from the app's stdout, else from the unified log.
probe_lines() {
  local lines
  lines=$(grep -a 'EXO_HEALTH_PROBE ' "$out/console.log" 2>/dev/null | sed 's/^.*EXO_HEALTH_PROBE //' | tr -d '\r')
  if [ -z "$lines" ]; then
    lines=$(xcrun simctl spawn "$udid" log show --style compact --last 10m \
      --predicate 'subsystem == "xyz.tinycloud.exo" AND category == "health"' 2>/dev/null \
      | grep -a 'EXO_HEALTH_PROBE ' | sed 's/^.*EXO_HEALTH_PROBE //' | tr -d '\r')
  fi
  printf '%s\n' "$lines" | jq -c '.' 2>/dev/null
}
has_stage() { probe_lines | jq -e --arg s "$1" 'select(.stage == $s)' >/dev/null 2>&1; }
wait_for_stage() { # wait_for_stage <stage> <seconds>
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    has_stage "$1" && return 0
    sleep 2
  done
  return 1
}

log "launching $bundle_id with EXO_HEALTH_PROBE=1"
SIMCTL_CHILD_EXO_HEALTH_PROBE=1 xcrun simctl launch --console-pty "$udid" "$bundle_id" >"$out/console.log" 2>&1 &
launcher=$!

# The Health Access sheet is a remote view: AXe's accessibility queries cannot see into it ("No translation
# object returned for simulator ... fullscreen dialog"), so it is answered by position. On iOS 26 the sheet puts
# "Turn On All" at about 51% of the screen height (left side) and "Allow" at about 85.5% (centered), measured
# from the iPhone 17 Pro screenshots. AXe taps in points; screenshots are in pixels (@3x on Pro phones).
# AXe maps the point through the app's accessibility frame first, and that lookup fails now and then while the sheet
# is up ("No translation object returned for simulator"), so each tap is retried.
tap_at() { # tap_at <x fraction> <y fraction> <screenshot>
  local w h scale x y attempt
  w=$(sips -g pixelWidth "$3" 2>/dev/null | awk '/pixelWidth/ { print $2 }')
  h=$(sips -g pixelHeight "$3" 2>/dev/null | awk '/pixelHeight/ { print $2 }')
  [ -n "$w" ] && [ -n "$h" ] || return 1
  scale=3
  [ "$w" -lt 1000 ] && scale=2
  x=$(awk -v w="$w" -v f="$1" -v s="$scale" 'BEGIN { printf "%d", w * f / s }')
  y=$(awk -v h="$h" -v f="$2" -v s="$scale" 'BEGIN { printf "%d", h * f / s }')
  for attempt in 1 2 3 4 5 6 7 8; do
    if axe tap -x "$x" -y "$y" --udid "$udid" >>"$out/axe.log" 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

sheets=()
answer_sheet() { # answer_sheet <name>: the probe's requesting-<name> stage, answered by <name>
  local name=$1 shot
  if ! wait_for_stage "requesting-$name" "$timeout_s"; then
    sheets+=("$name: request never reached")
    return 1
  fi
  sleep 5
  shot="$out/sheet-$name.png"
  xcrun simctl io "$udid" screenshot "$shot" >/dev/null 2>&1 || true
  if has_stage "$name"; then
    sheets+=("$name: no sheet (the request finished on its own)")
    return 0
  fi
  if ! command -v axe >/dev/null 2>&1; then
    sheets+=("$name: sheet open, not answered (AXe not installed)")
    return 1
  fi
  if ! tap_at 0.20 0.5095 "$shot"; then
    sheets+=("$name: sheet open, AXe could not tap Turn On All")
    return 1
  fi
  sleep 2
  xcrun simctl io "$udid" screenshot "$out/sheet-$name-on.png" >/dev/null 2>&1 || true
  tap_at 0.50 0.855 "$shot" || true
  if wait_for_stage "$name" 30; then
    sheets+=("$name: sheet answered (Turn On All, Allow)")
  else
    sheets+=("$name: sheet open, taps did not answer it")
    return 1
  fi
}

answer_sheet authorized-read && answer_sheet authorized-write
wait_for_stage done 90 || log "the probe did not finish"
log "sheets: ${sheets[*]}"

xcrun simctl io "$udid" screenshot "$out/after.png" >/dev/null 2>&1 || true
probe_lines >"$out/probe.jsonl"
xcrun simctl spawn "$udid" log show --style compact --last 10m --info \
  --predicate 'process == "App" OR subsystem == "xyz.tinycloud.exo" OR process CONTAINS "health" OR subsystem == "com.apple.healthkit"' \
  >"$out/unified.log" 2>&1 || true
xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true
wait "$launcher" 2>/dev/null || true

stage() { jq -c --arg s "$1" 'select(.stage == $s) | .response' "$out/probe.jsonl" | head -1; }
{
  echo "### HealthKit in the Simulator, ad-hoc signed (health spike, TC-525)"
  echo
  echo "Device: $device, runtime \`${runtime##*.}\`."
  echo
  printf -- '- Health sheet %s\n' "${sheets[@]}"
  echo
  echo "Entitlements in the binary:"
  echo
  echo '```'
  sed -n '/Simulated.xcent/,$p' "$out/entitlements.txt" | head -20
  echo '```'
  echo
  echo "| Step | Response |"
  echo "|---|---|"
  for s in availability status authorized-read authorized-write inserted read background status-after; do
    r=$(stage "$s" | cut -c1-600)
    echo "| $s | \`${r:-(not reached)}\` |"
  done
} >"$out/summary.md"
cat "$out/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$out/summary.md" >>"$GITHUB_STEP_SUMMARY"

if [ "$(stage read | jq -r '.ok' 2>/dev/null)" = true ]; then
  echo "HealthKit probe: read 7 days in the simulator"
  exit 0
fi
echo "HealthKit probe: no successful read (see summary)"
exit 1
