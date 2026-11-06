#!/usr/bin/env bash
# Build the Home feed design rig (frontend/feed-rig.html: the real Home feed components over
# frontend/src/feedRig/feed-fixture.json) and publish it as a static site. One command:
#   scripts/publish-feed-rig.sh [target-dir] [public-url]
# The defaults publish to a static folder served only on the team's private tailnet host; the
# rig is never published to the public web. No API, no session, no network calls at runtime.
#
# The committed fixture is synthetic. When the private overlay FEED_RIG_OVERLAY exists
# (default ~/.local/share/feed-rig-private/real-cards.json, kept outside the repository), its
# entries replace the matching stand-in cards before the build (scripts/feed-rig-merge.mjs).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-$HOME/.local/share/rocinante-static/db-options/briefs/feed-rig}"
url="${2:-https://lightning-node-1.gecko-snares.ts.net/db-options/briefs/feed-rig/}"
overlay="${FEED_RIG_OVERLAY:-$HOME/.local/share/feed-rig-private/real-cards.json}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cd "$root/frontend"
if [ -f "$overlay" ]; then
  node "$root/scripts/feed-rig-merge.mjs" src/feedRig/feed-fixture.json "$overlay" "$stage/fixture.json"
  export FEED_RIG_FIXTURE="$stage/fixture.json"
else
  echo "feed rig: no private overlay at $overlay; publishing the synthetic fixture only"
fi
npx vite build --config vite.feed-rig.config.ts --logLevel warn
rm -f "$stage/fixture.json"

cp dist-feed-rig/feed-rig.html "$stage/index.html"
cp -r dist-feed-rig/assets "$stage/assets"
mkdir -p "$stage/fonts" "$stage/icons"
cp -r dist-feed-rig/fonts/literata "$stage/fonts/literata"
cp dist-feed-rig/icons/apple-touch-icon-180.png dist-feed-rig/icons/pwa-192.png "$stage/icons/"
printf '%s\n' "$(git -C "$root" rev-parse --short HEAD)$(git -C "$root" diff --quiet || echo '+dirty')" > "$stage/BUILD.txt"

mkdir -p "$target"
rsync -a --delete "$stage/" "$target/"
chmod -R a+rX "$target"

css="$(cd "$target" && ls assets/*.css | head -1)"
js="$(cd "$target" && ls assets/index-*.js | head -1)"
roci-linkcheck "$url" "${url}?state=many&w=1280" "${url}?frame=1&state=many" "$url$css" "$url$js" \
  "${url}fonts/literata/literata-5.3.0-latin-opsz.woff2" "${url}icons/pwa-192.png"
echo "Published $(cat "$target/BUILD.txt") to $url"
