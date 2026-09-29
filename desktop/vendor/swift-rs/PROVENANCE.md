# Vendored `swift-rs` (yujonglee fork)

Source: `github.com/yujonglee/swift-rs` @ rev `41a1605` — pulled transitively by
anarlog's `transcribe-soniqo` / `transcribe-speechanalyzer` crates.

License: MIT OR Apache-2.0 (see `LICENSE-MIT`, `LICENSE-APACHE`).

## Local change

`src-rs/build.rs` passes `--build-system native` to `swift build`. That is the
only difference from upstream `41a1605`.

Why: Swift 6.4 / Xcode 27 made `swiftbuild` SwiftPM's default build system.
It prelinks every target of a static product with `ld -r` before archiving.
Without `-keep_private_externs`, that demotes the private-extern `@_cdecl`
bridge functions of the `SwiftRs` Swift package (`retain_object`,
`release_object`, `data_from_bytes`, `string_from_bytes` — `internal`, so
hidden in release builds) to local symbols, and the final Rust release link
fails with those four symbols undefined. Debug builds only linked because
SwiftPM passes `-enable-testing` there. The `native` build system archives the
raw objects, so the symbols stay private-extern and resolve at the final link.
Evidence: `nm -m` on the prelinked `SwiftRs.o` shows
`non-external (was a private external)` under `swiftbuild` and
`private external` under `native`; a full release `cargo build` and
`tauri build` link only with the flag.

This is a compatibility stopgap, not the final architecture:

- Swift 6.4 prints a deprecation warning for `--build-system native`.
- On Swift <= 6.3 (Xcode 26.x, the pinned CI runner) `native` is already the
  default, so the flag is a no-op there.
- Removal trigger: when a supported Xcode drops `native`, or anarlog/swift-rs
  make the bridge functions `public` upstream. The replacement is vendoring
  the `SwiftRs` Swift package with `public` bridge functions (or globalizing
  those symbols after the prelink) — without a silent fallback.

Only `Cargo.toml` (unchanged) and `src-rs/*.rs` are vendored — the crate's
Swift-side sources are unused by the anarlog build path.

Applied via `[patch."https://github.com/yujonglee/swift-rs"]` in
`src-tauri/Cargo.toml`.
