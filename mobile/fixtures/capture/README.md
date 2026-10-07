# Capture golden fixtures

Run `python3 mobile/fixtures/capture/generate.py` to verify every fixture, including every ADTS header field and canonical JSON byte. Use `--write` to regenerate the journals, v2 sidecars and ADTS headers from `ios-input.json` and `android-input.json`.

Each input script has a wall-clock `at` value and cumulative AAC frame count for each segment. The generator derives `a = floor(totalFrames * 1024 * 1000 / rate)` and `segBytes = segmentFrames * 107`. The iOS journal ends with 185 AAC frames (`a=3946` ms); Android ends with 171 (`a=3970` ms). Every segment's frame duration fits within its capture wall interval. Both journals have 11 seconds of wall time, a 5-second pause, a 2-second interruption, three segments, final heartbeats at segment close, Pause and Stop, and an `avail available` event after the call. These fixed-size 107-byte frames are for deterministic core tests; the payload is not an AAC audio sample.

`journal-complete.jsonl` and `sidecar-v2.json` are byte-identical aliases of the iOS files for consumers of the first T1 revision.

`journal-torn.jsonl` has three complete canonical lines followed by an incomplete fourth. `sidecar-v1.json` is legacy and must be read as `ownerUnknown`; `sidecar-malformed.json` goes to quarantine and its audio is probed. `outbox-own-lookup.json` exercises an unescaped `/` in a URL. The single-object v2, outbox and quarantine fixtures have one trailing LF and use sorted keys with no whitespace.
