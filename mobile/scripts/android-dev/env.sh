# Source from the Android development scripts. Values may be overridden by callers.
case "$(uname -s)" in
  Darwin) export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk} ;;
  *) export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk} ;;
esac
export SDKMANAGER=${SDKMANAGER:-$(command -v sdkmanager || printf '%s' "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager")}
export AVDMANAGER=${AVDMANAGER:-$(command -v avdmanager || printf '%s' "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager")}
export EXO_AVD_API=${EXO_AVD_API:-34}
export EXO_AVD=${EXO_AVD:-exo-api$EXO_AVD_API}
export EXO_EMULATOR_PORT=${EXO_EMULATOR_PORT:-$((5554 + 2 * (EXO_AVD_API - 24)))}
export EXO_SERIAL=emulator-$EXO_EMULATOR_PORT
case "$(uname -m)" in
  arm64|aarch64) export EXO_ABI=arm64-v8a ;;
  x86_64) export EXO_ABI=x86_64 ;;
  *) echo "Unsupported emulator host ABI: $(uname -m)" >&2; return 1 2>/dev/null || exit 1 ;;
esac
export EXO_VITE_PORT=${EXO_VITE_PORT:-5391}
export EXO_DEVTOOLS_PORT=${EXO_DEVTOOLS_PORT:-9333}
export EXO_STATE=${EXO_STATE:-/tmp/exo-android-dev}
if [ "$(uname -s)" = Linux ]; then
  export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
  export PULSE_SERVER=${PULSE_SERVER:-unix:$XDG_RUNTIME_DIR/pulse/native}
fi
ADB="$ANDROID_HOME/platform-tools/adb -s $EXO_SERIAL"
