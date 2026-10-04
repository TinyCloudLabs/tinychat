#!/usr/bin/env bash
# inject-audio.sh <audio-file>: play a clip into the emulator's microphone; blocks until delivered.
#   file -> ffmpeg (44.1k s16 stereo, gain) -> paplay -> sink "vmic" -> vmic.monitor -> guest MIC.
# GAIN_DB (default -6): qemu opens the mic as 2ch and a MONO recording sums L+R (+6 dB), so -6 keeps a
# mono recording at the clip's level. TAIL_S (default 0.5): trailing silence so latency drains.
# The mic is live: start recording in the app BEFORE injecting, or the audio is lost.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"
in=${1:?usage: inject-audio.sh <audio-file>}
GAIN_DB=${GAIN_DB:--6}; TAIL_S=${TAIL_S:-0.5}
"$here/pulse-setup.sh"
pactl list source-outputs 2>/dev/null | grep -q 'application.name = "qemu-system' \
  || echo "inject-audio.sh: warning: no qemu capture stream; was the emulator started with start-emulator.sh?" >&2
tmp=$(mktemp --suffix=.wav); trap 'rm -f "$tmp"' EXIT
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$in" \
  -af "aformat=channel_layouts=mono,pan=stereo|c0=c0|c1=c0,volume=${GAIN_DB}dB,apad=pad_dur=${TAIL_S}" \
  -ar 44100 -ac 2 -c:a pcm_s16le "$tmp"
paplay -d vmic "$tmp"
