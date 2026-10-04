#!/usr/bin/env bash
# Release gate for a signed Exo Android build: exits 1 unless the APK and the AAB are signed with the expected upload
# key (never the debug key), the APK is xyz.tinycloud.exo at the expected versionName/versionCode with a launcher icon,
# not debuggable and requesting no location permission, and both bundle the production web app (assets/public) with
# no dev-server URL in capacitor.config.json. Never let an unsigned, debug or live-reload build through.
# Usage: verify-android-release.sh <app-release.apk> <app-release.aab> <versionName> <versionCode> <cert SHA-256>
# The cert digest is the upload certificate's SHA-256 (hex, colons and case ignored), e.g. from
#   keytool -list -v -keystore upload.jks -alias <alias>
# Tools: apksigner and aapt2 from $ANDROID_BUILD_TOOLS, else the newest build-tools under $ANDROID_HOME
# ($ANDROID_SDK_ROOT); keytool, jarsigner, unzip and node from PATH.
set -euo pipefail

usage='usage: verify-android-release.sh <apk> <aab> <versionName> <versionCode> <cert SHA-256>'
apk=${1:?$usage}
aab=${2:?$usage}
version_name=${3:?$usage}
version_code=${4:?$usage}
expected_cert=${5:?$usage}

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

digest() { tr -d ': \n' <<<"$1" | tr '[:upper:]' '[:lower:]'; }

[ -f "$apk" ] || fail "no APK at $apk"
[ -f "$aab" ] || fail "no app bundle at $aab"
expected_cert=$(digest "$expected_cert")
[[ "$expected_cert" =~ ^[0-9a-f]{64}$ ]] || fail "expected certificate SHA-256 must be 64 hex digits"

tools=${ANDROID_BUILD_TOOLS:-}
if [ -z "$tools" ]; then
  sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
  [ -n "$sdk" ] || fail "set ANDROID_HOME (or ANDROID_BUILD_TOOLS) to find apksigner and aapt2"
  tools=$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)
fi
[ -x "$tools/apksigner" ] && [ -x "$tools/aapt2" ] || fail "no apksigner/aapt2 in build-tools '$tools'"
echo "Using build-tools $tools"

# --- APK signature: v2+ scheme, exactly one signer, the upload certificate.
signature=$("$tools/apksigner" verify --verbose --print-certs "$apk" 2>&1) || fail "apksigner rejects $apk:"$'\n'"$signature"
grep -qE '^Verified using v(2|3|3\.1) scheme .*: true$' <<<"$signature" || fail "APK has no v2/v3 signature:"$'\n'"$signature"
require "APK signed by one signer" "$signature" "Number of signers: 1"
# apksigner 36 prints "Signer #1 certificate SHA-256 digest: <hex>", 37 prints "V2 Signer: certificate SHA-256 digest:
# <hex>" (one line per scheme). Every signer line must name the same, expected certificate.
apk_cert=$(grep -E '^(V[0-9.]+ )?Signer[^:]*:? certificate SHA-256 digest: ' <<<"$signature" | sed 's/^.*certificate SHA-256 digest: //' | sort -u || true)
[ "$(digest "$apk_cert")" = "$expected_cert" ] || fail "APK signer certificate is '$apk_cert', expected $expected_cert:"$'\n'"$signature"
if grep -qF 'CN=Android Debug' <<<"$signature"; then fail "APK is signed with the Android debug key"; fi
pass "APK signed with the upload certificate"

# --- APK identity and version.
badging=$("$tools/aapt2" dump badging "$apk" 2>&1) || fail "aapt2 cannot read $apk:"$'\n'"$badging"
require "APK is xyz.tinycloud.exo $version_name ($version_code)" "$badging" \
  "package: name='xyz.tinycloud.exo' versionCode='$version_code' versionName='$version_name'" "application-label:'Exo'" "application-icon-"
if grep -q '^application-debuggable' <<<"$badging"; then fail "APK is debuggable"; fi
pass "APK is not debuggable"
# The TC-524 location spike declares its permissions in the debug manifest only. A release asking for location
# would need Play's location declarations (mobile/docs/location-spike.md) before it may ship.
if grep -qE "uses-permission: name='android\.permission\.(ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION|FOREGROUND_SERVICE_LOCATION)'" <<<"$badging"; then
  fail "APK requests location permissions; the location spike is debug-only"
fi
pass "APK requests no location permission"

# $1 = label, $2 = archive, $3 = path prefix of the Capacitor assets inside it
check_web_app() {
  local label=$1 archive=$2 prefix=$3 config
  unzip -l "$archive" "${prefix}public/index.html" >/dev/null 2>&1 || fail "$label does not bundle the web app (${prefix}public/index.html)"
  config=$(unzip -p "$archive" "${prefix}capacitor.config.json") || fail "$label has no ${prefix}capacitor.config.json"
  node -e '
    const config = JSON.parse(process.argv[1]);
    if (config.appId !== "xyz.tinycloud.exo") throw new Error(`appId is ${config.appId}`);
    if (config.server?.url) throw new Error(`server.url is ${config.server.url} (a live-reload build)`);
  ' "$config" || fail "$label: capacitor.config.json is not a release config:"$'\n'"$config"
  pass "$label bundles the web app and loads no dev server"
}
check_web_app APK "$apk" assets/
check_web_app AAB "$aab" base/assets/

# --- AAB signature (Play checks the upload key from the bundle's JAR signature). Not -strict: an upload certificate
# is always self-signed, which -strict reports as an error.
jar=$(jarsigner -verify "$aab" 2>&1) || fail "jarsigner rejects $aab:"$'\n'"$jar"
grep -qx 'jar verified.' <<<"$jar" || fail "AAB is not signed:"$'\n'"$jar"
if grep -qF 'unsigned entries' <<<"$jar"; then fail "AAB has unsigned entries:"$'\n'"$jar"; fi
pass "AAB JAR signature verifies"
aab_cert=$(keytool -printcert -jarfile "$aab" 2>&1) || fail "keytool cannot read the AAB signer:"$'\n'"$aab_cert"
[ "$(grep -c '^Signer #' <<<"$aab_cert")" = 1 ] || fail "AAB must have exactly one signer:"$'\n'"$aab_cert"
aab_digest=$(sed -n 's/^[[:space:]]*SHA256: //p' <<<"$aab_cert" | head -n 1)
[ "$(digest "$aab_digest")" = "$expected_cert" ] || fail "AAB signer certificate is $aab_digest, expected $expected_cert"
pass "AAB signed with the upload certificate"

echo "Exo $version_name ($version_code) for Android is release-signed with certificate $expected_cert."
