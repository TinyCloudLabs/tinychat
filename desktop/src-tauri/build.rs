fn main() {
    // The anarlog swift-lib crates emit `-Wl,-rpath,<swift toolchain>` via
    // `cargo:rustc-link-arg`, but Cargo only applies rustc-link-arg to the
    // emitting package's own targets — the final `exo-desktop` binary/test
    // binary never gets them, so dyld can't find libswift_Concurrency at
    // launch. Point it at the OS Swift runtime (present on every macOS the
    // bundle supports, minimumSystemVersion 14.2); never at the build
    // machine's Xcode toolchain, which users don't have.
    #[cfg(all(target_os = "macos", feature = "transcription"))]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        }
    }

    tauri_build::build()
}
