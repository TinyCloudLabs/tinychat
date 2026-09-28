# Vendored `swift-rs` (yujonglee fork)

Source: `github.com/yujonglee/swift-rs` @ rev `41a1605` — pulled transitively by
anarlog's `transcribe-soniqo` / `transcribe-speechanalyzer` crates.

License: MIT OR Apache-2.0 (see `LICENSE-MIT`, `LICENSE-APACHE`).

## Local change

`src-rs/build.rs`: after `swift build`, emit an additional
`cargo:rustc-link-search=native=<build-path>/out/Products/<Config>/`.

The fork assumes SwiftPM honors `--build-path` with the classic
`<build-path>/<arch>-apple-macosx/<config>` layout. SwiftPM in Xcode ≥16.3
writes products under `<build-path>/out/Products/<Config>/` instead, so the
emitted `-L` pointed at an empty directory and final links failed with
"could not find native static library `apple-speech-swift`" (and the same for
`soniqo-swift`). Emitting both paths covers old and new toolchains; the extra
`-L` is harmless when empty.

Only `Cargo.toml` (unchanged) and `src-rs/*.rs` are vendored — the crate's
Swift-side sources are unused by the anarlog build path.

Applied via `[patch."https://github.com/yujonglee/swift-rs"]` in
`src-tauri/Cargo.toml`.
