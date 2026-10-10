# iOS on-device STT spike (TC-786)

`ExoStt` pins [sherpa-onnx 1.13.8](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8). The app bundles the runtime and downloads no model as part of this spike. `OnDeviceStt.status()` reports `engine: "none"` until the model manager and transcription queue land in T13/T23. `EXO_STT_BENCH` enables the separate benchmark method; ordinary builds do not expose it.

## Reproduce the fixtures

Run `bash mobile/scripts/stt-fixtures/fetch.sh` from any working directory. The script writes to `~/.cache/exo-stt-fixtures/`, verifies sizes and SHA-256 hashes against `mobile/stt-fixtures.lock`, and fails if any file differs. Maintainers use `fetch.sh --pin` only when intentionally updating the committed lock. The lock covers the fixture WAV, RTTM, reference text/JSON and every model file in the full, small, VAD and diarization packs. `fetch.sh --fixtures-only` prepares audio and annotations while verifying those entries against an existing lock.

Sources are [LibriSpeech test-clean](https://www.openslr.org/12) (first 60 sorted utterances of speaker 1089; speaker 121 also feeds the two-person fixture) and [AMI ES2004a](https://groups.inf.ed.ac.uk/ami/corpus/) with [pyannote's word-only RTTM](https://github.com/pyannote/AMI-diarization-setup/tree/main/only_words/rttms/test). All audio and annotations are CC BY 4.0; the generated fixtures and model weights stay outside git. The synthetic alternation uses seed 781, complete 2–6 second utterances, and 0.3–0.8 second overlaps. Its reference text belongs to each original turn. The LibriSpeech filename has the plan's `10m` label; the specified first 60 utterances determine its actual duration.

AMI audio is cropped from 300 to 900 seconds. RTTM turns crossing an edge are clipped, and words crossing an edge are omitted. Both references are shifted by 300 seconds so their timestamps refer to the first sample of the cropped WAV. `score.py` refuses any reference or hypothesis time outside `[0, 600]`.

## Run the benchmark

1. Check that no other `devicectl device install` is running. Build the app for Vonnegut with `SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) EXO_STT_BENCH' CAPACITOR_DEBUG=true` and install over the existing app. `CAPACITOR_DEBUG=true` enables bridge inspection in this Release benchmark build. The iOS 27 simulator's Capacitor bridge is known to hang, so use an iOS 26 or iOS 18 simulator for simulator work.
2. Copy the three WAVs, their three references (`ls-1089-10m.ref.txt`, `ami-es2004a-10m.words.json`, `ls-alt-2spk-10m.ref.json`), and the files in `models/full`, `models/diarization`, and `models/silero_vad.onnx` to `Documents/stt-bench` in the app data container with `xcrun devicectl device copy to --device 00008140-0006645414D2801C --domain-type appDataContainer --domain-identifier xyz.tinycloud.exo.dev --source <prepared-directory> --destination Documents/stt-bench`. The references are needed to put all three WER readings in `metrics.json`; the small model is unnecessary.
3. From the bridge, call `OnDeviceStt.benchmark({dir: "Documents/stt-bench", threads: [4]})` after a fresh process launch, so the four-thread load is cold. Once T4's launch hook is merged, the benchmark build can also be launched with `DEVICECTL_CHILD_EXO_STT_BENCH=1 xcrun devicectl device process launch --device 00008140-0006645414D2801C xyz.tinycloud.exo.dev`; the bootstrap schedules the run at utility QoS and logs `EXO_STT_BENCH` with its summary or failure. Set `EXO_STT_BENCH_ONLY=ls-1089-10m` for a focused rerun. The 4-thread files use the fixture basename; optional 2-thread files have a `-t2` suffix. Results are in `Documents/stt-bench/results/ios/` and include `.hyp.txt`, `.words.json`, `.rttm`, and `.metrics.json` for every input.
4. Pull the results using `devicectl device copy from`. Run `python3 mobile/scripts/stt-fixtures/wer.py <reference.txt-or-json> <hyp.txt>` for **each** fixture and `python3 mobile/scripts/stt-fixtures/score.py --rttm <reference.rttm> --hyp <hyp.rttm> --words <reference.words.json> --hyp-words <hyp.words.json>` for diarization.

## ASR coverage and stop/go

The benchmark requests a 25-second `maxSpeechDuration` from pinned Silero VAD and uses 60-second diarization windows. Sherpa's setting is soft: AMI emitted a 29.760-second VAD segment and alternation a 27.424-second one. `EXO_STT_BENCH_HARD_SPLIT_SECONDS=15` is a diagnostic hard limit: it chooses the lowest-energy 20 ms frame near each boundary, gives adjacent windows 0.6 seconds of shared audio, then assigns each decoded word to one window by its midpoint. The default is `0` (no additional split), because the experiment below worsened WER. `EXO_STT_BENCH_BLANK_PENALTY` passes a penalty to sherpa's greedy decoder; `EXO_STT_BENCH_CHUNK_PAD_SECONDS` adds that many seconds of zeros to both ends of each ASR chunk and subtracts the pad from the word-time origin. Both default to `0`. Padding also **distorts** TDT word timestamps by roughly 0.3–0.5 s at chunk edges; subtracting the pad does not repair that drift, which would matter for diarization attribution. The word keep filter therefore applies only at shared hard-split boundaries, never at the outer edge of a VAD segment. Hard split and zero padding are diagnostics, both off by default; their combination has not been validated. `vadSegments` in each metrics file records `[start, end, decodedWords, rms, sourceMaxSampleDifference]`; `emptyVadSegments` counts VAD speech segments with no kept words. `asrWindows` records the original audio range, owned range, and decoded and kept word counts. `vadCoverageSeconds` reports the sum of VAD segment durations. Metrics also record `blankPenalty` and `chunkPadSeconds`.

Four-thread Mac WER, using the same pinned fixtures and references:

| ASR path | LibriSpeech | AMI ES2004a | Two-speaker alternation |
| --- | ---: | ---: | ---: |
| VAD, no hard split | 2.0202% (24/1188) | 28.7269% (528/1838) | 65.0809% (1327/2039) |
| VAD, hard split at 15 s | 2.0202% (24/1188) | 33.5147% (616/1838) | 67.1898% (1370/2039) |

LibriSpeech has natural pauses and its longest VAD segment is 14.676 seconds. On alternation, VAD covers 91.66% of reference speech time; on AMI, it covers 96.88% of annotated word midpoints. Every returned VAD sample matched the source WAV (`sourceMaxSampleDifference=0`). With **Parakeet v3 int8, greedy search, blank penalty 0 and no padding**, the unsplit recognizer returned no words for 18 of 74 alternation VAD segments, including a 4.34-second segment with nonzero speech energy; the split version returned no words for 19 segments. The same cut collapses in Python sherpa-onnx 1.13.8, while changing only the blank penalty recovers its words. This is a v3 int8 greedy blank-collapse failure, not evidence that VAD discarded the samples. A 15-second hard split is not a remedy: its mid-speech boundaries also remove leading context. The earlier fixed 25-second slicing pass scored 20.7912% LibriSpeech WER.

### T7b decode sweep (TC-819)

Four-thread Mac, ASR-only, pinned v3 int8 and the same VAD cuts on all three fixtures. Each cell is **WER / empty VAD speech segments**; denominators are 79 LibriSpeech, 63 AMI and 74 alternation. The 0/0 baseline ran first as a standalone invocation; the other seven settings then ran sequentially. After correcting the padding filter, the four padded settings were rerun sequentially. **This committed table is the result record**; local run logs and per-fixture outputs are under `/tmp/exo-capture/evidence/T7b/sweep/` and `sweep-fixed/` for review while that scratch directory exists.

| Blank penalty | Zero pad per end | LibriSpeech | AMI ES2004a | Two-speaker alternation |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 s | 2.02% / 0 | 28.73% / 5 | 65.08% / 18 |
| 0 | 0.5 s | 2.19% / 0 | 34.22% / 6 | 80.09% / 22 |
| 0.5 | 0 s | 2.02% / 0 | 25.84% / 0 | 58.21% / 6 |
| 0.5 | 0.5 s | 2.19% / 0 | 26.12% / 4 | 78.81% / 12 |
| 1.0 | 0 s | 2.02% / 0 | 23.39% / 0 | 52.67% / 2 |
| 1.0 | 0.5 s | 2.36% / 0 | 24.21% / 2 | 70.97% / 5 |
| 1.5 | 0 s | 1.94% / 0 | 22.31% / 0 | 47.72% / 0 |
| 1.5 | 0.5 s | 2.36% / 0 | 22.42% / 0 | 67.29% / 1 |

The first sweep's 8.33–8.50% padded LibriSpeech scores were invalid: the model decoded 1,181–1,182 words, but the old keep filter discarded about 75 at the VAD edges because padding distorted their timestamps. The corrected padded cells keep every decoded word. Padding is still a poor configuration for **continuous speech**: at penalty 0, alternation decoded words fall from 735 to 427, and AMI from 1,298 to 1,209 before filtering. The 1.0/0 setting improves both continuous fixtures and leaves no AMI segment blank, but two non-silent alternation segments of 6.74 s and 4.28 s remain entirely blank. Additional unpadded checks at 1.1, 1.2 and 1.3 scored 51.20%, 50.42% and 50.02% alternation WER, with 1, 1 and 0 empty segments.

Fabrication grows gradually with the penalty. This diagnostic flags a segment with at least two hypothesis words when at least half are absent from reference words within ±0.5 s; insertion counts are from minimum-edit WER alignment. These counts indicate where to inspect audio, not a complete hallucination metric.

| Unpadded penalty | 0 | 0.5 | 1.0 | 1.1 | 1.2 | 1.3 | 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Alternation flagged segments | 0 | 0 | 0 | 1 | 1 | 1 | 2 |
| AMI flagged segments | 0 | 1 | 1 | 1 | 1 | 0 | 0 |
| Alternation insertions | 0 | 5 | 2 | 3 | 6 | 8 | 12 |
| AMI insertions | 3 | 8 | 9 | 11 | 11 | 11 | 15 |
| Alternation “I'm not sure.” phrase insertions | 0 | 0 | 1 | 2 | 3 | 3 | 3 |

At penalties 0.5–1.2, one AMI cut gains the unsupported words “good thing.” At penalty 1.0, “and I'm not sure.” replaces a speaker onset at 470.2 s; at ≥1.1, the same generic phrase also replaces a clean 16-word sentence. At 1.5 another cut adds “…but I think that's a”. These phrase insertions are missed when most words in a segment remain supported. The first cut's “the year” is instead a **mishearing of overlapped speech**, not a fabrication. Penalty 1.0 is the lowest tested penalty that meets the **≤25% AMI limit** (0.5 scores 25.84%), with zero AMI blanks and no flagged alternation segment; it is **not fabrication-free**. No single tested setting removes every synthetic blank without adding unsupported output.

The model check used Python sherpa-onnx **1.13.8**, two threads, greedy search, blank penalty 0 and no padding on the exact two VAD cuts that were blank in the v3 int8 baseline (0.060–4.400 s and 82.876–90.160 s). The [v3 fp32](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3/tree/1a468a35cbba69418f126de829e75261dea4a4e4) and [English v2 int8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/tree/1ab9323565ddb038682214b292f588070a538ce2) downloads were revision-pinned and checked against their published SHA-256 hashes. The 110M English int8 pack is the fixture lock's small model.

| Model | First cut | Second cut |
| --- | --- | --- |
| v3 int8 | 0 tokens, blank | 0 tokens, blank |
| v3 fp32 | 21 tokens, “On Friday, confession will be heard all the afternoon after” | 0 tokens, blank |
| English v2 int8 | 25 tokens, “On Friday, confession will be heard all the afternoon afterwards” | 30 tokens, “The others resented postponement, but it was just his scruples that charmed him” |
| 110M English int8 | 23 tokens, “On Friday, confession will be heard all the afternoon afterity” | 44 tokens, includes “The others resented postponement” and “Cold lucid indifference reigned in his head” |

Fp32 recovering only the first cut is consistent with quantization contributing to the collapse, but the second cut shows it is not the whole explanation. Both English variants recover these cuts. The following full-fixture variant runs used the **same saved v3 baseline VAD boundaries**, Python sherpa-onnx 1.13.8, greedy search and no pad, with the penalty shown per row. As a parity check, Python v3 int8 at penalty 0 reproduced the Swift benchmark's WER and empty counts exactly on all three fixtures.

| Model / penalty | LibriSpeech WER / empty | AMI WER / empty | Alternation WER / empty |
| --- | ---: | ---: | ---: |
| v3 int8 / 0 | 2.02% / 0 | 28.73% / 5 | 65.08% / 18 |
| v3 int8 / 1.0 | 2.02% / 0 | 23.39% / 0 | 52.67% / 2 |
| English v2 int8 / 0 | 2.53% / 1 | 23.50% / 0 | 65.47% / 7 |
| 110M English int8 / 0 | 2.44% / 0 | 30.30% / 4 | 21.53% / 0 |
| 110M English int8 / 1.0 | 2.53% / 0 | 28.13% / 3 | 20.35% / 0 |

The 110M model's three remaining AMI empty cuts at penalty 1.0 are each at most 0.8 s; its AMI deficit is mainly deletions within decoded segments (421, against v3 int8 at penalty 1.0's 328). The English v2 int8 model still has seven empty alternation segments at penalty 0, including 16.6 s and 26.1 s cuts. The small model's strong synthetic alternation score therefore does not displace v3 on the real AMI meeting, but it remains the planned pack for phones with less than 6 GB of RAM.

