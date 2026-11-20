//! The fixtures come from real calls and this repository is public. tools/scrub.py checks each
//! fixture for the real names it replaced. These tests check the result without knowing those
//! names: every text in a fixture must be on a list of interface labels and made-up names, so a
//! real name cannot slip in with a later fixture.

mod common;

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Every text a fixture may hold, after each made-up name is written `{name}` and each run of
/// digits `#`. A new fixture that needs a new entry must add it here, in review.
const ALLOWED_TEXT: [&str; 73] = [
    "#",
    "(You)",
    "Add people",
    "Audio settings",
    "Backgrounds and effects",
    "Bring the call back here",
    "Button",
    "Call controls",
    "Call feature notifications and actions",
    "Camera problem. Show more info",
    "Captions",
    "Captions and translation",
    "Chat with everyone",
    "Close",
    "Contributors #",
    "Don't show again",
    "External participants joined",
    "Font color",
    "Font size",
    "Gemini is taking notes",
    "Gemini isn't taking notes",
    "Gemini uses meeting conversations to answer questions",
    "Host controls",
    "In call",
    "Invite",
    "Leave call",
    "Meeting details",
    "Meeting host",
    "Meeting tools",
    "Merged audio",
    "Microphone problem. Show more info",
    "More",
    "More actions",
    "More options",
    "More options for {name}",
    "More options for {name}, collapsed",
    "More options to manage all participants",
    "Mute all",
    "Open caption settings",
    "PM",
    "Participants",
    "Participants (#)",
    "Participants list",
    "People",
    "Pop out",
    "Raise hand (ctrl + ⌘ + h)",
    "Reframe",
    "Rejoin",
    "Return to home screen",
    "Search for people",
    "Send a reaction",
    "Settings",
    "Share screen",
    "Side panel",
    "Start video",
    "Submit",
    "Submit feedback",
    "This call is open to anyone",
    "Transcribing",
    "Turn off camera",
    "Turn off microphone",
    "Turn on background blur",
    "Turn on microphone",
    "Unmute",
    "Upgrade to Zoom Pro",
    "Video settings",
    "You can't unmute someone else",
    "Your microphone is off.",
    "Zoom Meeting",
    "{name}",
    "{name} (Host, me)",
    "{name} joined",
    "{name}, Computer audio muted",
];

/// Accessibility identifiers a fixture may hold.
const ALLOWED_IDENTIFIERS: [&str; 3] = [
    "ZMHCTableItemType_PANELIST",
    "upgrade button",
    "zm.meeting.window.main",
];

/// What the meta line of a fixture may say, and nothing else: no capture time, no file name, no
/// OS build, and only the app the capture was read from.
const ALLOWED_META_KEYS: [&str; 9] = [
    "kind", "app", "os", "apps", "roots", "every", "redacted", "scrubbed", "snap",
];

fn fixtures() -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(common::fixture_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            let text = std::fs::read_to_string(&path).unwrap();
            out.push((path, text));
        }
    }
    assert!(out.len() >= 11, "fixtures missing");
    out
}

/// Made-up names become `{name}` and digit runs `#`.
fn normalized(text: &str) -> String {
    let mut text = text.to_owned();
    for name in common::FAKE_NAMES {
        text = text.replace(name, "{name}");
    }
    let mut out = String::new();
    let mut in_digits = false;
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            if !in_digits {
                out.push('#');
            }
            in_digits = true;
        } else {
            out.push(ch);
            in_digits = false;
        }
    }
    out
}

/// Check every node of a `full` or `diff` line: texts, identifiers and class tokens.
fn check_nodes(line: &Value, path: &Path) {
    let lists = ["nodes", "changed", "added"];
    let nodes = lists
        .iter()
        .filter_map(|list| line[*list].as_array())
        .flatten();
    for node in nodes {
        for (key, item) in node.as_object().unwrap() {
            match key.as_str() {
                "t" | "desc" | "v" | "help" => {
                    let text = item
                        .as_str()
                        .unwrap_or_else(|| panic!("{}: {key} is not a string", path.display()));
                    let shape = normalized(text);
                    assert!(
                        ALLOWED_TEXT.contains(&shape.as_str()),
                        "{}: a {key} text of {} characters is not on the allow-list",
                        path.display(),
                        text.chars().count()
                    );
                }
                "id" => {
                    let identifier = item.as_str().unwrap_or_default();
                    assert!(
                        ALLOWED_IDENTIFIERS.contains(&identifier),
                        "{}: an identifier of {} characters is not on the allow-list",
                        path.display(),
                        identifier.chars().count()
                    );
                }
                "cls" => {
                    // Class names survive only as tokens: "c" and eight hex digits.
                    for class in item.as_array().unwrap() {
                        let class = class.as_str().unwrap();
                        let token = class.len() == 9
                            && class.starts_with('c')
                            && class[1..]
                                .chars()
                                .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch));
                        assert!(token, "{}: class {class:?} is not a token", path.display());
                    }
                }
                // Path, depth, role, subrole, selection and live-region fields: structure.
                "p" | "d" | "r" | "sr" | "sel" | "AXLiveRegionStatus" | "AXLiveRegionRelevant" => {}
                other => panic!("{}: unexpected node key {other}", path.display()),
            }
        }
    }
}

