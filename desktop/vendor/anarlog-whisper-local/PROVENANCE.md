# Vendored `whisper-local` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/whisper-local` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`. It wraps
whisper.cpp (through `whisper-rs`) for the in-process local-stt server.

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).
`whisper-rs` and whisper.cpp are unchanged third-party dependencies under their
own MIT licenses.

## Why vendored

`Whisper::transcribe` runs a whole speech chunk (up to 25 s of audio, with
temperature fallback) in one blocking whisper.cpp call and exposes no hook, so
the batch server (`vendor/anarlog-transcribe-whisper-local`) could not report
that it was still working. On a slow or contended Mac that one call can outlast
the clients' 30 s stream-idle timeout, which then fails a healthy transcription.

## Local change

`src/model/actual.rs`: new `Whisper::transcribe_with_progress(audio, on_token)`.
`on_token` runs once per decoded token, from the logits filter callback the
crate already installs (to suppress the timestamp-begin token); its user data
is now a small struct holding both the token id and the hook. `transcribe`
delegates to it with a no-op hook, so behaviour is unchanged for every other
caller. The hook runs on the inference thread across the C boundary and must
not panic.

`src/model/mock.rs`: the same method for the non-`actual` build.

`Cargo.toml` `workspace = true` entries were rewritten: anarlog crates as git
dependencies on the same rev, external crates at the versions declared in the
pinned workspace root (`dasp 0.11.0`, `hound 3.5.1`, `rodio 0.22`,
`futures-util 0.3.31`, `tracing 0.1`, `serde 1`, `serde_json 1`,
`specta 2.0.0-rc.22`, `thiserror 2`, `lazy_static 1.5.0`, `regex 1.12`,
`uuid 1`; dev: `dirs 6.0.0`, `tokio 1`). `whisper-rs` keeps its upstream
codeberg git pin (`129b982`). No other source changes. (As a path dependency
its pre-existing "method `debug` is never used" release-build warning is now
visible; that is upstream code.)

Removal trigger: upstream exposes a progress/cancel hook on `transcribe`.

Applied via `[patch."https://github.com/fastrepl/anarlog"]` in
`src-tauri/Cargo.toml`.