**ASR verdict:** v3 int8 with greedy search, blank penalty **0**, pad **0** is no-go on continuous speech. The **1.0/0** setting is the recommended default for T23: it meets the LibriSpeech and AMI limits, removes all AMI blanks and improves alternation, while retaining two blank synthetic segments. Raising the penalty to 1.3 removes those blanks but raises “I'm not sure.” phrase insertions from one to three. English v2 int8 loses long alternation segments, and the 110M model is less accurate on the real AMI meeting. The two pre-ship experiments below remain necessary; LibriSpeech alone cannot pass the ASR gate.

**T23 decode and gates:** use **v3 int8, greedy search, `blankPenalty = 1.0`, 0 s chunk pad and the 25 s soft VAD cap** as the default on phones with at least 6 GB of RAM. Keep the planned **110M English int8 pack** on phones under 6 GB; its penalty-1.0 result is recorded above. Do not carry over the benchmark's 15 s diagnostic split: T23 still needs a context-aware hard bound of ≤25 s per ASR work unit for capture-priority handoff. Keep **≤4% LibriSpeech WER** and **≤25% AMI WER** as hard limits. Treat alternation as a relative stress check: no worse than the v3 1.0/0 reference of **52.67% WER with at most two blank segments**, and report a fabrication count that includes **phrase-level insertions**, not only per-segment flags. Count and log blank-but-VAD-speech segments at runtime; track any non-silent blank of at least 4 s on real audio. These limits are provisional because ES2004a and alternation were used during tuning. Phone load, RTF and memory gates remain pending.

