#!/usr/bin/env bash
# speech-sample.sh <out.wav> [text]: a deterministic speech clip for smoke tests (espeak-ng).
set -euo pipefail
out=${1:?usage: speech-sample.sh <out.wav> [text]}
espeak-ng -w "$out" "${2:-This is an Exo voice note. Testing the microphone on Android. One two three.}"
