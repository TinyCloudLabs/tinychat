# Vendored anarlog listener-core

Source: `fastrepl/anarlog` `crates/listener-core` at
`864ddc1f692116d128eea2692fd72b0a51007768`, MIT licensed. The
upstream root `LICENSE` is copied here. `Cargo.toml` replaces workspace
dependencies with the same pinned git revision and pinned external versions.

Exo needs a stopped-source boundary before anarlog's length-dependent MP3
encode. The local change in `src/actors/recorder/disk.rs` finalizes and fsyncs
all WAV writers, then creates and fsyncs `audio.exo-source-ready` and the
session directory before starting the MP3 encode. Starting another sink in
the same directory clears the marker. Exo's `recorder_stop_durable` retains
and fsyncs the stopped WAV after seeing this marker, then journals the source
before returning a save receipt. The marker is not a playback or import path.

Remove this patch when upstream exposes an equivalent durable stopped-source
boundary through its recorder API.