**Before shipping:** (1) score v3 int8 and 110M, both at penalty 1.0, on a second **real English recording with fast turn-taking** to check whether the synthetic weakness occurs outside alternation and provide a meeting not used for this tuning; (2) score v3 on several minutes each of **German, French and Spanish** at penalties 0 and 1.0 to check that the English-tuned penalty preserves multilingual speech. A real-audio pre-roll experiment may follow if the first check finds onset-related losses; zero padding is the wrong substitute.

The benchmark does not apply the plan's 0.001 dither or −3 dBFS peak normalization to these clean fixtures. `EXO_STT_BENCH_VAD_CAP_SECONDS` can vary the soft VAD request from 10 to 25 seconds. `EXO_STT_BENCH_ASR_ONLY=1` skips diarization for a focused diagnostic; it never supplies a diarization gate result.

`loadSeconds` includes ASR and VAD model construction. `coldLoadSeconds` is recorded on the first run in the process, with four threads first; it is not necessarily cold for the OS page cache, especially just after copying models. `decodeSeconds` includes the VAD pass over the whole audio and ASR decoding; `rtf` divides that time by total audio duration. Word timestamps aggregate sherpa's BPE token timings; speaker assignment uses the word's first token time. The earlier-started turn wins during overlap.

## Diarization findings for T30

