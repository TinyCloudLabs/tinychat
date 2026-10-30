#!/bin/bash
# exo-update: install or update Exo for Mac from this repo's GitHub releases.
#   exo-update         latest stable release
#   exo-update beta    newest build, including betas
#
# Without installing it first:
#   curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/tinychat/main/desktop/scripts/exo-update.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/tinychat/main/desktop/scripts/exo-update.sh | bash -s -- beta
#
# It looks up the release and downloads its DMG over HTTPS from GitHub only, checks it against the release's
# SHA256SUMS.txt, quits Exo, replaces /Applications/Exo.app and opens it. A first install works the
# same way. There is no downgrade guard: switching from beta to stable installs the latest stable
# even when it is older than the build you have. A file downloaded with curl is not quarantined, so
# the unsigned app opens without "Open Anyway". Written for bash; it also runs under POSIX sh.
# scripts/__tests__/release.test.mjs runs it against stub tools.
set -eu

REPO="TinyCloudLabs/tinychat"
# Test seams (scripts/__tests__/release.test.mjs); real installs use the defaults.
APPS="${EXO_UPDATE_APPLICATIONS:-/Applications}"
PLISTBUDDY="${EXO_UPDATE_PLISTBUDDY:-/usr/libexec/PlistBuddy}"
APP="$APPS/Exo.app"
NEW="$APPS/Exo.exo-update-new.app"
OLD="$APPS/Exo.exo-update-old.app"
STATE="$HOME/.exo-update"
CURL="curl --proto =https --proto-redir =https"

# Every request, the release lookup included, follows redirects one hop at a time and refuses any
# hop that is not HTTPS on one of these hosts (release downloads redirect to GitHub's asset CDN).
allowed_host() {
  case "$1" in
    api.github.com|github.com|release-assets.githubusercontent.com|objects.githubusercontent.com) return 0 ;;
  esac
  return 1
}
fetch() { # fetch <url> <file> [progress]
  url=$1
  hops=0
  if [ -n "${3:-}" ]; then flags="-fS --progress-bar"; else flags="-fsS"; fi
  while :; do
    case "$url" in
      https://*) ;;
      *) echo "Refusing a download that isn't HTTPS: $url" >&2; exit 1 ;;
    esac
    host=${url#https://}
    host=${host%%/*}
    host=${host%%\?*}
    allowed_host "$host" || { echo "Refusing a download from $host, which isn't GitHub." >&2; exit 1; }
    next=$($CURL $flags --max-redirs 0 -o "$2" -w '%{redirect_url}' "$url")
    [ -n "$next" ] || return 0
    hops=$((hops + 1))
    [ "$hops" -le 5 ] || { echo "Too many redirects downloading $1." >&2; exit 1; }
    url=$next
  done
}

TMP=$(mktemp -d)
MNT="$TMP/mnt"
MOUNTED=
cleanup() {
  if [ -n "$MOUNTED" ]; then hdiutil detach -quiet "$MNT" 2>/dev/null || true; fi
  # A swap cut short puts the previous app back.
  if [ ! -e "$APP" ] && [ -e "$OLD" ]; then mv "$OLD" "$APP"; fi
  rm -rf "$TMP" "$NEW" "$OLD"
}
# Interrupts and kills exit through cleanup with a failing status.
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${1:-}" = "beta" ]; then
  URL="https://api.github.com/repos/$REPO/releases?per_page=20"
else
  URL="https://api.github.com/repos/$REPO/releases/latest"
fi
fetch "$URL" "$TMP/release.json"
JSON=$(cat "$TMP/release.json")
TAG=$(printf '%s\n' "$JSON" | grep -o '"tag_name": *"exo-desktop@[^"]*"' | sed -n '1s/.*"\(exo-desktop@[^"]*\)"$/\1/p')
[ -n "$TAG" ] || { echo "Couldn't find an Exo release." >&2; exit 1; }
V="${TAG#exo-desktop@}"

installed_build() { "$PLISTBUDDY" -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist" 2>/dev/null || true; }
if [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$TAG $(installed_build)" ]; then
  echo "Exo $V is already installed."
  exit 0
fi

DMG="Exo_${V}_aarch64.dmg"
BASE="https://github.com/$REPO/releases/download/exo-desktop%40$V"

echo "Downloading Exo $V..."
fetch "$BASE/$DMG" "$TMP/$DMG" progress
fetch "$BASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt"
LINE=$(grep " $DMG\$" "$TMP/SHA256SUMS.txt" || true)
if [ -z "$LINE" ]; then
  echo "The release's SHA256SUMS.txt has no entry for $DMG, so nothing was installed." >&2
  exit 1
fi
if ! (cd "$TMP" && printf '%s\n' "$LINE" | shasum -a 256 -c - >/dev/null); then
  echo "The download didn't match its checksum, so nothing was installed." >&2
  exit 1
fi

# Replacing the app while it runs can lose work, so quit it first (Exo may ask to confirm).
running() { pgrep -f "^$APP/Contents/MacOS/" >/dev/null; }
if running; then
  echo "Quitting Exo..."
  osascript -e 'tell application id "xyz.tinycloud.exo" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 60); do running || break; sleep 1; done
  if running; then
    echo "Exo didn't quit. Close it, then run exo-update again." >&2
    exit 1
  fi
fi

mkdir "$MNT"
# Marked before attaching, so a signal during or right after attach still detaches.
MOUNTED=1
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$TMP/$DMG"
# Copy the new app in full, then swap; cleanup puts the old app back if the swap is cut short.
rm -rf "$NEW" "$OLD"
ditto "$MNT/Exo.app" "$NEW"
if [ -e "$APP" ]; then mv "$APP" "$OLD"; fi
mv "$NEW" "$APP"
rm -rf "$OLD"
echo "$TAG $(installed_build)" > "$STATE"
echo "Installed Exo $V. Release notes: https://github.com/$REPO/releases/tag/exo-desktop%40$V"
open "$APP"
