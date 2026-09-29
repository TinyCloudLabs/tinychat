#!/usr/bin/env bash
# Release gate for a signed Exo build: exits 1 unless the .app and the .dmg are Developer ID signed by the expected
# team, hardened, carry the audio-input entitlement, and are notarized with stapled tickets. Never let an unsigned or
# unnotarized build through.
# Usage: verify-desktop-signing.sh <Exo.app> <Exo.dmg> <team id>
set -euo pipefail

app=${1:?usage: verify-desktop-signing.sh <Exo.app> <Exo.dmg> <team id>}
dmg=${2:?usage: verify-desktop-signing.sh <Exo.app> <Exo.dmg> <team id>}
team=${3:?usage: verify-desktop-signing.sh <Exo.app> <Exo.dmg> <team id>}

fail() {
  echo "::error::$1"
  exit 1
}

pass() {
  echo "ok: $1"
}

# $1 = label, $2 = output to search, remaining = required fixed strings
require() {
  local label=$1 output=$2
  shift 2
  for needle in "$@"; do
    grep -qF -- "$needle" <<<"$output" || fail "$label: missing '$needle' in:"$'\n'"$output"
  done
  pass "$label"
}

[ -d "$app" ] || fail "no app bundle at $app"
[ -f "$dmg" ] || fail "no disk image at $dmg"

codesign --verify --deep --strict --verbose=2 "$app" 2>&1 || fail "codesign --verify --deep --strict failed for $app"
pass "app signature and nested code verify (--deep --strict)"

app_sig=$(codesign -dvvv "$app" 2>&1) || fail "codesign -dvvv failed for $app"
require "app signed with Developer ID by team $team" "$app_sig" "Authority=Developer ID Application:" "TeamIdentifier=$team"
grep -qE '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)' <<<"$app_sig" || fail "app is not signed with the hardened runtime:"$'\n'"$app_sig"
pass "app has the hardened runtime"
if grep -qE 'flags=0x[0-9a-f]+\([^)]*adhoc' <<<"$app_sig"; then fail "app signature is ad-hoc"; fi

entitlements=$(codesign -d --entitlements - --xml "$app" 2>/dev/null) || fail "cannot read the app's entitlements"
require "app entitlements include microphone capture" "$entitlements" "com.apple.security.device.audio-input"
if grep -qF "com.apple.security.get-task-allow" <<<"$entitlements"; then fail "app carries the debug-only get-task-allow entitlement"; fi

app_gatekeeper=$(spctl --assess --type execute -vvv "$app" 2>&1) || fail "Gatekeeper rejects $app:"$'\n'"$app_gatekeeper"
require "Gatekeeper accepts the app as notarized" "$app_gatekeeper" "accepted" "source=Notarized Developer ID"

xcrun stapler validate "$app" || fail "no valid stapled notarization ticket on $app"
pass "app has a stapled ticket"

codesign --verify --strict --verbose=2 "$dmg" 2>&1 || fail "codesign --verify failed for $dmg"
dmg_sig=$(codesign -dvvv "$dmg" 2>&1) || fail "codesign -dvvv failed for $dmg"
require "disk image signed with Developer ID by team $team" "$dmg_sig" "Authority=Developer ID Application:" "TeamIdentifier=$team"

dmg_gatekeeper=$(spctl --assess --type open --context context:primary-signature -vvv "$dmg" 2>&1) || fail "Gatekeeper rejects $dmg:"$'\n'"$dmg_gatekeeper"
require "Gatekeeper accepts the disk image as notarized" "$dmg_gatekeeper" "accepted" "source=Notarized Developer ID"

xcrun stapler validate "$dmg" || fail "no valid stapled notarization ticket on $dmg"
pass "disk image has a stapled ticket"

echo "Exo is Developer ID signed (team $team), hardened, notarized and stapled."
