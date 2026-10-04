#!/usr/bin/env bash
# Health spike (TC-525): does HealthKit authorize in the iOS Simulator without an Apple team or profile?
#
# Installs an AD-HOC SIGNED Debug simulator build of Exo (CODE_SIGN_IDENTITY=-, "Sign to Run Locally": the HealthKit
# entitlements in App/App.entitlements are embedded the way any local simulator build has them), launches it with
# EXO_HEALTH_PROBE=1 and records what ExoBridgeViewController's HealthKit probe logs, one `EXO_HEALTH_PROBE {json}`
# line per step: availability, authorization status, the authorization request, sample data, a 7-day read,
# background delivery and the status afterwards. When AXe (https://github.com/cameroncooke/AXe) is installed it answers
# the Health sheet ("Turn On All", then "Allow"); without it the request stays open and the later steps never run.
#
# Informational only (CI runs it with continue-on-error). Exits 0 when the 7-day read succeeded. Writes
# entitlements.txt, console.log, probe.jsonl, sheet.png, after.png, ui-*.json and summary.md to <out-dir>.
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
  if segedit "$app/App" -extract __TEXT __entitlements "$out/entitlements-section.plist" >/dev/null 2>&1; then
    plutil -p "$out/entitlements-section.plist" 2>&1 || cat "$out/entitlements-section.plist"
  else
    otool -l "$app/App" | grep -A4 -E 'sectname __entitlements' || echo "(no __entitlements section)"
  fi
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

sheet="not reached"
answered="no"
if wait_for_stage requesting "$timeout_s"; then
  sleep 5
  xcrun simctl io "$udid" screenshot "$out/sheet.png" >/dev/null 2>&1 || true
  if has_stage authorized; then
    sheet="not shown (the request finished without a sheet)"
  else
    sheet="open"
    if command -v axe >/dev/null 2>&1; then
      axe describe-ui --udid "$udid" >"$out/ui-sheet.json" 2>&1 || true
      # By accessibility label; if this AXe has no --label, by the element's frame from describe-ui.
      tap() {
        local label=$1 frame x y
        axe tap --label "$label" --udid "$udid" >>"$out/axe.log" 2>&1 && return 0
        frame=$(axe describe-ui --udid "$udid" 2>/dev/null | jq -c --arg l "$label" \
          '[.. | objects | select((.AXLabel? // .label? // "") == $l) | (.frame // .AXFrame)] | map(select(. != null)) | first // empty' 2>/dev/null)
        [ -n "$frame" ] || return 1
        x=$(jq -r '(.x + .width / 2) | floor' <<<"$frame")
        y=$(jq -r '(.y + .height / 2) | floor' <<<"$frame")
        axe tap -x "$x" -y "$y" --udid "$udid" >>"$out/axe.log" 2>&1
      }
      if tap "Turn On All"; then
        sleep 2
        axe describe-ui --udid "$udid" >"$out/ui-turned-on.json" 2>&1 || true
        if tap "Allow"; then answered="Turn On All + Allow (AXe)"; else answered="Turn On All only (Allow not found)"; fi
      else
        answered="no (AXe found no \"Turn On All\")"
      fi
    else
      answered="no (AXe not installed)"
    fi
  fi
  log "sheet: $sheet; answered: $answered"
  wait_for_stage done 90 || log "the probe did not finish"
else
  log "no 'requesting' stage within ${timeout_s}s"
fi

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
  echo "Device: $device, runtime \`${runtime##*.}\`. Health sheet: $sheet. Answered: $answered."
  echo
  echo "Entitlements in the binary:"
  echo
  echo '```'
  sed -n '/__entitlements section/,$p' "$out/entitlements.txt" | head -20
  echo '```'
  echo
  echo "| Step | Response |"
  echo "|---|---|"
  for s in availability status authorized inserted read background status-after; do
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
