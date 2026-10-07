#!/usr/bin/env bash
# Build the bundled Release app and install it over the existing device copy.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
UDID=${UDID:-00008140-0006645414D2801C}
TEAM=${TEAM:-UDTLDX736A}
BUNDLE=${BUNDLE:-xyz.tinycloud.exo.dev}
derived_data=${EXO_IOS_DERIVED_DATA:-/tmp/exo-ios-dd}

cd "$repo_root"
bun run build:packages
bun run build:frontend
env -u EXO_DEV_SERVER_URL bun run --cwd mobile sync ios

(
  cd mobile/ios/App
  xcodebuild build -project App.xcodeproj -scheme App -configuration Release \
    -destination "id=$UDID" -derivedDataPath "$derived_data" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    DEVELOPMENT_TEAM="$TEAM" EXO_BUNDLE_ID="$BUNDLE" \
    CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development"
)

app="$derived_data/Build/Products/Release-iphoneos/App.app"
test -d "$app" || { echo "Built app missing: $app" >&2; exit 1; }
if pgrep -fl 'devicectl device install|adb .*install'; then
  echo "Another device install is running; try again after it finishes." >&2
  exit 1
fi
xcrun devicectl device install app --device "$UDID" "$app"
echo "Installed $BUNDLE on $UDID from $app"