Diarization speaker IDs are qualified by their 60-second window. At threshold 0.8, **raw global AMI DER is 86.21% on the Mac and 86.29% on the Moto**. `score.py` also reports reference-aided per-window one-to-one and many-to-one oracles. The many-to-one oracle lets multiple local clusters merge into one reference speaker; it is a merge-allowed diagnostic for **linking these fixed window turns**. The one-to-one oracle is **not** a lower bound. On AMI the many-to-one oracle is **35.72%** at threshold 0.95 and **29.996%** at 0.8, versus the one-to-one oracle's **43.13%** and **45.55%**, respectively. On the held-out alternation fixture, the many-to-one oracle improves from **33.80%** at 0.95 to **31.36%** at 0.8. The benchmark therefore uses **0.8 provisionally**; this departs from §2.10.1's 0.5 and needs T30 validation on another meeting, with ES2004a held out. `EXO_STT_BENCH_CLUSTER_THRESHOLD` overrides it for a diagnostic. These reference-aided 30% and 43% figures are not achieved global DER; on-device speaker separation needs global clustering (T30) before it is usable.

**On-device speaker separation is not proven infeasible.** The current 60-second FastClustering output fails because speaker confusion dominates, while speech segmentation is comparatively accurate (AMI speech misses 4.8% and false alarms 1.3%; alternation 2.5% and 0%). Overlap forms a third cluster for two true alternation speakers. Before T30, time-box whole-file sherpa `process()` on both fixtures at thresholds 0.5, 0.7, 0.8, and 0.9. If it meets AMI DER ≤30% and alternation attribution ≥85% after ASR is repaired, keep bounded per-window segmentation and embedding work units but persist turn embeddings for **global clustering**, excluding overlap and very short turns. If confusion remains high, test a different embedding model using a meeting other than ES2004a for tuning; a user supplied speaker count is another possible lever. Descope local speaker labels only if those experiments fail. This is a T30 design experiment, not a T7 gate pass.

