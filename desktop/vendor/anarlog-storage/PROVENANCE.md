# Vendored `storage` crate (anarlog MIT layer)

Source: `fastrepl/anarlog` `crates/storage` @ rev
`864ddc1f692116d128eea2692fd72b0a51007768` — the same pin used for the
`tauri-plugin-*` dependencies in `desktop/src-tauri/Cargo.toml`.

License: MIT (see `LICENSE`, the anarlog root license covering `crates/**` and
`plugins/**` — the `enterprise/` tree is commercial and is not vendored).

## Why vendored

Upstream `crates/storage/src/global.rs` hardcodes the release-build app folder
to `anarlog` (with a legacy `hyprnote` fallback). A release build of Exo would
read/write an existing anarlog install's vault and model directories — including
honoring a `global.json` `vault_path` redirect owned by another app — instead of
Exo-owned storage. There is no configuration surface for this: `CHAR_VAULT_BASE`
only overrides the vault (sessions), not the models directory under
`global_base()`.

## Local change

`src/global.rs::resolve_app_folder` returns the host app's bundle identifier in
both debug and release builds. Debug already behaved this way upstream. This
keeps every Exo build under
`~/Library/Application Support/xyz.tinycloud.exo` and ignores any
`hyprnote`/`anarlog` folders. Tests that asserted the anarlog release-folder
behavior were removed; the staging-bundle-id constant remains unused upstream
behavior folded into the single branch.

Upstream `Cargo.toml` `workspace = true` dependency entries were rewritten to
concrete versions from the pinned workspace root (`base64 0.22.1`, `dirs 6`,
`serde 1`, `serde_json 1`, `shellexpand 3`, `specta 2.0.0-rc.22`,
`tempfile 3`, `thiserror 2`, `tokio 1`, `windows 0.62.2`). No other source
changes.

This directory replaces the git copy via
`[patch."https://github.com/fastrepl/anarlog"]` in `src-tauri/Cargo.toml`.
