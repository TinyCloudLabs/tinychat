#!/usr/bin/env bash
# (Re)launch Exo on the emulator against the host's Vite dev server and forward the WebView DevTools.
# Build/install first:  cd mobile && EXO_DEV_SERVER_URL=http://localhost:5186 bunx cap sync android \
#   && (cd android && ./gradlew assembleDebug) && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail
. "$(dirname "$0")/env.sh"
$ADB wait-for-device
until [ "$($ADB shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done
$ADB reverse tcp:5186 tcp:"$EXO_VITE_PORT" >/dev/null
$ADB shell am force-stop xyz.tinycloud.exo
$ADB shell am start -n xyz.tinycloud.exo/.MainActivity >/dev/null
socket=""
for _ in $(seq 1 30); do
  socket=$($ADB shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1 || true)
  [ -n "$socket" ] && break; sleep 1
done
[ -n "$socket" ] || { echo "launch-app.sh: no WebView DevTools socket (debug build?)" >&2; exit 1; }
$ADB forward tcp:"$EXO_DEVTOOLS_PORT" localabstract:"$socket" >/dev/null
echo "app launched; DevTools on 127.0.0.1:$EXO_DEVTOOLS_PORT"
