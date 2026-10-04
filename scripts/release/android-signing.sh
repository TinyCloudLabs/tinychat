#!/usr/bin/env bash
# Upload-key signing for Exo Android releases, outside Gradle: .github/workflows/mobile-release-android.yml's sign job
# runs it from the workflow commit's scripts/release, on the unsigned AAB and APK its build job made with
# EXO_UNSIGNED_RELEASE=true. No project code runs where the key is. Values are never printed.
#
#   android-signing.sh check   require the android-release secrets ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASSWORD,
#                              ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD and the variable ANDROID_UPLOAD_CERT_SHA256
#                              (the upload certificate's SHA-256, pinned separately from the keystore); a missing one
#                              fails with its name
#   android-signing.sh sign <unsigned.apk> <unsigned.aab> <out-dir> <cert SHA-256>
#                              sign with ANDROID_KEYSTORE_FILE (ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS,
#                              ANDROID_KEY_PASSWORD) into <out-dir>/app-release.apk and <out-dir>/app-release.aab. It
#                              refuses a key whose certificate is not <cert SHA-256> before signing anything. The APK
#                              is zipaligned and signed by apksigner (v2/v3), the AAB by jarsigner (Play reads the
#                              upload key from its JAR signature). Both read the passwords from the environment
#                              (--ks-pass env:, -storepass:env), never from the command line.
# Then check the result with verify-android-release.sh against the same pinned certificate.
# Tools: apksigner and zipalign from $ANDROID_BUILD_TOOLS, else the newest build-tools under $ANDROID_HOME
# ($ANDROID_SDK_ROOT); keytool and jarsigner from PATH.
set -euo pipefail

SECRETS=(ANDROID_KEYSTORE_B64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD)

fail() { echo "::error::$1"; exit 1; }

digest() { tr -d ': \n' <<<"$1" | tr '[:upper:]' '[:lower:]'; }

check() {
  local missing=() name
  for name in "${SECRETS[@]}" ANDROID_UPLOAD_CERT_SHA256; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "Android release signing is not set up: the android-release environment is missing ${missing[*]} (secrets, and the ANDROID_UPLOAD_CERT_SHA256 variable). Nothing was signed. Setup: mobile/README.md, \"Android release\"."
  fi
  [[ $(digest "$ANDROID_UPLOAD_CERT_SHA256") =~ ^[0-9a-f]{64}$ ]] ||
    fail "ANDROID_UPLOAD_CERT_SHA256 must be the upload certificate's SHA-256 (64 hex digits, colons allowed)"
  echo "android-release signing inputs present: ${SECRETS[*]} ANDROID_UPLOAD_CERT_SHA256"
}

sign() {
  local usage='usage: android-signing.sh sign <unsigned.apk> <unsigned.aab> <out-dir> <cert SHA-256>'
  local apk=${1:?$usage} aab=${2:?$usage} out=${3:?$usage} expected=${4:?$usage}
  local tools listing cert algorithm sigalg name jar
  [ -f "$apk" ] || fail "no unsigned APK at $apk"
  [ -f "$aab" ] || fail "no unsigned app bundle at $aab"
  expected=$(digest "$expected")
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || fail "expected certificate SHA-256 must be 64 hex digits"
  for name in ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
    [ -n "${!name:-}" ] || fail "$name is required"
  done
  [ -f "$ANDROID_KEYSTORE_FILE" ] || fail "ANDROID_KEYSTORE_FILE is not a file"

  # The key first: a wrong keystore, password, alias or certificate fails here, before anything is signed.
  listing=$(keytool -list -v -keystore "$ANDROID_KEYSTORE_FILE" -storepass:env ANDROID_KEYSTORE_PASSWORD -alias "$ANDROID_KEY_ALIAS" 2>&1) ||
    fail "cannot open key ANDROID_KEY_ALIAS in the keystore: wrong ANDROID_KEYSTORE_PASSWORD or ANDROID_KEY_ALIAS, or ANDROID_KEYSTORE_B64 is not the keystore"
  cert=$(digest "$(sed -n 's/^[[:space:]]*SHA256: //p' <<<"$listing" | head -n 1)")
  [ "$cert" = "$expected" ] ||
    fail "the keystore's certificate is $cert, not the pinned upload certificate $expected (ANDROID_UPLOAD_CERT_SHA256). Refusing to sign."
  algorithm=$(sed -n 's/^Subject Public Key Algorithm: //p' <<<"$listing" | head -n 1)
  case "$algorithm" in
    *RSA*) sigalg=SHA256withRSA ;;
    *EC*) sigalg=SHA256withECDSA ;;
    *) fail "unsupported upload key algorithm '$algorithm' (use RSA)" ;;
  esac

  tools=${ANDROID_BUILD_TOOLS:-}
  if [ -z "$tools" ]; then
    local sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
    [ -n "$sdk" ] || fail "set ANDROID_HOME (or ANDROID_BUILD_TOOLS) to find apksigner and zipalign"
    tools=$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)
  fi
  [ -x "$tools/apksigner" ] && [ -x "$tools/zipalign" ] || fail "no apksigner/zipalign in build-tools '$tools'"
  echo "Using build-tools $tools"

  # Unsigned inputs only: a second signer would make the result ambiguous (verify-android-release.sh requires one).
  if "$tools/apksigner" verify "$apk" >/dev/null 2>&1; then fail "$apk is already signed"; fi
  jar=$(jarsigner -verify "$aab" 2>&1) || true
  grep -qx 'jar is unsigned.' <<<"$jar" || fail "$aab is not an unsigned bundle:"$'\n'"$jar"

  mkdir -p "$out"
  work=$(mktemp -d) # global: the EXIT trap removes it after sign() returns
  trap 'rm -rf -- "$work"' EXIT
  # 4-byte alignment, uncompressed native libraries on 16 KB pages (Android 15+), before the v2/v3 signature.
  "$tools/zipalign" -f -P 16 4 "$apk" "$work/aligned.apk"
  "$tools/apksigner" sign --ks "$ANDROID_KEYSTORE_FILE" --ks-key-alias "$ANDROID_KEY_ALIAS" \
    --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
    --out "$out/app-release.apk" "$work/aligned.apk"
  rm -f "$out/app-release.apk.idsig"
  jarsigner -keystore "$ANDROID_KEYSTORE_FILE" -storepass:env ANDROID_KEYSTORE_PASSWORD -keypass:env ANDROID_KEY_PASSWORD \
    -sigalg "$sigalg" -digestalg SHA-256 -signedjar "$out/app-release.aab" "$aab" "$ANDROID_KEY_ALIAS" >/dev/null
  echo "Signed $out/app-release.apk and $out/app-release.aab with certificate $cert ($sigalg)"
}

case "${1:-}" in
  check) check ;;
  sign) shift; sign "$@" ;;
  *) echo "usage: android-signing.sh check | sign <unsigned.apk> <unsigned.aab> <out-dir> <cert SHA-256>" >&2; exit 2 ;;
esac
