#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/env.sh"
image="system-images;android-$EXO_AVD_API;google_apis;$EXO_ABI"
set +o pipefail # yes exits on SIGPIPE after sdkmanager has accepted the license
yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "cmdline-tools;latest" "platform-tools" "platforms;android-$EXO_AVD_API" "emulator" "$image" >/dev/null
set -o pipefail
if ! "$AVDMANAGER" list target | grep -q "android-$EXO_AVD_API"; then
  # Homebrew's avdmanager can see no SDK targets even while sdkmanager installs
  # into ANDROID_HOME. Use the matching SDK-root copy in that case.
  sdk_avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
  if [ ! -x "$sdk_avdmanager" ]; then
    echo "avdmanager cannot see Android $EXO_AVD_API and $sdk_avdmanager is missing" >&2
    exit 1
  fi
  echo "Using SDK-root avdmanager because $AVDMANAGER sees no Android $EXO_AVD_API target" >&2
  AVDMANAGER="$sdk_avdmanager"
fi
if ! "$AVDMANAGER" list avd | grep -q "Name: $EXO_AVD"; then
  echo no | "$AVDMANAGER" create avd -n "$EXO_AVD" -k "$image" --force >/dev/null
fi
config="$HOME/.android/avd/$EXO_AVD.avd/config.ini"
sed -i.bak -e 's/^hw.audioInput=.*/hw.audioInput=yes/' -e 's/^hw.ramSize=.*/hw.ramSize=4096/' "$config"
grep -q '^hw.audioInput=' "$config" || echo 'hw.audioInput=yes' >> "$config"
echo "created AVD $EXO_AVD ($image)"
