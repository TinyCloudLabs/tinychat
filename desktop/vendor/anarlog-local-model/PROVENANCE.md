# Vendored `local-model` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/local-model` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`. It is the
`LocalModel` enum `tauri-plugin-local-stt` downloads, implementing
`model-downloader`'s `DownloadableModel`.

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).

## Why vendored

The vendored `model-downloader` (see its `PROVENANCE.md`, TC-771) can fall
back to a second host through `DownloadableModel::download_fallback_urls()`.
`LocalModel` implements that trait here, so this crate is where Whisper models
pass their fallback URL.

## Local change

`src/lib.rs`: `LocalModel::download_fallback_urls()` returns
`WhisperModel::fallback_model_url()` (from the vendored `whisper-local-model`)
for Whisper models and nothing for the others; plus a unit test.

`Cargo.toml` `workspace = true` entries were rewritten: `model-downloader`,
`file` and `whisper-local-model` as path dependencies on the vendored copies,
the other anarlog crates (`am`, `transcribe-soniqo`,
`transcribe-speechanalyzer`) as git dependencies on the same rev, external
crates at the versions declared in the pinned workspace root (`serde 1`,
`specta 2.0.0-rc.22`; dev: `serde_json 1`).

Removal trigger: the vendored `model-downloader` is removed, or upstream gains
fallback URLs.

Applied via `[patch."https://github.com/fastrepl/anarlog"]` in
`src-tauri/Cargo.toml`.
