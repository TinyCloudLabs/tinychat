#!/usr/bin/env bash
# One-time: install the SDK packages and create the AVD the harness uses (Pixel 7, API 36, x86_64).
set -euo pipefail
. "$(dirname "$0")/env.sh"
SDKM=$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager
AVDM=$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager
yes | "$SDKM" --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" "emulator" \
  "system-images;android-36;google_apis;x86_64" >/dev/null || true
echo no | "$AVDM" create avd -n "$EXO_AVD" -k "system-images;android-36;google_apis;x86_64" -d pixel_7 --force >/dev/null
CONFIG=$HOME/.android/avd/$EXO_AVD.avd/config.ini
sed -i 's/^hw.audioInput=.*/hw.audioInput=yes/; s/^hw.ramSize=.*/hw.ramSize=4096/' "$CONFIG"
grep -q '^hw.audioInput' "$CONFIG" || echo 'hw.audioInput=yes' >> "$CONFIG"
echo "created AVD $EXO_AVD"
