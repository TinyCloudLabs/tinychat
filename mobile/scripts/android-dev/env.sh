# Shared settings for the Android dev/smoke harness. Sourced by the other scripts; every value can be
# overridden from the environment.
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}
export EXO_AVD=${EXO_AVD:-exo}                       # AVD name (see create-avd.sh)
export EXO_EMULATOR_PORT=${EXO_EMULATOR_PORT:-5554}  # console port; adb serial is emulator-<port>
export EXO_SERIAL=emulator-$EXO_EMULATOR_PORT
# The WebView must load http://localhost:5186 (an allowed backend CORS origin); adb reverse maps the
# device's 5186 to whatever free host port the Vite dev server runs on.
export EXO_VITE_PORT=${EXO_VITE_PORT:-5391}
export EXO_DEVTOOLS_PORT=${EXO_DEVTOOLS_PORT:-9333}  # host port forwarded to the WebView DevTools socket
export EXO_STATE=${EXO_STATE:-/tmp/exo-android-dev}  # controller command/result files, logs
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export PULSE_SERVER=${PULSE_SERVER:-unix:$XDG_RUNTIME_DIR/pulse/native}
ADB="$ANDROID_HOME/platform-tools/adb -s $EXO_SERIAL"
