#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/env.sh"
mkdir -p "$EXO_STATE"
if "$ANDROID_HOME/platform-tools/adb" -s "$EXO_SERIAL" get-state >/dev/null 2>&1; then
  echo "$EXO_SERIAL already running"
  exit 0
fi
nohup "$ANDROID_HOME/emulator/emulator" -avd "$EXO_AVD" -port "$EXO_EMULATOR_PORT" \
  -no-snapshot -no-boot-anim -allow-host-audio ${EXO_EMULATOR_ARGS:-} \
  > "$EXO_STATE/emulator-$EXO_AVD.log" 2>&1 < /dev/null &
disown
"$ANDROID_HOME/platform-tools/adb" -s "$EXO_SERIAL" wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
echo "emulator booted ($EXO_SERIAL)"
