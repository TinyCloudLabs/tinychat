#!/usr/bin/env bash
# Developer ID signing for Exo desktop releases. desktop-build.yml's preflight and sign jobs run it from the workflow
# commit's scripts/release, never from the built tree, on runners that never run project code: only Apple's tools touch
# the app (codesign, security, hdiutil, notarytool, stapler). In CI (sign: false) the sign job runs unpack, sign and
# dmg with the ad-hoc identity "-" as a dry run, so every desktop PR exercises the hand-off and the signing commands.
# Secret values come from the desktop-release environment and are never printed.
#
#   desktop-signing.sh check
#       require the desktop-release secrets and their shapes; a missing one fails with its name
#   desktop-signing.sh provenance <build sha>
#       refuse unless this is main's desktop-release.yml dispatched on main, the workflow commit and <build sha> are on
#       freshly fetched main, and an exo-desktop release tag points at <build sha>. Needs a checkout with history and
#       WORKFLOW_REF, WORKFLOW_SHA, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_REF
#   desktop-signing.sh unpack <app.zip> <dir> <version> <short version> <bundle version>
#       unzip the build's ditto-zipped Exo.app into <dir>, require xyz.tinycloud.exo at those versions with an executable
#       main binary and no symlink leaving the bundle; prints the app's path
#   desktop-signing.sh keychain <dir>
#       a temporary keychain <dir>/exo-signing.keychain-db holding APPLE_CERTIFICATE (base64 .p12), which must provide
#       the codesigning identity APPLE_SIGNING_IDENTITY; prints its path. Delete it with `security delete-keychain`
#   desktop-signing.sh sign <Exo.app> <entitlements> <identity> [keychain]
#       sign inside-out without --deep: every nested Mach-O file and code bundle, deepest first, then the app with the
#       entitlements; hardened runtime throughout, secure timestamp unless the identity is "-" (ad-hoc). Then verifies
#   desktop-signing.sh dmg <Exo.app> <out.dmg> <identity> [keychain]
#       an hdiutil UDZO image of the app plus an /Applications link, checked by mounting it, then signed unless the
#       identity is "-"
#   desktop-signing.sh write-key <dir>
#       the App Store Connect key, written as ios-signing.sh write-key does; prints its path
#   desktop-signing.sh notarize <Exo.app | .dmg> <AuthKey.p8>
#       submit to notarytool and wait (an app goes as a ditto zip), print Apple's log unless Accepted, staple the file
set -euo pipefail

BUNDLE_ID=xyz.tinycloud.exo
SECRETS=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_PRIVATE_KEY)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

fail() { echo "::error::$1"; exit 1; }

