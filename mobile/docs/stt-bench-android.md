# Android on-device STT spike (TC-786)

The Android app pins sherpa-onnx 1.13.8's static ONNX Runtime AAR. Gradle downloads it from the [v1.13.8 release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8), checks SHA-256 `b22c3fc1b6a45666d28892bb2f7694beeb77a8362d7ebd77c1a5431ec9435471`, and refuses a mismatch. The AAR includes the Kotlin API classes. The app bundles no models. `OnDeviceStt.status()` reports `engine: "none"` until T17/T24 add the model manager and queue. The benchmark method is available in Debug builds only.

## Fixtures and invocation

Use T7's `mobile/scripts/stt-fixtures/fetch.sh` and `mobile/stt-fixtures.lock` from `origin/feat/tc-786-ios-sherpa-spike` until that branch merges. Run `bash mobile/scripts/stt-fixtures/fetch.sh` after it merges; it verifies every fixture and model hash. The three WAVs are LibriSpeech speaker 1089, AMI ES2004a cropped to 300–900 seconds with shifted annotations, and synthetic LibriSpeech two-speaker alternation. LibriSpeech and AMI material is CC BY 4.0. Weights and audio remain outside git.

On an emulator or the Moto (when available), use an explicit serial `S`:

```sh
adb -s "$S" push "$HOME/.cache/exo-stt-fixtures/." /data/local/tmp/stt-bench/
adb -s "$S" shell run-as xyz.tinycloud.exo mkdir -p files/stt-bench
adb -s "$S" shell run-as xyz.tinycloud.exo cp -r /data/local/tmp/stt-bench/. files/stt-bench/
```

From the app bridge in `chrome://inspect`, call `OnDeviceStt.benchmark({dir: "files/stt-bench", threads: [2, 4], blankPenalty: 1.0, padSeconds: 0, clusterThreshold: 0.8})`. The options are explicit diagnostics: `blankPenalty` accepts 0–2, leading and trailing `padSeconds` accepts 0–1, and clustering accepts 0.5–1.5. `only` optionally selects one of `ls-1089-10m`, `ami-es2004a-10m`, or `ls-alt-2spk-10m`. `asrOnly: true` skips diarization for a focused sweep; it cannot produce a DER gate result. A dedicated serial benchmark thread keeps other plugin calls responsive. Calls are queued on that thread. Each call returns a `runId` and `output` path and writes each fixture's `.hyp.txt`, `.words.json`, `.rttm`, and `.metrics.json` under `files/stt-bench/results/android/<runId>/`. Calls never overwrite previous results. Four-thread files use the fixture basename; two-thread files have a `-t2` suffix.

For the extra-RSS gate, start a fresh app process and make the **first** benchmark call `OnDeviceStt.benchmark({dir: "files/stt-bench", threads: [4], only: "ami-es2004a-10m"})`. This measures diarization after only the AMI recognizer lifetime. Check that its metrics say `coldLoad: true`; `coldLoadSeconds` is populated only for the first successful recognizer construction in a process. Later `loadSeconds` values are warm and cannot satisfy the cold-load gate. Use a separate fresh process for other cold settings.

```sh
adb -s "$S" exec-out run-as xyz.tinycloud.exo tar c files/stt-bench/results | tar x -C /tmp
RUN_ID='<runId returned by the call>'
RESULTS="/tmp/files/stt-bench/results/android/$RUN_ID"
python3 mobile/scripts/stt-fixtures/wer.py "$HOME/.cache/exo-stt-fixtures/ls-1089-10m.ref.txt" "$RESULTS/ls-1089-10m.hyp.txt"
python3 mobile/scripts/stt-fixtures/wer.py "$HOME/.cache/exo-stt-fixtures/ami-es2004a-10m.words.json" "$RESULTS/ami-es2004a-10m.hyp.txt"
python3 mobile/scripts/stt-fixtures/wer.py "$HOME/.cache/exo-stt-fixtures/ls-alt-2spk-10m.ref.json" "$RESULTS/ls-alt-2spk-10m.hyp.txt"
python3 mobile/scripts/stt-fixtures/score.py --rttm "$HOME/.cache/exo-stt-fixtures/ami-es2004a-10m.rttm" --hyp "$RESULTS/ami-es2004a-10m.rttm" --words "$HOME/.cache/exo-stt-fixtures/ami-es2004a-10m.words.json" --hyp-words "$RESULTS/ami-es2004a-10m.words.json"
python3 mobile/scripts/stt-fixtures/score.py --rttm "$HOME/.cache/exo-stt-fixtures/ls-alt-2spk-10m.rttm" --hyp "$RESULTS/ls-alt-2spk-10m.rttm" --words "$HOME/.cache/exo-stt-fixtures/ls-alt-2spk-10m.ref.json" --hyp-words "$RESULTS/ls-alt-2spk-10m.words.json" --attribution-mode single-speaker-region
```

The benchmark uses 16 kHz mono PCM16, Silero VAD with a 25-second soft segment cap, Parakeet TDT 0.6B v3 int8 with greedy search, and 60-second pyannote/CAM++ diarization windows. `blankPenalty` and padding are configurable because T7 found whole-utterance blank collapse on continuous speech with v3 int8 greedy decoding at penalty 0. Padding shifts word times back into the original fixture timeline. The 0.8 clustering threshold is provisional; T30 must tune on a separate meeting and hold ES2004a out.

## Stop/go record

