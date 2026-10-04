#!/usr/bin/env bash
# Idempotently prepare the host PulseAudio graph for the emulator mic:
#   vmic     null sink; anything played into it shows up on vmic.monitor, the emulator's microphone.
#   emu_out  null sink that swallows the emulator's speaker, so guest playback can't loop into the mic.
set -euo pipefail
. "$(dirname "$0")/env.sh"
if ! pactl info >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1 --daemonize=yes
  for _ in $(seq 1 20); do pactl info >/dev/null 2>&1 && break; sleep 0.25; done
fi
have_sink() { pactl list short sinks | awk '{print $2}' | grep -qx "$1"; }
have_sink vmic    || pactl load-module module-null-sink sink_name=vmic    sink_properties=device.description=VirtualMic >/dev/null
have_sink emu_out || pactl load-module module-null-sink sink_name=emu_out sink_properties=device.description=EmulatorSpeaker >/dev/null
