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

From the app bridge in `chrome://inspect`, call `OnDeviceStt.benchmark({dir: "files/stt-bench", threads: [2, 4], blankPenalty: 0.5, padSeconds: 0.5, clusterThreshold: 0.8})`. The options are explicit diagnostics: `blankPenalty` accepts 0–2, leading and trailing `padSeconds` accepts 0–1, and clustering accepts 0.5–1.5. A fresh process gives the first four-thread load its best chance of being cold. `asrOnly: true` skips diarization for a focused sweep; it cannot produce a DER gate result. The call runs off the bridge thread and writes each fixture's `.hyp.txt`, `.words.json`, `.rttm`, and `.metrics.json` under `files/stt-bench/results/android/`. Four-thread files use the fixture basename; two-thread files have a `-t2` suffix.

```sh
adb -s "$S" exec-out run-as xyz.tinycloud.exo tar c files/stt-bench/results | tar x -C /tmp
python3 mobile/scripts/stt-fixtures/wer.py "$HOME/.cache/exo-stt-fixtures/ls-1089-10m.ref.txt" /tmp/files/stt-bench/results/android/ls-1089-10m.hyp.txt
python3 mobile/scripts/stt-fixtures/wer.py "$HOME/.cache/exo-stt-fixtures/ami-es2004a-10m.words.json" /tmp/files/stt-bench/results/android/ami-es2004a-10m.hyp.txt
python3 mobile/scripts/stt-fixtures/wer.py "$HOME/.cache/exo-stt-fixtures/ls-alt-2spk-10m.ref.json" /tmp/files/stt-bench/results/android/ls-alt-2spk-10m.hyp.txt
python3 mobile/scripts/stt-fixtures/score.py --rttm "$HOME/.cache/exo-stt-fixtures/ami-es2004a-10m.rttm" --hyp /tmp/files/stt-bench/results/android/ami-es2004a-10m.rttm --words "$HOME/.cache/exo-stt-fixtures/ami-es2004a-10m.words.json" --hyp-words /tmp/files/stt-bench/results/android/ami-es2004a-10m.words.json
```

The benchmark uses 16 kHz mono PCM16, Silero VAD with a 25-second soft segment cap, Parakeet TDT 0.6B v3 int8 with greedy search, and 60-second pyannote/CAM++ diarization windows. `blankPenalty` and padding are configurable because T7 found whole-utterance blank collapse on continuous speech with v3 int8 greedy decoding at penalty 0. Padding shifts word times back into the original fixture timeline. The 0.8 clustering threshold is provisional; T30 must tune on a separate meeting and hold ES2004a out.

## Stop/go record

All three WERs must be reported. LibriSpeech alone cannot establish an ASR go: T7's unmodified v3 int8 greedy run scored 2.02% on LibriSpeech, 28.73% on AMI, and 65.08% on alternation. The Android benchmark accepts penalty and padding settings for a sweep to determine whether the continuous-speech failures recover without increasing insertions. Raw RTTM uses window-qualified speaker IDs, so global DER is a diagnostic; T7's `score.py` also reports per-window oracles.

The Moto remains **PENDING** because it is unavailable. No device values are claimed for the plan's gates: arm64 APK/AAB growth ≤40 MB, load ≤15 s, RTF ≤0.5, peak `VmHWM` ≤1.6 GB, all-fixture WER (LibriSpeech ≤4% plus continuous-speech evidence), AMI DER ≤30%, diarization extra RSS ≤400 MB, and each 60-second window ≤5 s. The metrics include `VmHWM`, RSS sampled every 10 ms during diarization, window times, VAD coverage, empty VAD segments, and WER for each fixture. RSS depends on allocator reuse; run AMI alone in a fresh process before judging the extra-footprint gate. Timing on this overloaded Mac or an emulator is diagnostic only. T17/T24 own production model download and the checkpointed transcription queue.
