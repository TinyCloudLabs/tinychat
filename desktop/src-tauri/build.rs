fn main() {
    // The anarlog swift-lib crates emit `-Wl,-rpath,<swift toolchain>` via
    // `cargo:rustc-link-arg`, but Cargo only applies rustc-link-arg to the
    // emitting package's own targets — the final `exo-desktop` binary/test
    // binary never gets them, so dyld can't find libswift_Concurrency at
    // launch. Emit the same runtime paths from this package's build script.
    #[cfg(all(target_os = "macos", feature = "transcription"))]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
            if let Some(toolchain) = swift_toolchain_root() {
                println!(
                    "cargo:rustc-link-arg=-Wl,-rpath,{}/lib/swift/macosx",
                    toolchain.display()
                );
            }
        }
    }

    tauri_build::build()
}

/// `xcrun --find swift` → toolchain root (`<root>/bin/swift` → `<root>`).
#[cfg(all(target_os = "macos", feature = "transcription"))]
fn swift_toolchain_root() -> Option<std::path::PathBuf> {
    let output = std::process::Command::new("xcrun")
        .args(["--find", "swift"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let bin = String::from_utf8(output.stdout).ok()?;
    std::path::Path::new(bin.trim())
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .map(std::path::Path::to_path_buf)
}
