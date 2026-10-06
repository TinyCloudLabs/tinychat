# Vendored `whisper-local-model` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/whisper-local-model` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`. It defines the
Whisper model list (file name, download URL, size, CRC32) that
`tauri-plugin-local-stt` downloads and validates.

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).

## Why vendored

The pinned rev hardcodes every model URL to the `hyprnote.s3.us-east-1.amazonaws.com`
bucket. Upstream moved model hosting to R2 (anarlog `a80f9d7`, 2026-09-01), and
the old bucket now answers 403 for `ggml-large-v3-turbo-q8_0.bin`, so the
Large Turbo download failed (TC-769).

## Local change

`src/lib.rs` `model_url()`: every URL now points at the original publisher,
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`. All seven
files there match the sizes in `model_size_bytes()`, and the Large Turbo file's
CRC32 matches `checksum()` (3055274469), so the plugin's size and checksum
validation is unchanged. File names, sizes, checksums and everything else are
upstream as-is.

`Cargo.toml` `workspace = true` entries were rewritten: `anlg-language` as a git
dependency on the same rev, external crates at the versions declared in the
pinned workspace root (`serde 1`, `specta 2.0.0-rc.22`, `strum 0.28`).

Removal trigger: the anarlog pin moves to a rev whose model URLs resolve.

Applied via `[patch."https://github.com/fastrepl/anarlog"]` in
`src-tauri/Cargo.toml`.
