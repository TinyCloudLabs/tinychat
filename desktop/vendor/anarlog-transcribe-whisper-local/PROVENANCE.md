# Vendored `transcribe-whisper-local` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/transcribe-whisper-local` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`. This is the
in-process whisper.cpp HTTP server that `tauri-plugin-local-stt` mounts at
`/v1/listen`.

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).

## Why vendored

Local Whisper batch transcription is a server-sent-event stream, and both
clients treat a quiet stream as a stall: `listener2-core` fails after 30 s
without a stream item (`progressive_stream_timeout`), and
`tauri-plugin-transcription` fails after 60 s without a streamed event
(`timed_out`), counted from the start of the request. Upstream produced no
event while it

1. received and spooled the upload (the response only opened afterwards),
2. decoded the whole recording into per-channel 16 kHz temp files,
3. VAD-scanned each 2-minute window (progress only followed a speech chunk), and
4. ran Whisper on a chunk (one blocking call).

All of these scale with recording length or machine load. A 74-minute,
mostly-silent Exo recording failed before its first event, and under
background QoS on a loaded Mac, single VAD windows (up to 52 s) and the upload
(~80 s at <1 MB/s) outlasted the timeouts even after (2) and (3) were fixed.

Upstream also had no bound on decoded temp storage: every channel is decoded to
a 32-bit float WAV (4 bytes × 16 kHz, so 230 MB per channel-hour, 4 GiB WAV
maximum) with no duration or free-space check.

## Local change

`src/service/batch.rs`, `src/service/streaming.rs`, `src/service/mod.rs`:

- **Every unit of work reports that it advanced.** A `WorkActivity` sends a
  `progress` event (at most once a second) when work finishes: bytes of the
  upload received and spooled (0%, `prefill`), a decoded block (0%,
  `prefill`), a VAD frame (current %, `transcribing`, via the vendored
  `audio-chunking` hook) and a decoded Whisper token (current %, `decoding`,
  via the vendored `whisper-local` hook). The resolved-audio percentage still
  comes from upstream's `ProgressTracker`, which also reports each scanned
  window. Nothing is sent from a timer, so a stalled or frozen server still
  goes quiet and still times out.
- **The SSE response opens before the upload is spooled** (upstream spooled
  first), so receiving a long recording is reported too. Errors after the
  stream opens — upload too large, empty body, model load, the limits below —
  are terminal SSE `error` events instead of HTTP statuses. The JSON
  (non-SSE) path is unchanged apart from the limits.
- **Supported maximum: 8 hours, 2 channels.** Before decoding, the recording's
  channel count and container duration are checked, and the decoded channel
  files' size (+5% for bitrate-estimated durations, the maximum when the
  duration is unknown) plus a 512 MiB reserve must be free in the temp
  directory (`statvfs`). Decoding also stops at 8 hours of frames whatever the
  container claims. The upload cap is 8 hours of Exo's 128 kbps MP3 plus 5%
  (483,840,000 bytes; upstream 100 MiB). Too-long and too-large recordings
  fail with "file too large for on-device transcription: recordings are
  limited to 8 hours" (the listener2 client shows it as "This recording is too
  large…"); a full disk fails with "not enough free disk space to decode this
  recording: it needs about N GB free in the temporary folder".
- The upload spool is buffered (4 MiB) instead of one blocking write per
  received chunk.
- `chunk_channel_audio_with_progress` reproduces
  `anlg_transcribe_core::chunk_channel_audio` (same VAD config, same 25 s
  split) on top of the progress hook; a unit test checks it returns the same
  chunks.
- Unit tests for the above, including every rejection path.

`Cargo.toml` `workspace = true` entries were rewritten: anarlog crates as git
dependencies on the same rev (so they unify with the rest of the graph), and
external crates at the versions declared in the pinned workspace root
(`axum 0.8`, `bytes 1.11`, `futures-util 0.3.31`, `hound 3.5.1`, `rodio 0.22`,
`serde_html_form 0.4`, `serde_json 1`, `tempfile 3`, `thiserror 2`, `tokio 1`,
`tokio-util 0.7.15`, `tower 0.5`, `tracing 0.1`; dev: `dirs 6.0.0`,
`reqwest 0.13`, `tokio-tungstenite 0.29`). Added: `libc 0.2` (already in the
graph) for `statvfs`. The dev-dependencies add tokio's
`macros`/`rt-multi-thread`, which upstream gets from workspace feature
unification, so the crate's tests compile on their own.

Removal trigger: upstream reports progress throughout a batch job (or its
clients stop treating a quiet batch stream as a stall) and bounds decoded
storage.

This directory replaces the git copy via
`[patch."https://github.com/fastrepl/anarlog"]` in `src-tauri/Cargo.toml`,
together with the vendored `audio-chunking` and `whisper-local` it depends on.
