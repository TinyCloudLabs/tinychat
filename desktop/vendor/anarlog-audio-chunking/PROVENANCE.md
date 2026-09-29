# Vendored `audio-chunking` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/audio-chunking` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`. It splits audio
into speech chunks with the Silero VAD.

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).

## Why vendored

The batch server (`vendor/anarlog-transcribe-whisper-local`) scans each
channel in 2-minute windows, and `Chunker::chunk` runs a whole window through
the VAD in one call with no hook. Measured under background QoS on a loaded
Mac, one window took 6–52 s, longer than the clients' 30 s stream-idle timeout,
so a healthy transcription failed while it was scanning silence.

## Local change

`src/vad/mod.rs`: the body of `VadChunker::chunk` moved into
`chunk_with_progress(samples, sample_rate, on_scanned)`, which additionally
calls `on_scanned(samples_scanned)` after every VAD frame (512 samples);
`Chunker::chunk` delegates with a no-op hook, so chunking is unchanged for
every caller.

`src/speech.rs`: public `SpeechChunker::chunk_with_progress` forwarding to it.

`Cargo.toml` `workspace = true` entries were rewritten: anarlog crates as git
dependencies on the same rev, external crates at the versions declared in the
pinned workspace root (`futures-util 0.3.31`, `pin-project 1`, `thiserror 2`;
dev: `hound 3.5.1`, `rodio 0.22`, `tokio 1`). The upstream `chunking` example
(not built by Exo) is not vendored, so its `[[example]]` entry is dropped. No
other source changes.

Removal trigger: upstream exposes per-frame progress from the chunker.

Applied via `[patch."https://github.com/fastrepl/anarlog"]` in
`src-tauri/Cargo.toml`.
