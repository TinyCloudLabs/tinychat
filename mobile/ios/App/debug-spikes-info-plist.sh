#!/bin/sh
# Debug-only Info.plist keys for the health (TC-525) and location (TC-524) spikes: an Xcode "Run Script" build phase
# of the App target, after Info.plist processing and before code signing. Release builds are left alone. HealthKit
# and its entitlements are Debug-only, and LocationRecorder.swift is #if DEBUG, so the App Store binary has no health
# or location purpose strings, no `location` background mode, no HealthKit and no CoreLocation; ios-build.yml checks
# all of them on every Release archive. What shipping either would change: mobile/docs/health-spike.md and
# mobile/docs/location-spike.md.
set -eu

if [ "${CONFIGURATION:-}" != "Debug" ]; then
  echo "debug spikes: ${CONFIGURATION:-unknown} build, Info.plist left alone"
  exit 0
fi

plist="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
plutil -replace NSHealthShareUsageDescription -string \
  "TinyCloud One reads the steps, sleep and heart rate you allow and saves a daily summary to your own TinyCloud space. It never uses health data for advertising." \
  "$plist"
plutil -replace NSHealthUpdateUsageDescription -string \
  "TinyCloud One's development preview can add sample steps, sleep and heart rate to Health for testing. TinyCloud One never writes health data otherwise." \
  "$plist"
plutil -replace NSLocationWhenInUseUsageDescription -string \
  "TinyCloud One records your location while you use it, only after you turn location on, and saves it to your TinyCloud space." \
  "$plist"
plutil -replace NSLocationAlwaysAndWhenInUseUsageDescription -string \
  "TinyCloud One keeps recording your location in the background after you turn it on, so your timeline has no gaps. It is saved to your TinyCloud space, and you can turn it off at any time." \
  "$plist"
if ! plutil -extract UIBackgroundModes json -o - "$plist" | grep -q '"location"'; then
  /usr/libexec/PlistBuddy -c "Add :UIBackgroundModes:0 string location" "$plist"
fi
echo "debug spikes: added the health and location usage strings and the location background mode to $plist"
