#!/bin/bash
# exo-update: install or update TinyCloud One for Mac from this repo's GitHub releases.
#   exo-update         latest stable release
#   exo-update beta    newest build, including betas
#
# Without installing it first:
#   curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/tinychat/main/desktop/scripts/exo-update.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/tinychat/main/desktop/scripts/exo-update.sh | bash -s -- beta
#
# It looks up the release and downloads its DMG over HTTPS from GitHub only, checks it against the release's
# SHA256SUMS.txt, quits TinyCloud One, replaces /Applications/TinyCloud One.app (or an older /Applications/TinyCloud Home.app or /Applications/Exo.app)
# and opens it. A first install works the
# same way. There is no downgrade guard: switching from beta to stable installs the latest stable
# even when it is older than the build you have. Releases from 0.14.0-beta.6 on are Developer ID signed and notarized;
# a file downloaded with curl is not quarantined anyway, so an older unsigned app also opens without "Open Anyway".
# Written for bash; it also runs under POSIX sh.
# scripts/__tests__/release.test.mjs runs it against stub tools.
set -eu

REPO="TinyCloudLabs/tinychat"
# Test seams (scripts/__tests__/release.test.mjs); real installs use the defaults.
APPS="${EXO_UPDATE_APPLICATIONS:-/Applications}"
PLISTBUDDY="${EXO_UPDATE_PLISTBUDDY:-/usr/libexec/PlistBuddy}"
APP="$APPS/TinyCloud One.app"
# Builds before the renames installed as TinyCloud Home.app, and before that as Exo.app (same bundle id); the update replaces it.
CURRENT="$APP"
if [ ! -e "$APP" ]; then
  if [ -e "$APPS/TinyCloud Home.app" ]; then CURRENT="$APPS/TinyCloud Home.app"
  elif [ -e "$APPS/Exo.app" ]; then CURRENT="$APPS/Exo.app"; fi
fi
NEW="$APPS/TinyCloud One.exo-update-new.app"
OLD="$APPS/TinyCloud One.exo-update-old.app"
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
[ -n "$TAG" ] || { echo "Couldn't find a TinyCloud One release." >&2; exit 1; }
V="${TAG#exo-desktop@}"

installed_build() { "$PLISTBUDDY" -c 'Print :CFBundleVersion' "$1/Contents/Info.plist" 2>/dev/null || true; }
if [ "$CURRENT" = "$APP" ] && [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$TAG $(installed_build "$APP")" ]; then
  echo "TinyCloud One $V is already installed."
  exit 0
fi

BASE="https://github.com/$REPO/releases/download/exo-desktop%40$V"

# Releases before the first rename ship Exo_<v>_aarch64.dmg holding Exo.app, then TinyCloud-Home_<v>_aarch64.dmg
# holding TinyCloud Home.app, then TinyCloud-One_<v>_aarch64.dmg holding TinyCloud One.app. The checksum list names the
# DMG this release has.
fetch "$BASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt"
DMG=
for candidate in "TinyCloud-One_${V}_aarch64.dmg" "TinyCloud-Home_${V}_aarch64.dmg" "Exo_${V}_aarch64.dmg"; do
  if grep -q " $candidate\$" "$TMP/SHA256SUMS.txt"; then DMG="$candidate"; break; fi
done
if [ -z "$DMG" ]; then
  echo "The release's SHA256SUMS.txt has no entry for TinyCloud-One_${V}_aarch64.dmg, TinyCloud-Home_${V}_aarch64.dmg or Exo_${V}_aarch64.dmg, so nothing was installed." >&2
  exit 1
fi
LINE=$(grep " $DMG\$" "$TMP/SHA256SUMS.txt")

echo "Downloading TinyCloud One $V..."
fetch "$BASE/$DMG" "$TMP/$DMG" progress
if ! (cd "$TMP" && printf '%s\n' "$LINE" | shasum -a 256 -c - >/dev/null); then
  echo "The download didn't match its checksum, so nothing was installed." >&2
  exit 1
fi

# Replacing the app while it runs can lose work, so quit it first (TinyCloud One may ask to confirm).
running() { pgrep -f "^$CURRENT/Contents/MacOS/" >/dev/null; }
if running; then
  echo "Quitting TinyCloud One..."
  osascript -e 'tell application id "xyz.tinycloud.exo" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 60); do running || break; sleep 1; done
  if running; then
    echo "TinyCloud One didn't quit. Close it, then run exo-update again." >&2
    exit 1
  fi
fi

mkdir "$MNT"
# Marked before attaching, so a signal during or right after attach still detaches.
MOUNTED=1
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$TMP/$DMG"
# Copy the new app in full, then swap; cleanup puts the old app back if the swap is cut short.
rm -rf "$NEW" "$OLD"
SOURCE="$MNT/TinyCloud One.app"
[ -e "$SOURCE" ] || SOURCE="$MNT/TinyCloud Home.app"
[ -e "$SOURCE" ] || SOURCE="$MNT/Exo.app"
ditto "$SOURCE" "$NEW"
if [ -e "$CURRENT" ]; then mv "$CURRENT" "$OLD"; fi
mv "$NEW" "$APP"
rm -rf "$OLD"
echo "$TAG $(installed_build "$APP")" > "$STATE"
echo "Installed TinyCloud One $V. Release notes: https://github.com/$REPO/releases/tag/exo-desktop%40$V"
open "$APP"
