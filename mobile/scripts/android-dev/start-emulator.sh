#!/usr/bin/env bash
# Start one API-specific AVD, detached from this shell. Linux keeps the PulseAudio mic path.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"
mkdir -p "$EXO_STATE"
if "$ANDROID_HOME/platform-tools/adb" -s "$EXO_SERIAL" get-state >/dev/null 2>&1; then
  echo "$EXO_SERIAL already running"
  exit 0
fi

extra=()
if [[ -n "${EXO_EMULATOR_ARGS:-}" ]]; then read -r -a extra <<< "$EXO_EMULATOR_ARGS"; fi
emulator=("$ANDROID_HOME/emulator/emulator" -avd "$EXO_AVD" -port "$EXO_EMULATOR_PORT"
  -no-snapshot -no-boot-anim -allow-host-audio ${extra[@]+"${extra[@]}"})
if [[ "$(uname -s)" = Linux ]]; then
  "$here/pulse-setup.sh"
  launch=(env PULSE_SOURCE=vmic.monitor PULSE_SINK=emu_out QEMU_AUDIO_DRV=pa
    QT_QPA_PLATFORM=offscreen "PULSE_SERVER=$PULSE_SERVER" "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
    "${emulator[@]}" -qt-hide-window -gpu swiftshader_indirect)
  if ! id -nG | grep -qw kvm; then
    printf -v quoted '%q ' "${launch[@]}"
    launch=(sg kvm -c "$quoted")
  fi
else
  launch=("${emulator[@]}")
fi

python3 - "$EXO_STATE/emulator-$EXO_AVD.log" "${launch[@]}" <<'PY'
import subprocess
import sys

with open(sys.argv[1], "ab", buffering=0) as log:
    subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                     start_new_session=True, close_fds=True)
PY

for ((attempt = 0; attempt < 150; attempt++)); do
  if [[ "$("$ANDROID_HOME/platform-tools/adb" -s "$EXO_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]]; then
    echo "emulator booted ($EXO_SERIAL)"
    exit 0
  fi
  sleep 2
done
echo "emulator failed to boot ($EXO_SERIAL); see $EXO_STATE/emulator-$EXO_AVD.log" >&2
exit 1
