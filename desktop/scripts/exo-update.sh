#!/bin/bash
# exo-update: install or update Exo for Mac from this repo's GitHub releases.
#   exo-update         latest stable release
#   exo-update beta    newest build, betas included
#
# Without installing it first:
#   curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/tinychat/main/desktop/scripts/exo-update.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/tinychat/main/desktop/scripts/exo-update.sh | bash -s -- beta
#
# It downloads the release DMG, checks it against the release's SHA256SUMS.txt, quits Exo,
# replaces /Applications/Exo.app and opens it. A first install works the same way. A file
# downloaded with curl is not quarantined, so the unsigned app opens without "Open Anyway".
# Asset names come from scripts/release/desktop-release-plan.mjs (Exo_<version>_aarch64);
# scripts/__tests__/release.test.mjs fails if the two drift.
set -eu

REPO="TinyCloudLabs/tinychat"
APP="/Applications/Exo.app"
NEW="/Applications/Exo.exo-update.app"
STATE="$HOME/.exo-update"

if [ "${1:-}" = "beta" ]; then
  URL="https://api.github.com/repos/$REPO/releases?per_page=20"
else
  URL="https://api.github.com/repos/$REPO/releases/latest"
fi
JSON=$(curl -fsSL "$URL") || { echo "Couldn't reach GitHub." >&2; exit 1; }
TAG=$(printf '%s\n' "$JSON" | grep -o '"tag_name": *"exo-desktop@[^"]*"' | sed -n '1s/.*"\(exo-desktop@[^"]*\)"$/\1/p')
[ -n "$TAG" ] || { echo "Couldn't find an Exo release." >&2; exit 1; }
V="${TAG#exo-desktop@}"

installed_build() { /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist" 2>/dev/null || true; }
if [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$TAG $(installed_build)" ]; then
  echo "Exo $V is already installed."
  exit 0
fi

DMG="Exo_${V}_aarch64.dmg"
BASE="https://github.com/$REPO/releases/download/exo-desktop%40$V"
TMP=$(mktemp -d)
MNT="$TMP/mnt"
trap 'hdiutil detach -quiet "$MNT" 2>/dev/null || true; rm -rf "$TMP" "$NEW"' EXIT

echo "Downloading Exo $V..."
curl -fL --progress-bar -o "$TMP/$DMG" "$BASE/$DMG"
curl -fsSL -o "$TMP/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt"
if ! (cd "$TMP" && grep " $DMG\$" SHA256SUMS.txt | shasum -a 256 -c - >/dev/null); then
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
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$TMP/$DMG"
# Copy the new app in full before removing the old one, so a failed copy never leaves no Exo.
rm -rf "$NEW"
ditto "$MNT/Exo.app" "$NEW"
rm -rf "$APP"
mv "$NEW" "$APP"
echo "$TAG $(installed_build)" > "$STATE"
echo "Installed Exo $V. Release notes: https://github.com/$REPO/releases/tag/exo-desktop%40$V"
open "$APP"
