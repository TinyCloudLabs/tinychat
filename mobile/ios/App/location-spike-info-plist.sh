#!/bin/sh
# TC-524 location spike: add the location keys to the Info.plist of DEBUG builds only (an Xcode "Run Script" build
# phase of the App target, after Info.plist processing and before code signing). Release builds are left alone and
# compile no location code (LocationRecorder.swift is #if DEBUG), so the App Store binary has no location purpose
# strings, no `location` background mode and no CoreLocation; ios-build.yml checks all three on every Release
# archive. What shipping it would change: mobile/docs/location-spike.md, "What production would change".
set -eu

if [ "${CONFIGURATION:-}" != "Debug" ]; then
  echo "location spike: ${CONFIGURATION:-unknown} build, Info.plist left alone"
  exit 0
fi

plist="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
plutil -replace NSLocationWhenInUseUsageDescription -string \
  "Exo records your location while you use it, only after you turn location on, and saves it to your TinyCloud space." \
  "$plist"
plutil -replace NSLocationAlwaysAndWhenInUseUsageDescription -string \
  "Exo keeps recording your location in the background after you turn it on, so your timeline has no gaps. It is saved to your TinyCloud space, and you can turn it off at any time." \
  "$plist"
if ! plutil -extract UIBackgroundModes json -o - "$plist" | grep -q '"location"'; then
  /usr/libexec/PlistBuddy -c "Add :UIBackgroundModes:0 string location" "$plist"
fi
echo "location spike: added the location usage strings and the location background mode to $plist"
