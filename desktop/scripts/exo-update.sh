#!/bin/bash
# exo-update: install or update TinyCloud Home for Mac from this repo's GitHub releases.
#   exo-update         latest stable release
#   exo-update beta    newest build, including betas
#
# Without installing it first:
#   curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/tinychat/main/desktop/scripts/exo-update.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/tinychat/main/desktop/scripts/exo-update.sh | bash -s -- beta
#
# It looks up the release and downloads its DMG over HTTPS from GitHub only, checks it against the release's
# SHA256SUMS.txt, quits TinyCloud Home, replaces /Applications/TinyCloud Home.app (or an older /Applications/Exo.app)
# and opens it. A first install works the
# same way. There is no downgrade guard: switching from beta to stable installs the latest stable
# even when it is older than the build you have. A file downloaded with curl is not quarantined, so
# the unsigned app opens without "Open Anyway". Written for bash; it also runs under POSIX sh.
# scripts/__tests__/release.test.mjs runs it against stub tools.
set -eu

REPO="TinyCloudLabs/tinychat"
# Test seams (scripts/__tests__/release.test.mjs); real installs use the defaults.
APPS="${EXO_UPDATE_APPLICATIONS:-/Applications}"
PLISTBUDDY="${EXO_UPDATE_PLISTBUDDY:-/usr/libexec/PlistBuddy}"
APP="$APPS/TinyCloud Home.app"
# Builds before the rename installed as Exo.app (same bundle id); the update replaces it.
CURRENT="$APP"
if [ ! -e "$APP" ] && [ -e "$APPS/Exo.app" ]; then CURRENT="$APPS/Exo.app"; fi
NEW="$APPS/TinyCloud Home.exo-update-new.app"
OLD="$APPS/TinyCloud Home.exo-update-old.app"
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
  if [ ! -e "$APP" ] && [ ! -e "$CURRENT" ] && [ -e "$OLD" ]; then mv "$OLD" "$CURRENT"; fi
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
[ -n "$TAG" ] || { echo "Couldn't find a TinyCloud Home release." >&2; exit 1; }
V="${TAG#exo-desktop@}"

installed_build() { "$PLISTBUDDY" -c 'Print :CFBundleVersion' "$1/Contents/Info.plist" 2>/dev/null || true; }
if [ "$CURRENT" = "$APP" ] && [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$TAG $(installed_build "$APP")" ]; then
  echo "TinyCloud Home $V is already installed."
  exit 0
fi

BASE="https://github.com/$REPO/releases/download/exo-desktop%40$V"

# Releases before the rename ship Exo_<v>_aarch64.dmg holding Exo.app; later ones TinyCloud-Home_<v>_aarch64.dmg
# holding TinyCloud Home.app. The checksum list names the DMG this release has.
fetch "$BASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt"
DMG=
for candidate in "TinyCloud-Home_${V}_aarch64.dmg" "Exo_${V}_aarch64.dmg"; do
  if grep -q " $candidate\$" "$TMP/SHA256SUMS.txt"; then DMG="$candidate"; break; fi
done
if [ -z "$DMG" ]; then
  echo "The release's SHA256SUMS.txt has no entry for TinyCloud-Home_${V}_aarch64.dmg or Exo_${V}_aarch64.dmg, so nothing was installed." >&2
  exit 1
fi
LINE=$(grep " $DMG\$" "$TMP/SHA256SUMS.txt")

echo "Downloading TinyCloud Home $V..."
fetch "$BASE/$DMG" "$TMP/$DMG" progress
if ! (cd "$TMP" && printf '%s\n' "$LINE" | shasum -a 256 -c - >/dev/null); then
  echo "The download didn't match its checksum, so nothing was installed." >&2
  exit 1
fi

# Replacing the app while it runs can lose work, so quit it first (TinyCloud Home may ask to confirm).
running() { pgrep -f "^$CURRENT/Contents/MacOS/" >/dev/null; }
if running; then
  echo "Quitting TinyCloud Home..."
  osascript -e 'tell application id "xyz.tinycloud.exo" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 60); do running || break; sleep 1; done
  if running; then
    echo "TinyCloud Home didn't quit. Close it, then run exo-update again." >&2
    exit 1
  fi
fi

mkdir "$MNT"
# Marked before attaching, so a signal during or right after attach still detaches.
MOUNTED=1
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$TMP/$DMG"
# Copy the new app in full, then swap; cleanup puts the old app back if the swap is cut short.
rm -rf "$NEW" "$OLD"
SOURCE="$MNT/TinyCloud Home.app"
[ -e "$SOURCE" ] || SOURCE="$MNT/Exo.app"
ditto "$SOURCE" "$NEW"
if [ -e "$CURRENT" ]; then mv "$CURRENT" "$OLD"; fi
mv "$NEW" "$APP"
rm -rf "$OLD"
echo "$TAG $(installed_build "$APP")" > "$STATE"
echo "Installed TinyCloud Home $V. Release notes: https://github.com/$REPO/releases/tag/exo-desktop%40$V"
open "$APP"
