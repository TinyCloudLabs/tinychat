//! The reader never acts on another app's window: a source scan of everything that ships or runs
//! on the Mac (src/ and examples/).
//!
//! - No Accessibility action is declared or called.
//! - The only attribute ever written is Chromium's manual-accessibility flag, from one function.
//! - The enhanced-interface flag, which changes how some apps lay out their windows, is never used.

use std::path::{Path, PathBuf};

fn sources() -> Vec<(PathBuf, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut out = Vec::new();
    let mut directories = vec![root.join("src"), root.join("examples")];
    while let Some(directory) = directories.pop() {
        for entry in std::fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                directories.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                out.push((path, text));
            }
        }
    }
    assert!(out.iter().any(|(path, _)| path.ends_with("src/ax.rs")));
    out
}

#[test]
fn no_accessibility_action_is_declared_or_called() {
    // Built from pieces so that this file does not contain the names it looks for.
    let forbidden = [
        ["AXUIElement", "PerformAction"].concat(),
        ["Perform", "Action"].concat(),
        ["kAX", "PressAction"].concat(),
        ["AX", "Press"].concat(),
        ["AXEnhanced", "UserInterface"].concat(),
        ["AXUIElement", "PostKeyboardEvent"].concat(),
        ["CGEvent", "Post"].concat(),
    ];
    for (path, text) in sources() {
        for name in &forbidden {
            assert!(
                !text.contains(name.as_str()),
                "{} mentions {name}",
                path.display()
            );
        }
    }
}

#[test]
fn the_only_write_is_the_chromium_flag() {
    let set = ["AXUIElement", "SetAttributeValue("].concat();
    let mut found = Vec::new();
    for (path, text) in sources() {
        for (number, line) in text.lines().enumerate() {
            if line.contains(&set) {
                found.push((path.clone(), number, line.trim().to_owned()));
            }
        }
    }
    // The declaration and one call, both in ax.rs.
    assert_eq!(found.len(), 2, "{found:?}");
    assert!(
        found.iter().all(|(path, _, _)| path.ends_with("src/ax.rs")),
        "{found:?}"
    );
    assert!(
        found[0].2.starts_with("fn "),
        "declaration first: {found:?}"
    );
    let ax =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ax.rs")).unwrap();
    let lines: Vec<&str> = ax.lines().collect();
    let call = found[1].1;
    let start = (0..call)
        .rev()
        .find(|&index| lines[index].trim_start().starts_with("fn "))
        .unwrap();
    assert!(
        lines[start].contains("fn set_manual_accessibility("),
        "the write sits in {}",
        lines[start]
    );
    // That function names its attribute itself, and the attribute is the Chromium flag.
    let body = lines[start..=call].join("\n");
    assert!(
        body.contains("CFString::from_static_string(MANUAL_ACCESSIBILITY)"),
        "{body}"
    );
    assert!(ax.contains("const MANUAL_ACCESSIBILITY: &str = \"AXManualAccessibility\";"));
}
