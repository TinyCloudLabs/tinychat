#!/usr/bin/env bash
# App Store Connect helpers for signed Exo iOS builds: ios-testflight.yml's plan job (check) and ios-build.yml's sign
# job (sign: true, dispatched by ios-testflight.yml on main), which run it from the workflow commit's scripts/release
# and never run project code. Values come from the ios-release environment secrets and are never printed.
#
#   ios-signing.sh check            require APPLE_TEAM_ID, APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_PRIVATE_KEY and
#                                   their shapes; a missing one fails with its name and nothing is built
#   ios-signing.sh write-key <dir>  write APPLE_API_PRIVATE_KEY to <dir>/AuthKey_<APPLE_API_KEY>.p8 (mode 600) and print
#                                   the path. Accepts the .p8 file as is, collapsed onto one line (as a single-line
#                                   secret prompt may deliver it), or base64 of the file; fails unless openssl reads it.
#                                   desktop-signing.sh write-key (desktop notarization) runs this too
#   ios-signing.sh verify-ipa <ipa> require an App Store build signed by APPLE_TEAM_ID: valid deep signature, Apple
#                                   Distribution authority, the team's App Store profile (no devices, not an
#                                   in-house ProvisionsAllDevices profile, no get-task-allow) for xyz.tinycloud.exo
set -euo pipefail

BUNDLE_ID=xyz.tinycloud.exo
SECRETS=(APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_PRIVATE_KEY)

fail() { echo "::error::$1"; exit 1; }

check() {
  local missing=() name
  for name in "${SECRETS[@]}"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "TestFlight is not set up yet: the ios-release environment is missing ${missing[*]}. Nothing was built or uploaded. Setup: mobile/README.md, \"iOS release\"."
  fi
  [[ $APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ ]] || fail "APPLE_TEAM_ID must be the 10-character Team ID"
  [[ $APPLE_API_KEY =~ ^[A-Z0-9]{10}$ ]] || fail "APPLE_API_KEY must be the 10-character App Store Connect key ID"
  [[ $APPLE_API_ISSUER =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
    fail "APPLE_API_ISSUER must be the App Store Connect issuer ID (a UUID)"
  echo "ios-release secrets present: ${SECRETS[*]}"
}

write_key() {
  local dir=${1:?usage: ios-signing.sh write-key <dir>} raw body key
  [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_PRIVATE_KEY:-}" ] || fail "APPLE_API_KEY and APPLE_API_PRIVATE_KEY are required"
  raw=$APPLE_API_PRIVATE_KEY
  if [[ $raw != *"BEGIN PRIVATE KEY"* ]]; then
    raw=$(printf '%s' "$raw" | tr -d ' \t\r\n' | base64 --decode 2>/dev/null) ||
      fail "APPLE_API_PRIVATE_KEY is neither the AuthKey_<id>.p8 file nor base64 of it"
  fi
  # Rebuild the PEM from the base64 between the markers, whatever happened to its line breaks.
  body=${raw#*-----BEGIN PRIVATE KEY-----}
  body=${body%%-----END PRIVATE KEY-----*}
  body=$(printf '%s' "$body" | sed 's/\\n//g' | tr -d ' \t\r\n')
  mkdir -p "$dir"
  chmod 700 "$dir"
  key="$dir/AuthKey_$APPLE_API_KEY.p8"
  (
    umask 077
    { echo '-----BEGIN PRIVATE KEY-----'; printf '%s\n' "$body" | fold -w 64; echo '-----END PRIVATE KEY-----'; } >"$key"
  )
  if ! openssl pkey -in "$key" -noout >/dev/null 2>&1; then
    rm -f "$key"
    fail "APPLE_API_PRIVATE_KEY is not a readable .p8 private key (use the whole AuthKey_<id>.p8 file, BEGIN/END lines included)"
  fi
  echo "$key"
}

verify_ipa() {
  local ipa=${1:?usage: ios-signing.sh verify-ipa <ipa>} tmp app details authority team profile
  [ -f "$ipa" ] || fail "no .ipa at $ipa"
  [ -n "${APPLE_TEAM_ID:-}" ] || fail "APPLE_TEAM_ID is required"
  tmp=$(mktemp -d)
  unzip -q "$ipa" -d "$tmp"
  app="$tmp/Payload/App.app"
  [ -d "$app" ] || fail "the .ipa has no Payload/App.app"

  codesign --verify --deep --strict --verbose=2 "$app" || fail "App.app does not pass codesign --verify --deep --strict"
  details=$(codesign -dvv "$app" 2>&1)
  authority=$(grep -m1 '^Authority=' <<<"$details" || true)
  team=$(sed -n 's/^TeamIdentifier=//p' <<<"$details")
  case "$authority" in
    *"Apple Distribution"* | *"iPhone Distribution"*) ;;
    *) fail "App.app is not signed for App Store distribution ($authority)" ;;
  esac
  [ "$team" = "$APPLE_TEAM_ID" ] || fail "App.app is signed by team '$team', expected APPLE_TEAM_ID"

  profile="$tmp/profile.plist"
  security cms -D -i "$app/embedded.mobileprovision" >"$profile" 2>/dev/null || fail "App.app has no readable embedded.mobileprovision"
  if /usr/libexec/PlistBuddy -c 'Print :ProvisionedDevices' "$profile" >/dev/null 2>&1; then
    fail "the embedded profile lists devices, so it is not an App Store profile"
  fi
  # Enterprise (in-house) profiles list no devices either; they carry ProvisionsAllDevices instead.
  if /usr/libexec/PlistBuddy -c 'Print :ProvisionsAllDevices' "$profile" >/dev/null 2>&1; then
    fail "the embedded profile has ProvisionsAllDevices (an in-house enterprise profile), so it is not an App Store profile"
  fi
  [ "$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:get-task-allow' "$profile" 2>/dev/null || echo false)" = false ] ||
    fail "the embedded profile allows get-task-allow (a development profile)"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$profile")" = "$APPLE_TEAM_ID.$BUNDLE_ID" ] ||
    fail "the embedded profile is not for $BUNDLE_ID in APPLE_TEAM_ID"
  echo "App.app: $authority, TeamIdentifier matches, App Store profile '$(/usr/libexec/PlistBuddy -c 'Print :Name' "$profile")'"
  rm -rf "$tmp"
}

case "${1:-}" in
  check) check ;;
  write-key) write_key "${2:-}" ;;
  verify-ipa) verify_ipa "${2:-}" ;;
  *) echo "usage: ios-signing.sh check | write-key <dir> | verify-ipa <ipa>" >&2; exit 2 ;;
esac