#[test]
fn every_text_in_every_fixture_is_an_interface_label_or_a_made_up_name() {
    for (path, text) in fixtures() {
        for line in text.lines() {
            let value: Value = serde_json::from_str(line).unwrap();
            match value["kind"].as_str() {
                Some("full") | Some("diff") => check_nodes(&value, &path),
                Some("meta") | Some("attributes") => {}
                other => panic!("{}: unexpected line kind {other:?}", path.display()),
            }
        }
    }
}

#[test]
fn the_allow_list_test_refuses_a_text_that_is_not_listed() {
    let line: Value =
        serde_json::from_str(r#"{"kind":"full","nodes":[{"p":"r","v":"Robin Sample"}]}"#).unwrap();
    let refused = std::panic::catch_unwind(|| check_nodes(&line, Path::new("made-up.jsonl")));
    assert!(refused.is_err());
    assert_eq!(normalized("Alex Example (Host, me)"), "{name} (Host, me)");
    assert_eq!(normalized("Contributors 12"), "Contributors #");
}

#[test]
fn fixture_meta_lines_say_nothing_about_the_capture_machine() {
    for (path, text) in fixtures() {
        let meta: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        let meta = meta.as_object().unwrap();
        assert_eq!(meta["kind"], "meta", "{}", path.display());
        for key in meta.keys() {
            assert!(
                ALLOWED_META_KEYS.contains(&key.as_str()),
                "{}: meta key {key}",
                path.display()
            );
        }
        // The OS version without its build, when the capture gave one.
        let os = meta.get("os").map_or("", |os| os.as_str().unwrap());
        assert!(
            os.chars().all(|ch| ch.is_ascii_digit() || ch == '.'),
            "{}: os {os:?}",
            path.display()
        );
        // Only the app the capture was read from: bundle id and version.
        let apps = meta["apps"].as_array().unwrap();
        assert_eq!(apps.len(), 1, "{}", path.display());
        let app = apps[0].as_object().unwrap();
        assert!(
            app.keys().all(|key| key == "bundleId" || key == "version"),
            "{}",
            path.display()
        );
    }
}

#[test]
fn fixtures_hold_no_redacted_text_addresses_or_dom_ids() {
    for (path, text) in fixtures() {
        let lower = text.to_lowercase();
        for mark in [
            "«",
            "»",
            "@",
            "://",
            "www.",
            "meet.google.com/",
            "tinycloud",
        ] {
            assert!(
                !lower.contains(mark),
                "{} contains {mark:?}",
                path.display()
            );
        }
        for key in [
            "\"domId\"",
            "\"pid\"",
            "\"wallTime\"",
            "\"startedAt\"",
            "\"from\"",
            "\"name\"",
        ] {
            assert!(!text.contains(key), "{} keeps {key}", path.display());
        }
    }
}

#[test]
fn no_fixture_holds_a_class_name_of_the_rules() {
    // Class names reach a fixture only as the scrubber's tokens, so the speaking rule's own
    // class names never appear in one.
    let rules = call_names::rules::Rules::embedded().unwrap();
    let classes: Vec<&String> = rules
        .apps
        .iter()
        .flat_map(|app| &app.speaking)
        .filter_map(|rule| rule.classes.as_ref())
        .flat_map(|classes| {
            classes
                .all
                .iter()
                .chain(&classes.quiet)
                .chain(&classes.speaking)
        })
        .collect();
    assert!(classes.len() >= 3);
    for (path, text) in fixtures() {
        for class in &classes {
            assert!(
                !text.contains(&format!("\"{class}\"")),
                "{} holds a class name of the rules",
                path.display()
            );
        }
    }
}
