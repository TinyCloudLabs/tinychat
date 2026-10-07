#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
mobile_dir=$(cd "$script_dir/../.." && pwd)
cache_dir=${EXO_STT_FIXTURE_CACHE:-$HOME/.cache/exo-stt-fixtures}
downloads=$cache_dir/downloads
mkdir -p "$downloads" "$cache_dir/models/full" "$cache_dir/models/small" "$cache_dir/models/diarization"

pin=false
fixtures_only=false
for arg in "$@"; do
  case "$arg" in
    --pin) pin=true ;;
    --fixtures-only) fixtures_only=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

download() {
  local url=$1 destination=$2
  if [[ ! -s "$destination" ]]; then
    echo "fetching ${destination#$cache_dir/}" >&2
    curl -fLsS --retry 3 --retry-delay 3 "$url" -o "$destination.part"
    mv "$destination.part" "$destination"
  fi
}

download 'https://www.openslr.org/resources/12/test-clean.tar.gz' "$downloads/test-clean.tar.gz"
download 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2004a/audio/ES2004a.Mix-Headset.wav' "$downloads/ES2004a.Mix-Headset.wav"
download 'https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip' "$downloads/ami_public_manual_1.6.2.zip"
download 'https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/main/only_words/rttms/test/ES2004a.rttm' "$downloads/ES2004a.rttm"

if [[ ! -d "$downloads/LibriSpeech/test-clean/1089" ]]; then
  tar -xzf "$downloads/test-clean.tar.gz" -C "$downloads" LibriSpeech/test-clean/1089 LibriSpeech/test-clean/121
fi
python3 "$script_dir/make_alternation.py" "$downloads" "$cache_dir"
ffmpeg -hide_banner -loglevel error -y -ss 300 -t 600 -i "$downloads/ES2004a.Mix-Headset.wav" \
  -ar 16000 -ac 1 -c:a pcm_s16le "$cache_dir/ami-es2004a-10m.wav"
python3 "$script_dir/prepare_ami.py" "$downloads/ES2004a.rttm" "$downloads/ami_public_manual_1.6.2.zip" "$cache_dir"

if [[ "$fixtures_only" == false ]]; then
  full='https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78'
  for file in encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt; do
    download "$full/$file" "$cache_dir/models/full/$file"
  done
  download 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2' "$downloads/small.tar.bz2"
  for file in encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt; do
    [[ -s "$cache_dir/models/small/$file" ]] && continue
    path=$(tar -tf "$downloads/small.tar.bz2" | rg "/$file$" | head -1)
    [[ -n "$path" ]] || { echo "small pack missing $file" >&2; exit 1; }
    tar -xOf "$downloads/small.tar.bz2" "$path" > "$cache_dir/models/small/$file.part"
    mv "$cache_dir/models/small/$file.part" "$cache_dir/models/small/$file"
  done
  download 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx' "$cache_dir/models/silero_vad.onnx"
  download 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2' "$downloads/diarization.tar.bz2"
  if [[ ! -s "$cache_dir/models/diarization/model.int8.onnx" ]]; then
    path=$(tar -tf "$downloads/diarization.tar.bz2" | rg '/model.int8.onnx$' | head -1)
    [[ -n "$path" ]] || { echo 'diarization pack missing model.int8.onnx' >&2; exit 1; }
    tar -xOf "$downloads/diarization.tar.bz2" "$path" > "$cache_dir/models/diarization/model.int8.onnx.part"
    mv "$cache_dir/models/diarization/model.int8.onnx.part" "$cache_dir/models/diarization/model.int8.onnx"
  fi
  download 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx' "$cache_dir/models/diarization/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"
fi

python3 - "$cache_dir" "$mobile_dir/stt-fixtures.lock" "$pin" "$fixtures_only" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root, lock_path = Path(sys.argv[1]), Path(sys.argv[2])
pin, fixtures_only = sys.argv[3] == 'true', sys.argv[4] == 'true'
paths = sorted(path for path in root.glob('*.wav'))
paths += sorted(root.glob('*.rttm')) + sorted(root.glob('*.json')) + sorted(root.glob('*.txt'))
if not fixtures_only:
    paths += sorted(path for path in (root / 'models').rglob('*') if path.is_file())
records = {}
for path in paths:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    records[str(path.relative_to(root))] = {'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}
if pin:
    if fixtures_only:
        raise SystemExit('--pin requires all models')
    lock_path.write_text(json.dumps({'version': 1, 'amiCropSeconds': [300, 900],
                                     'libriSpeechUtterances': 60, 'alternationSeed': 781,
                                     'files': records}, indent=2, sort_keys=True) + '\n')
    print(f'pinned {len(records)} files in {lock_path}')
else:
    if not lock_path.exists():
        raise SystemExit(f'missing lock {lock_path}; run fetch.sh --pin once')
    expected = json.loads(lock_path.read_text())['files']
    for name, record in records.items():
        if name not in expected or expected[name] != record:
            raise SystemExit(f'fixture lock mismatch: {name}')
    if not fixtures_only and set(expected) != set(records):
        raise SystemExit(f'fixture lock file set mismatch: {sorted(set(expected) ^ set(records))}')
    print(f'verified {len(records)} pinned files')
PY