All three WERs must be reported. LibriSpeech alone cannot establish an ASR go: T7's unmodified v3 int8 greedy run scored 2.02% on LibriSpeech, 28.73% on AMI, and 65.08% on alternation. The Android benchmark accepts penalty and padding settings for a sweep to determine whether the continuous-speech failures recover without increasing insertions. Raw RTTM uses window-qualified speaker IDs, so global DER is a diagnostic; T7's `score.py` also reports per-window oracles.

The G1 Moto run missed several gates (details below). A fixed build still needs a Moto run for load ≤15 s, RTF ≤0.5, peak `VmHWM` ≤1.6 GB, all-fixture WER (LibriSpeech ≤4% plus continuous-speech evidence), AMI DER ≤30%, diarization extra RSS ≤400 MB, and each 60-second window ≤5 s. `loadSeconds` times recognizer construction alone; `vadCreationSeconds` is separate. `decodeSeconds` and RTF include VAD processing plus ASR decoding. The metrics include `VmHWM`, RSS sampled every 10 ms during diarization, cluster counts and time per window, VAD coverage, per-segment start/end/decoded word count/RMS, `emptyNonSilentVadSegments` (RMS > 0.0001), and WER. RSS depends on allocator reuse; use the focused AMI call above in a fresh process before judging the extra-footprint gate. Timing on this overloaded Mac or an emulator is diagnostic only. T17/T24 own production model download and the checkpointed transcription queue.

## TC-853 Android parity investigation

The G1 Moto build fed Silero VAD 8,000 samples in each `acceptWaveform` call. Sherpa 1.13.8 reduces all 512-sample windows in one call to a single speech decision. Short pauses inside that half-second block could not end a segment. The Moto's LibriSpeech output had 21 VAD segments covering 445.724 s, including a 48.064 s segment; the Mac output had 79 covering 399.804 s, with a 14.676 s maximum. Both used the pinned int8 encoder, decoder and joiner, 16 kHz mono PCM16 fixtures, greedy search and penalty 1.0. Android now feeds exactly one 512-sample Silero window per call and pins the 16 kHz/80-bin/zero-dither feature settings.

For a direct token comparison, Android's diagnostic `vadSegments` now includes the decoded BPE `tokens` for each cut. Reproduce the Mac side with:

```sh
uv run --no-project --python 3.11 --with 'sherpa-onnx==1.13.8' --with numpy \
  python mobile/scripts/stt-fixtures/decode_segments.py \
  "$HOME/.cache/exo-stt-fixtures/ls-1089-10m.wav" \
  '<Mac ls-1089-10m.metrics.json>' \
  "$HOME/.cache/exo-stt-fixtures/models/full" python-ls-tokens.json \
  --threads 4 --blank-penalty 1.0
python mobile/scripts/stt-fixtures/diff_tokens.py python-ls-tokens.json \
  '<Android ls-1089-10m.metrics.json>'
```

Python 1.13.8 on the Mac decoded the 79 saved cuts into 2,262 tokens and scored 2.0202% LibriSpeech WER (24/1,188), with the same normalized hypothesis as the Swift benchmark. On the Moto's saved **21** cut points, the same Python decoder scored **6.5657%** (78/1,188), against the Moto's **6.3973%** (76/1,188). Their normalized hypotheses differ in only three short word spans: `even` omitted, `slow`/`slowly`, and `luster`/`lustre`. This isolates almost the entire accuracy gap to VAD segmentation.

The fixed debug APK ran the same LibriSpeech fixture on an arm64 Android 34 emulator with four threads, penalty 1.0 and no padding. It produced **79 identical VAD cuts** (399.804 s), **2,262 tokens**, and **1.9360% WER** (23/1,188). The token diff found one differing cut out of 79: at 290.716–294.928 s, Python decoded `barracks,` and Android decoded `barrack,` (`rac`/`ks` versus `ra`/`ck` BPE tokens); every other token and cut matched. The emulator's cold recognizer load was 14.692 s, VAD processing 17.602 s, decode plus VAD 106.488 s for 459.470 s of audio (RTF 0.232), and peak process `VmHWM` 1.205 GB. These emulator timings and memory numbers are diagnostic; only a fixed-build Moto run can re-evaluate the device gates. The exact outputs are in `/tmp/exo-capture/evidence/TC-853/report.md`.

The Moto's 86.29% AMI DER is separate from the ASR VAD issue: diarization processes the original audio and gives every 60-second window distinct speaker IDs. The Mac at threshold 0.8 scores 86.21% **raw global DER** and 30.00% with a reference-aided many-to-one per-window oracle; the Moto scores 86.29% and 29.98% by the same measures. The ~30% oracle does not meet the global DER gate. T30 needs global linking of speaker embeddings across windows before this gate can pass.

G1 performance on the Moto with the full 0.6B pack missed the load, RTF and memory gates: first load 18.755 s, AMI RTF 1.115 (four threads), peak `VmHWM` 1.805 GB, and slowest diarization window 178.16 s. Two threads improved LibriSpeech RTF from 1.308 to 0.797 in the same run, still above the 0.5 gate. The next device sweep should benchmark the 110M int8 pack on slow phones (130 MB of model files, versus 639 MB for the full pack) and cap full-pack threads at two there. The 110M Mac result (2.53% LibriSpeech, 28.13% AMI at penalty 1.0) is an accuracy tradeoff and requires validation on Android. For handoff latency, evaluate bounded ASR chunks of at most 25 s with shared context and shorter overlapping diarization windows, measuring WER and DER again: the Mac's 15 s diagnostic split worsened WER, so a speed-only change cannot ship unchecked. Keep the full pack opt-in or warn on devices that fail the timing and memory gates.
