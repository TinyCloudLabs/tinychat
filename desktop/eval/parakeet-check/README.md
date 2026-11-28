# Parakeet check (outside the app)

This program transcribes one recording with Parakeet TDT v3, the way TinyCloud One's Parakeet option does:

- Each channel on its own. In a stereo recording, channel 0 is Me (the microphone) and channel 1 is Them (this Mac's audio).
- Windows of 29.5 s, with no overlap. A window shorter than 20 s is padded with zeros to 20 s.
- A microphone window with an RMS below 0.0008 is skipped (stereo only).
- Language hint `en`.

It prints the text and the time of each window, the model load time, and the real-time factor
(transcription time divided by the recording length; below 1 is faster than real time).

It uses only `ParakeetASR` and `AudioCommon` from speech-swift at commit `335a68c` (0.0.22), the commit that the
app's Soniqo bridge uses. These run on Core ML. They do not use MLX, so the build needs no Metal compiler and no full Xcode.

## Needs

- A Mac with Apple Silicon and macOS 15 or newer (speech-swift declares macOS 15).
- The Command Line Tools. Check with `swift --version`. If it is missing, run `xcode-select --install`.
- A network connection for the first build and the first run.

## Commands

```sh
shasum -a 256 -c parakeet-check.tgz.sha256
tar xzf parakeet-check.tgz
cd parakeet-check
swift build -c release
.build/release/parakeet-check /path/to/recording.wav
```

The file can be WAV, MP3 or M4A. An optional second argument sets the language hint (default `en`).

Suggested runs: three real meetings, one recording of silence, and some clips shorter than 3 s.

If `swift build` stops with a package resolution error, delete `Package.resolved` and run `swift build -c release` again.

## What it downloads

1. **Build:** Swift packages from `github.com`, at the versions in `Package.resolved` (the app's own pins), into
   `.build/`. Only `AudioCommon`, `ParakeetASR` and the `Hub` module of swift-transformers (with its dependencies)
   are compiled.
2. **First run:** the model from `huggingface.co`. Hugging Face redirects each file to its download network
   (`us.aws.cdn.hf.co` on 2026-11-20; the host can change by region).
   - Repository: `aufklarer/Parakeet-TDT-v3-CoreML-INT8-30s`, branch `main`.
   - Files: `config.json`, `vocab.json`, and `encoder.mlmodelc/`, `decoder.mlmodelc/`, `joint.mlmodelc/`
     (each: `model.mil`, `coremldata.bin`, `analytics/coremldata.bin`, `weights/weight.bin`).
   - Size: 640,656,886 bytes (the encoder weights are 602,637,376 bytes).
   - Folder: `~/Library/Caches/qwen3-speech/models/aufklarer/Parakeet-TDT-v3-CoreML-INT8-30s/`.
     `QWEN3_CACHE_DIR` moves the `qwen3-speech` folder. `HF_ENDPOINT` sets another host.

Later runs use the files in that folder and do not download again.

The app uses the same folder, so it uses these files too. Before the app shows Parakeet as downloaded, it also needs
the speaker-diarization bundle `aufklarer/Pyannote-Community-1-CoreML` (33,699,183 bytes) in
`~/Library/Caches/qwen3-speech/models/aufklarer/Pyannote-Community-1-CoreML/`. This check does not download it.

To remove the model: `rm -rf ~/Library/Caches/qwen3-speech/models/aufklarer/Parakeet-TDT-v3-CoreML-INT8-30s`.
This also removes it for the app.

## Differences from the app

- The app resamples to 16 kHz in Rust. This check uses `AVAudioConverter`.
- The app also loads the diarization model when it loads Parakeet, so its first load takes longer.
- The app writes each window to a temporary WAV file first. The audio is the same.