`diarizationExtraFootprintBytes` is the sampled peak above the footprint immediately before diarizer creation, sampled every 10 ms during construction and processing. Allocator reuse changes that reading: the full AMI run was 57.5 MB above an 895.6 MB baseline, while a focused AMI process was 200.0 MB above a 61.6 MB baseline. Use a focused process for the Vonnegut extra-memory gate. `peakPhysFootprintBytes` uses the kernel's lifetime `ledger_phys_footprint_peak`; `diarizationWindowSeconds` records every window time alongside the maximum. The benchmark writes raw outputs even when a threshold fails. Other Vonnegut stop/go limits remain: stripped binary growth ≤40 MB, IPA growth ≤25 MB, cold model load ≤8 s, four-thread RTF ≤0.25, lifetime peak footprint ≤1.6 GB, LibriSpeech WER ≤4%, AMI DER ≤30%, extra diarization footprint ≤400 MB, and each 60-second window ≤5 s. Mac timings are provisional, especially on the overloaded host; Vonnegut is needed for device timing and memory gates.

For a Mac-only diagnostic of the T23 candidate, run `EXO_STT_BENCH_ASR_ONLY=1 EXO_STT_BENCH_BLANK_PENALTY=1.0 EXO_STT_BENCH_CHUNK_PAD_SECONDS=0 swift run --package-path mobile/ios/Packages/ExoStt -Xswiftc -DEXO_STT_BENCH SttBenchMac "$HOME/.cache/exo-stt-fixtures" 4`. Set `EXO_STT_BENCH_ONLY=ami-es2004a-10m` to focus on AMI. This writes `results/mac/`, separate from phone results; copy that directory after each setting because the next run overwrites the same filenames. The 31 C++ static initializers introduced by the linked runtime still need a non-benchmark phone launch timing check. T13 should check the `physicalMemory >= 6_000_000_000` small-model policy against a real 6 GB iPhone.

The pinned Parakeet weights come from [sherpa-onnx's Hugging Face export](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8); the small pack, Silero VAD and diarization models come from [sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases). The model weights are separate from the binary size budget.
