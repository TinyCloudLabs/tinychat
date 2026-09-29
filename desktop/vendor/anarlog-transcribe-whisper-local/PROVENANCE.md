# Vendored `transcribe-whisper-local` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/transcribe-whisper-local` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`. This is the
in-process whisper.cpp HTTP server that `tauri-plugin-local-stt` mounts at
`/v1/listen`.

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).

## Why vendored

Local Whisper batch transcription runs as a server-sent-event stream, and both
clients treat a quiet stream as a stall: `listener2-core` fails after 30 s
without a stream item (`progressive_stream_timeout`), and
`tauri-plugin-transcription` fails after 60 s without a streamed event
(`timed_out`). Upstream `service/batch.rs` produced no event at all while it

1. decoded the whole recording into per-channel 16 kHz temp files, and
2. scanned 2-minute windows that contain no speech (progress was only
   reported after a speech chunk was transcribed).

Both scale with recording length, so a 74-minute, mostly-silent Exo recording
failed with `progressive_stream_timeout` before a single event arrived, while
short recordings worked. Raising or scaling the client timeouts would have
meant vendoring `listener2-core` *and* `tauri-plugin-transcription`, and would
also delay detection of a server that really has stopped.

## Local change

`src/service/batch.rs` only:

- While decoding, send a `progress` event (0%, phase `prefill`) once per minute
  of decoded audio.
- `ChannelChunkIterator` now also yields `ChannelWork::Scanned { sample_end }`
  after every window it has scanned; `transcribe_channel_chunks` advances the
  channel's resolved position and emits progress for it (the existing
  `ProgressTracker`, so it only sends when the percentage actually increases).
- `MAX_BATCH_AUDIO_BODY_BYTES` raised from 100 MiB to 1 GiB. Exo records
  128 kbps MP3 (16 KB/s), so 100 MiB rejected every recording longer than
  ~109 minutes (`progressive_start_failed`, "This recording is too large…").
  The body is spooled to a temp file, not memory; the real ceiling is the
  per-channel 32-bit float WAV the server writes (4 GiB ≈ 18.6 h at 16 kHz),
  which 1 GiB of 128 kbps MP3 matches.
- Two unit tests for the progress events.

Events are emitted per unit of work done, not on a timer: a server that stops
working still goes quiet, and the client timeouts still report it.

`Cargo.toml` `workspace = true` entries were rewritten: anarlog crates as git
dependencies on the same rev (so they unify with the rest of the graph), and
external crates at the versions declared in the pinned workspace root
(`axum 0.8`, `bytes 1.11`, `futures-util 0.3.31`, `hound 3.5.1`, `rodio 0.22`,
`serde_html_form 0.4`, `serde_json 1`, `tempfile 3`, `thiserror 2`, `tokio 1`,
`tokio-util 0.7.15`, `tower 0.5`, `tracing 0.1`; dev: `dirs 6.0.0`,
`reqwest 0.13`, `tokio-tungstenite 0.29`). The dev-dependencies add tokio's
`macros`/`rt-multi-thread`, which upstream gets from workspace feature
unification, so the crate's tests compile on their own. No other source
changes.

Removal trigger: upstream emits progress during decoding and silent windows
(or its clients stop treating a quiet batch stream as a stall).

This directory replaces the git copy via
`[patch."https://github.com/fastrepl/anarlog"]` in `src-tauri/Cargo.toml`.
