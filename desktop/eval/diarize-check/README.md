# Diarize check (outside the app)

This program splits one channel of a recording into speakers with pyannote Community-1 on Core ML. It answers one
question before the app does it: can the Mac tell the people on the other side of a call apart (channel 1, "Them")?

It prints only times, speaker numbers, counts, stage times and memory. It prints no text, no names and no file name,
so you can share its output.

## How it works

- It reads one channel of the file and converts it to 16 kHz.
- It runs the Community-1 diarizer on the whole file (`--window 0`), or in windows of N seconds (default 600). A last
  piece shorter than 60 s goes into the window before it.
- With windows, it then joins the speakers of all windows. It takes the closest pair of voice summaries first (the
  cosine distance between the speakers' centroids), and joins while the distance is below the threshold
  (`--join`, default 0.50). It never joins two speakers of the same window. With `--max N`, it goes on joining past the
  threshold until at most N speakers are left. The `stage join` line shows the threshold, the largest distance it
  joined and the closest pair it kept apart. Use these numbers to choose a better threshold.
- Speakers are numbered 1, 2, … in order of first speech.

## Needs

- A Mac with Apple Silicon and macOS 15 or newer (speech-swift declares macOS 15).
- The Command Line Tools. Check with `swift --version`. If it is missing, run `xcode-select --install`.
- A network connection for the first build and the first run.

## Commands

```sh
shasum -a 256 -c diarize-check.tgz.sha256
tar xzf diarize-check.tgz
cd diarize-check
swift build -c release
.build/release/diarize-check /path/to/recording.mp3 --channel 1 --limit 600
```

Options:

| Option | Meaning |
|---|---|
| `--channel 0\|1` | Required. 0 is Me (the microphone), 1 is Them (this Mac's audio). |
| `--max N` | At most N speakers (in each window, and in total after joining). |
| `--min N` | At least N speakers in each window (default 1). Use it only with `--window 0`. |
| `--window SECONDS` | Window length (default 600). `0` runs the whole file at once. |
| `--units cpu\|ane\|all` | Core ML compute units (default `cpu`, as the app's Soniqo bridge uses). `ane` is CPU and Neural Engine. |
| `--limit SECONDS` | Use only the first N seconds. |
| `--join DISTANCE` | Joining threshold, a cosine distance from 0 to 2 (default 0.50). |

**Formats:** the file is read with `AVAudioFile`, so WAV, MP3, M4A and AIFF work, mono or stereo, at any sample rate.
The app's recordings (`audio.mp3`, `audio.wav`) work as they are. If a file does not open, convert it to a 16 kHz WAV
with both channels:

```sh
afconvert -f WAVE -d LEI16@16000 recording.mp3 recording-16k.wav
```

## Suggested runs on a long stereo call

```sh
B=.build/release/diarize-check
F=/path/to/recording.mp3
$B "$F" --channel 1 --limit 600                 # 1. quick: the first 10 minutes
$B "$F" --channel 1                             # 2. the whole call, 10-minute windows
$B "$F" --channel 1 --max 2                     # 3. at most two speakers
$B "$F" --channel 1 --units ane                 # 4. the Neural Engine; compare times and turns with run 2
$B "$F" --channel 1 --window 0 --limit 1800     # 5. one window of 30 minutes: memory without windows
```

Run 5 shows how memory grows without windows. Try the whole call with `--window 0` only if run 5 stays well under
your free memory. Then listen to about five turns of each speaker at the printed times.

The environment variable `SPEECH_COREML_COMPUTE_UNITS` overrides `--units`; the program says so when it is set.

## What it downloads

1. **Build:** Swift packages from `github.com`, at the versions in `Package.resolved` (the app's own pins), into
   `.build/`. Only speech-swift's `AudioCommon` module and the `Hub` module of swift-transformers (with its
   dependencies) are compiled. mlx-swift is not used.
2. **First run:** the model `aufklarer/Pyannote-Community-1-CoreML` (branch `main`) from `huggingface.co`, which
   redirects each file to its download network (`us.aws.cdn.hf.co` on 2026-11-20; the host can change by region).
   - Files: `config.json`, `plda.safetensors`, `segmentation.mlmodelc/`, `embedding.mlmodelc/`.
   - Size: 33,699,183 bytes.
   - Folder: `~/Library/Caches/qwen3-speech/models/aufklarer/Pyannote-Community-1-CoreML/`. The app's Parakeet option
     uses the same folder. `QWEN3_CACHE_DIR` moves the `qwen3-speech` folder.
   - The model is pyannote's speaker-diarization-community-1, licensed CC BY 4.0.

Later runs use the files in that folder and do not download again.

## Where the code comes from

`Sources/Community1/` holds five files copied unchanged from soniqo/speech-swift at commit
`335a68c0db92564527881962ff11eb686863d2b8`, `Sources/SpeechVAD/`: `Community1DiarizationPipeline.swift`,
`Community1Configuration.swift`, `Community1Clustering.swift`, `Community1CoreML.swift` and `DiarizationHelpers.swift`.
`DiarizationResult.swift` is the result type from `DiarizationPipeline.swift` (lines 41-57); the rest of that file uses
MLX. The upstream files have no licence header of their own; each copy starts with a note of its source, and the
package licence (Apache 2.0) is in `LICENSE-speech-swift`. Depending on speech-swift's `SpeechVAD` product instead
would build mlx-swift, which needs the Metal compiler and full Xcode.