check() {
  local missing=() name
  for name in "${SECRETS[@]}"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "Desktop signing is not set up: the desktop-release environment is missing ${missing[*]}. Nothing was built or signed. Setup: desktop/README.md, \"Releases and signing\"."
  fi
  [[ $APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ ]] || fail "APPLE_TEAM_ID must be the 10-character Team ID"
  case "$APPLE_SIGNING_IDENTITY" in
    "Developer ID Application: "*"($APPLE_TEAM_ID)") ;;
    *) fail "APPLE_SIGNING_IDENTITY must be the 'Developer ID Application: <name> (<APPLE_TEAM_ID>)' identity" ;;
  esac
  [[ $APPLE_API_KEY =~ ^[A-Z0-9]{10}$ ]] || fail "APPLE_API_KEY must be the 10-character App Store Connect key ID"
  [[ $APPLE_API_ISSUER =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
    fail "APPLE_API_ISSUER must be the App Store Connect issuer ID (a UUID)"
  [[ $APPLE_CERTIFICATE =~ ^[A-Za-z0-9+/=[:space:]]+$ ]] || fail "APPLE_CERTIFICATE must be base64 of the Developer ID Application .p12"
  echo "desktop-release secrets present: ${SECRETS[*]}"
}

provenance() {
  local build=${1:-} expected sha tags
  expected="${GITHUB_REPOSITORY:-}/.github/workflows/desktop-release.yml@refs/heads/main"
  refuse() { echo "::error::Refusing to sign: $1"; exit 1; }
  if [ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ] || [ "${GITHUB_REF:-}" != refs/heads/main ] || [ "${WORKFLOW_REF:-}" != "$expected" ]; then
    refuse "signing runs only in $expected dispatched on main (got ${GITHUB_EVENT_NAME:-}, ${GITHUB_REF:-}, ${WORKFLOW_REF:-})"
  fi
  [[ ${WORKFLOW_SHA:-} =~ ^[0-9a-f]{40}$ ]] || refuse "WORKFLOW_SHA must be the workflow's commit SHA"
  [[ $build =~ ^[0-9a-f]{40}$ ]] || refuse "the build ref must be the release commit's full SHA (got '$build')"
  git fetch --force --no-tags origin +refs/heads/main:refs/remotes/origin/main '+refs/tags/exo-desktop@*:refs/tags/exo-desktop@*' >&2 ||
    refuse "cannot fetch main and the exo-desktop tags"
  git merge-base --is-ancestor "$WORKFLOW_SHA" origin/main || refuse "workflow commit $WORKFLOW_SHA is not on main"
  sha=$(git rev-parse --verify -q "$build^{commit}") || refuse "unknown commit $build"
  git merge-base --is-ancestor "$sha" origin/main || refuse "$sha is not on main"
  tags=$(git tag --points-at "$sha" | grep -E '^exo-desktop@[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || true)
  [ -n "$tags" ] || refuse "no exo-desktop release tag points at $sha"
  echo "Signing $sha ($(echo "$tags" | tr '\n' ' ' | sed 's/ $//')) with $WORKFLOW_REF at $WORKFLOW_SHA"
}

plist_value() { plutil -extract "$1" raw -o - "$2" 2>/dev/null; }

# True when the symlink at $1 (a path relative to the bundle root) points outside the bundle. Lexical, like the bundle
# itself: no absolute targets, and `..` may not climb above the root.
escapes() {
  local link=$1 target=$2 depth=0 part
  case "$target" in /*) return 0 ;; esac
  local IFS=/
  set -f
  for part in $(dirname "$link")/$target; do
    case "$part" in
      '' | .) ;;
      ..) depth=$((depth - 1)); if [ "$depth" -lt 0 ]; then set +f; return 0; fi ;;
      *) depth=$((depth + 1)) ;;
    esac
  done
  set +f
  return 1
}

unpack() {
  local zip=${1:-} dir=${2:-} version=${3:-} short=${4:-} build=${5:-} app plist exe link
  [ -n "$build" ] || fail "usage: desktop-signing.sh unpack <app.zip> <dir> <version> <short version> <bundle version>"
  # The build job's outputs are only strings: they must look like versions before they name or check anything.
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]] || fail "the build reports version '$version', not X.Y.Z or X.Y.Z-beta.N"
  [ "$short" = "${version%%-*}" ] || fail "the build reports short version '$short' for $version"
  [[ $build =~ ^[1-9][0-9]*$ ]] || fail "the build reports bundle version '$build', not a number"
  [ -f "$zip" ] || fail "no app archive at $zip"
  rm -rf "$dir"
  mkdir -p "$dir"
  ditto -x -k "$zip" "$dir"
  app="$dir/Exo.app"
  plist="$app/Contents/Info.plist"
  [ -f "$plist" ] || fail "$(basename "$zip") holds no Exo.app"
  [ "$(plist_value CFBundleIdentifier "$plist")" = "$BUNDLE_ID" ] || fail "the app is not $BUNDLE_ID"
  [ "$(plist_value CFBundleShortVersionString "$plist")" = "$short" ] || fail "the app is not version $short"
  [ "$(plist_value CFBundleVersion "$plist")" = "$build" ] || fail "the app is not build $build"
  exe=$(plist_value CFBundleExecutable "$plist")
  [ -n "$exe" ] && [ -f "$app/Contents/MacOS/$exe" ] || fail "the app has no main executable"
  [ -x "$app/Contents/MacOS/$exe" ] || fail "Contents/MacOS/$exe lost its executable bit in the hand-off"
  while IFS= read -r link; do
    if escapes "${link#"$app"/}" "$(readlink "$link")"; then fail "symlink ${link#"$dir"/} points outside the app ($(readlink "$link"))"; fi
  done < <(find "$app" -type l)
  echo "Exo $version ($short, $build) unpacked: $(du -sh "$app" | cut -f1)" >&2
  echo "$app"
}

keychain() {
  local dir=${1:?usage: desktop-signing.sh keychain <dir>} keychain password p12
  [ -n "${APPLE_CERTIFICATE:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ] && [ -n "${APPLE_SIGNING_IDENTITY:-}" ] ||
    fail "APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD and APPLE_SIGNING_IDENTITY are required"
  (umask 077 && mkdir -p "$dir")
  keychain="$dir/exo-signing.keychain-db"
  p12="$dir/developer-id.p12"
  password=$(openssl rand -hex 24)
  security create-keychain -p "$password" "$keychain"
  # No auto-lock: the DMG is signed after the app's notarization, which can take most of an hour.
  security set-keychain-settings "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  if ! (umask 077 && printf '%s' "$APPLE_CERTIFICATE" | tr -d ' \t\r\n' | base64 --decode >"$p12"); then
    rm -f "$p12"
    fail "APPLE_CERTIFICATE is not base64 of the .p12"
  fi
  if ! security import "$p12" -k "$keychain" -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >&2; then
    rm -f "$p12"
    fail "cannot import APPLE_CERTIFICATE with APPLE_CERTIFICATE_PASSWORD"
  fi
  rm -f "$p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
  # codesign resolves --keychain within the search list, so the temporary keychain joins it (deleting it removes it).
  # shellcheck disable=SC2046 # one keychain path per word
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  security find-identity -v -p codesigning "$keychain" | grep -qF "\"$APPLE_SIGNING_IDENTITY\"" ||
    fail "APPLE_CERTIFICATE holds no valid codesigning identity named APPLE_SIGNING_IDENTITY"
  echo "$keychain"
}

is_macho() {
  case "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" in
    cffaedfe | cefaedfe | feedfacf | feedface | cafebabe | bebafeca) return 0 ;;
    *) return 1 ;;
  esac
}

# Everything inside the app that carries its own signature, deepest first: Mach-O files other than the app's main
# executable, and bundles that contain code (resource-only bundles are sealed as the app's resources).
nested_code() {
  local app=$1 main path file
  main="$app/Contents/MacOS/$(plist_value CFBundleExecutable "$app/Contents/Info.plist")"
  find "$app/Contents" -mindepth 1 \( -type f -o -type d \( -name '*.app' -o -name '*.appex' -o -name '*.xpc' \
    -o -name '*.framework' -o -name '*.plugin' -o -name '*.bundle' -o -name '*.systemextension' \) \) |
    while IFS= read -r path; do
      if [ -f "$path" ]; then
        if [ "$path" != "$main" ] && is_macho "$path"; then echo "$path"; fi
      else
        while IFS= read -r file; do
          if is_macho "$file"; then echo "$path"; break; fi
        done < <(find "$path" -type f)
      fi
    done | awk -F/ '{ print NF "\t" $0 }' | sort -t "$(printf '\t')" -k1,1nr -k2 | cut -f2-
}

sign() {
  local app=${1:-} entitlements=${2:-} identity=${3:-} keychain=${4:-} opts details path count=0
  [ -n "$identity" ] || fail "usage: desktop-signing.sh sign <Exo.app> <entitlements> <identity> [keychain]"
  [ -f "$app/Contents/Info.plist" ] || fail "no app bundle at $app"
  [ -f "$entitlements" ] || fail "no entitlements at $entitlements"
  plutil -lint "$entitlements" >/dev/null || fail "$entitlements is not a valid plist"
  opts=(--force --options runtime --sign "$identity")
  if [ "$identity" = - ]; then opts+=(--timestamp=none); else opts+=(--timestamp); fi
  if [ -n "$keychain" ]; then opts+=(--keychain "$keychain"); fi
  while IFS= read -r path; do
    codesign "${opts[@]}" "$path" || fail "codesign failed for ${path#"$app"/}"
    count=$((count + 1))
  done < <(nested_code "$app")
  codesign "${opts[@]}" --entitlements "$entitlements" "$app" || fail "codesign failed for $app"

  codesign --verify --deep --strict --verbose=2 "$app" || fail "codesign --verify --deep --strict failed for $app"
  details=$(codesign -dvvv "$app" 2>&1) || fail "codesign -dvvv failed for $app"
  grep -qE '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)' <<<"$details" || fail "the app is not signed with the hardened runtime"
  codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -qF com.apple.security.device.audio-input ||
    fail "the app's signature lacks the audio-input entitlement"
  if [ "$identity" = - ]; then
    echo "Exo.app re-sealed ad-hoc inside-out ($count nested), hardened runtime, entitlements from $entitlements"
  else
    echo "Exo.app signed with Developer ID inside-out ($count nested), hardened runtime, entitlements from $entitlements"
  fi
}

dmg() {
  local app=${1:-} out=${2:-} identity=${3:-} keychain=${4:-} staging mnt attempt opts
  [ -n "$identity" ] || fail "usage: desktop-signing.sh dmg <Exo.app> <out.dmg> <identity> [keychain]"
  [ -f "$app/Contents/Info.plist" ] || fail "no app bundle at $app"
  staging=$(mktemp -d "${RUNNER_TEMP:-/tmp}/exo-dmg.XXXXXX")
  ditto "$app" "$staging/Exo.app"
  ln -s /Applications "$staging/Applications"
  mkdir -p "$(dirname "$out")"
  rm -f "$out"
  # Hosted runners sometimes report "Resource busy" on the first try.
  for attempt in 1 2 3; do
    if hdiutil create -volname Exo -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$out"; then break; fi
    [ "$attempt" -lt 3 ] || fail "hdiutil create failed for $out"
    sleep 10
  done
  rm -rf "$staging"
  hdiutil verify "$out"
  mnt=$(mktemp -d "${RUNNER_TEMP:-/tmp}/exo-dmg-mount.XXXXXX")
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$out" >/dev/null
  if ! codesign --verify --deep --strict --verbose=2 "$mnt/Exo.app" || [ "$(readlink "$mnt/Applications")" != /Applications ]; then
    hdiutil detach "$mnt" >/dev/null || true
    fail "$(basename "$out") does not hold a valid Exo.app and an /Applications link"
  fi
  hdiutil detach "$mnt" >/dev/null
  if [ "$identity" != - ]; then
    opts=(--force --timestamp --sign "$identity")
    if [ -n "$keychain" ]; then opts+=(--keychain "$keychain"); fi
    codesign "${opts[@]}" "$out" || fail "codesign failed for $out"
    codesign --verify --strict --verbose=2 "$out" || fail "codesign --verify failed for $out"
  fi
  echo "$(basename "$out"): $(du -h "$out" | cut -f1), mounts with a valid Exo.app$([ "$identity" = - ] || echo ', signed')"
}

notarize() {
  local file=${1:-} key=${2:-} submit result status id
  [ -n "$key" ] || fail "usage: desktop-signing.sh notarize <Exo.app | .dmg> <AuthKey.p8>"
  [ -e "$file" ] || fail "nothing to notarize at $file"
  [ -f "$key" ] || fail "no App Store Connect key at $key"
  [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] || fail "APPLE_API_KEY and APPLE_API_ISSUER are required"
  submit=$file
  if [ -d "$file" ]; then
    submit="$(mktemp -d "${RUNNER_TEMP:-/tmp}/exo-notarize.XXXXXX")/$(basename "$file").zip"
    ditto -c -k --keepParent "$file" "$submit"
  fi
  result=$(xcrun notarytool submit "$submit" --key "$key" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
    --wait --timeout 45m --output-format json) || true
  echo "$result"
  status=$(jq -r '.status // empty' <<<"$result" 2>/dev/null || true)
  if [ "$status" != Accepted ]; then
    id=$(jq -r '.id // empty' <<<"$result" 2>/dev/null || true)
    if [ -n "$id" ]; then
      xcrun notarytool log "$id" --key "$key" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" || true
    fi
    fail "notarization of $(basename "$file") was not accepted (status '${status:-none}')"
  fi
  if [ "$submit" != "$file" ]; then rm -rf "$(dirname "$submit")"; fi
  xcrun stapler staple "$file"
  xcrun stapler validate "$file"
}

case "${1:-}" in
  check) check ;;
  provenance) provenance "${2:-}" ;;
  unpack) unpack "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-}" ;;
  keychain) keychain "${2:-}" ;;
  sign) sign "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  dmg) dmg "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  write-key) exec "$here/ios-signing.sh" write-key "${2:-}" ;;
  notarize) notarize "${2:-}" "${3:-}" ;;
  *)
    echo "usage: desktop-signing.sh check | provenance <sha> | unpack <zip> <dir> <version> <short> <build> | keychain <dir>" \
      "| sign <app> <entitlements> <identity> [keychain] | dmg <app> <dmg> <identity> [keychain] | write-key <dir>" \
      "| notarize <app|dmg> <key>" >&2
    exit 2
    ;;
esac
