//! Each of the four sources returns the expected names from its scrubbed snapshot.
//!
//! Every snapshot has only the local participant ("Alex Example" stands for the real name). Rules
//! for other people's rows and tiles stay provisional until multi-person snapshots exist.

mod common;

use call_names::names::MAX_PEOPLE;
use call_names::roster::Roster;
use call_names::rules::App;
use call_names::session::{Budget, Skip, Target};
use call_names::tree::{Node, NodeSource};
use common::*;

#[test]
fn meet_people_panel_gives_the_local_user_marked_self() {
    // People panel open, solo call.
    let root = fixture("meet-people-panel");
    let extraction = read(App::GoogleMeet, &root).unwrap();
    assert_eq!(
        names(&extraction, "meet-people-panel"),
        named(&[("Alex Example", true)])
    );
    assert_eq!(
        names(&extraction, "meet-tiles"),
        named(&[("Alex Example", false)])
    );
    let mut roster = Roster::new();
    assert!(roster.observe(12_000, &extraction));
    assert_eq!(
        roster.participants().unwrap().to_json(),
        r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Alex Example","self":true}],"truncated":false}"#
    );
}

#[test]
fn meet_tiles_give_the_name_with_the_panel_closed() {
    // Tiled layout; Spotlight and Sidebar gave the same tree in this solo call, so they have no
    // fixture of their own.
    // Auto layout, with hover controls ("More options for …", "Reframe") inside main.
    for fixture_name in ["meet-layout-tiled", "meet-layout-auto"] {
        let extraction = read(App::GoogleMeet, &fixture(fixture_name)).unwrap();
        assert_eq!(
            names(&extraction, "meet-tiles"),
            named(&[("Alex Example", false)]),
            "{fixture_name}"
        );
        assert_eq!(
            names(&extraction, "meet-people-panel"),
            named(&[]),
            "{fixture_name}"
        );
    }
}

#[test]
fn meet_tiles_give_every_name_with_two_people() {
    // The host and Test Guest A, People closed. The local tile shows the user's
    // own name, not "You".
    let extraction = read(App::GoogleMeet, &fixture("meet-two-people-tiles")).unwrap();
    assert_eq!(
        names(&extraction, "meet-tiles"),
        named(&[("Test Guest A", false), ("Alex Example", false)])
    );
    assert_eq!(names(&extraction, "meet-people-panel"), named(&[]));
    // Without the People panel nobody is marked self, so a 1:1 suggestion cannot come from tiles.
    let mut roster = Roster::new();
    roster.observe(0, &extraction);
    assert_eq!(
        roster.participants().unwrap().to_json(),
        r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Test Guest A"},{"id":"p2","name":"Alex Example"}],"truncated":false}"#
    );
}

#[test]
fn meet_people_panel_with_two_people_marks_only_the_local_user() {
    // People open with the host and Test Guest A. The guest's row has
    // its name as title and no "(You)".
    let extraction = read(App::GoogleMeet, &fixture("meet-two-people-panel")).unwrap();
    assert_eq!(
        names(&extraction, "meet-people-panel"),
        named(&[("Alex Example", true), ("Test Guest A", false)])
    );
    assert_eq!(
        names(&extraction, "meet-tiles"),
        named(&[("Test Guest A", false), ("Alex Example", false)])
    );
    let mut roster = Roster::new();
    roster.observe(0, &extraction);
    assert_eq!(
        roster.participants().unwrap().to_json(),
        r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Alex Example","self":true},{"id":"p2","name":"Test Guest A"}],"truncated":false}"#
    );
}

#[test]
fn a_two_person_call_gives_one_self_and_one_other_over_the_recording() {
    // Tiles first (People closed), then the panel opens: ids stay in first-seen order, the self
    // mark arrives with the panel, and exactly one person other than self remains, which is what
    // the 1:1 suggestion needs.
    let mut roster = Roster::new();
    let tiles = read(App::GoogleMeet, &fixture("meet-two-people-tiles")).unwrap();
    let panel = read(App::GoogleMeet, &fixture("meet-two-people-panel")).unwrap();
    assert!(roster.observe(5_000, &tiles));
    assert!(roster.observe(140_000, &panel));
    assert!(!roster.observe(145_000, &panel));
    assert_eq!(
        roster.participants().unwrap().to_json(),
        r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Test Guest A"},{"id":"p2","name":"Alex Example","self":true}],"truncated":false}"#
    );
    let others: Vec<_> = roster
        .people()
        .iter()
        .filter(|person| !person.is_self)
        .collect();
    assert_eq!(others.len(), 1);
    assert_eq!((others[0].first_ms, others[0].last_ms), (5_000, 145_000));
}

#[test]
fn meet_speech_capture_reads_like_the_panel_snapshot() {
    // First snapshot of a capture with People open and local speech; its diffs keep the class tokens for phase 2.
    let extraction = read(App::GoogleMeet, &fixture("meet-speech-people-open")).unwrap();
    assert_eq!(
        names(&extraction, "meet-people-panel"),
        named(&[("Alex Example", true)])
    );
    assert_eq!(
        names(&extraction, "meet-tiles"),
        named(&[("Alex Example", false)])
    );
}

#[test]
fn meet_picture_in_picture_placeholder_gives_no_names() {
    // The call moved to a picture-in-picture window. The page still has "Leave call", and
    // main holds two headings whose static text (redacted in the capture, put back here) is not a
    // name.
    let mut root = fixture("meet-pip-placeholder");
    let main = find_mut(&mut root, &|node: &Node| {
        node.subrole.as_deref() == Some("AXLandmarkMain")
    })
    .unwrap();
    let mut headings = 0;
    for heading in main.children[0]
        .children
        .iter_mut()
        .filter(|node| node.role.as_deref() == Some("AXHeading"))
    {
        heading.children[0].value = Some("Your call is in another window".into());
        headings += 1;
    }
    assert_eq!(headings, 2);
    let extraction = read(App::GoogleMeet, &root).unwrap();
    assert!(extraction.is_empty(), "{extraction:?}");
}

#[test]
fn meet_page_after_leaving_is_not_in_call() {
    // After leaving: "Rejoin" and "Return to home screen", no call controls.
    assert_eq!(
        read(App::GoogleMeet, &fixture("meet-left-call")),
        Err(Skip::NotInCall)
    );
}

#[test]
fn zoom_participants_panel_strips_the_tags_and_marks_self() {
    // "Alex Example (Host, me)" in a ZMHCTableItemType_PANELIST cell.
    let extraction = read(App::Zoom, &fixture("zoom-participants-panel")).unwrap();
    assert_eq!(
        names(&extraction, "zoom-participants-panel"),
        named(&[("Alex Example", true)])
    );
    assert_eq!(
        names(&extraction, "zoom-tiles"),
        named(&[("Alex Example", false)])
    );
    let mut roster = Roster::new();
    roster.observe(0, &extraction);
    assert_eq!(
        roster.participants().unwrap().to_json(),
        r#"{"v":1,"source":"call_window","app":"zoom","people":[{"id":"p1","name":"Alex Example","self":true}],"truncated":false}"#
    );
}

#[test]
fn zoom_tiles_give_the_name_with_the_panel_closed() {
    // Tab group "Alex Example, Computer audio muted" with a button "Alex Example".
    let extraction = read(App::Zoom, &fixture("zoom-tiles")).unwrap();
    assert_eq!(
        names(&extraction, "zoom-tiles"),
        named(&[("Alex Example", false)])
    );
    assert_eq!(names(&extraction, "zoom-participants-panel"), named(&[]));
}

#[test]
fn zoom_tile_button_must_begin_the_tab_group_description() {
    let mut root = fixture("zoom-tiles");
    let tab = find_mut(&mut root, &|node: &Node| {
        node.role.as_deref() == Some("AXTabGroup")
    })
    .unwrap();
    tab.children.push(Node {
        role: Some("AXButton".into()),
        description: Some("Unmute".into()),
        ..Node::default()
    });
    tab.children.push(Node {
        role: Some("AXButton".into()),
        description: Some("Alex".into()),
        ..Node::default()
    });
    let extraction = read(App::Zoom, &root).unwrap();
    assert_eq!(
        names(&extraction, "zoom-tiles"),
        named(&[("Alex Example", false)])
    );
}

#[test]
fn zoom_needs_the_meeting_window() {
    let mut root = fixture("zoom-tiles");
    root.identifier = Some("zm.home.window".into());
    assert_eq!(read(App::Zoom, &root), Err(Skip::NotInCall));
}

#[test]
fn zoom_names_with_parentheses_and_unknown_tags_stay_whole() {
    let mut root = fixture("zoom-participants-panel");
    let text = find_mut(&mut root, &|node: &Node| {
        node.role.as_deref() == Some("AXStaticText")
            && node.value.as_deref() == Some("Alex Example (Host, me)")
    })
    .unwrap();
    text.value = Some("Ana (she/her) (Host, me)".into());
    let extraction = read(App::Zoom, &root).unwrap();
    assert_eq!(
        names(&extraction, "zoom-participants-panel"),
        named(&[("Ana (she/her)", true)])
    );

    let text = find_mut(&mut root, &|node: &Node| {
        node.value.as_deref() == Some("Ana (she/her) (Host, me)")
    })
    .unwrap();
    text.value = Some("Ana (Interpreter)".into());
    let extraction = read(App::Zoom, &root).unwrap();
    assert_eq!(
        names(&extraction, "zoom-participants-panel"),
        named(&[("Ana (Interpreter)", false)])
    );
}

#[test]
fn every_name_in_the_fixtures_is_a_fake_name() {
    for (fixture_name, app) in [
        ("meet-people-panel", App::GoogleMeet),
        ("meet-layout-tiled", App::GoogleMeet),
        ("meet-layout-auto", App::GoogleMeet),
        ("meet-captions-on", App::GoogleMeet),
        ("meet-speech-people-open", App::GoogleMeet),
        ("meet-two-people-tiles", App::GoogleMeet),
        ("meet-two-people-panel", App::GoogleMeet),
        ("zoom-participants-panel", App::Zoom),
        ("zoom-tiles", App::Zoom),
    ] {
        let extraction = read(app, &fixture(fixture_name)).unwrap();
        assert!(!extraction.is_empty(), "{fixture_name}");
        for entry in extraction.entries() {
            assert!(
                FAKE_NAMES.contains(&entry.name.as_str()),
                "{fixture_name}: unexpected name"
            );
        }
    }
}

#[test]
fn no_window_gives_no_target() {
    let none: [Target<&Node>; 0] = [];
    assert_eq!(
        read_with(&mut NodeSource::new(), &none, Budget::DEFAULT),
        Err(Skip::NoTarget)
    );
}

#[test]
fn two_windows_in_a_call_give_nothing() {
    let first = fixture("meet-people-panel");
    let second = fixture("meet-layout-tiled");
    let targets = [
        Target {
            app: App::GoogleMeet,
            root: &first,
        },
        Target {
            app: App::GoogleMeet,
            root: &second,
        },
    ];
    assert_eq!(
        read_with(&mut NodeSource::new(), &targets, Budget::DEFAULT),
        Err(Skip::SeveralInCall(2))
    );
}

#[test]
fn a_window_not_in_a_call_beside_one_in_a_call_is_ignored() {
    let left = fixture("meet-left-call");
    let call = fixture("meet-people-panel");
    let targets = [
        Target {
            app: App::GoogleMeet,
            root: &left,
        },
        Target {
            app: App::GoogleMeet,
            root: &call,
        },
    ];
    let extraction = read_with(&mut NodeSource::new(), &targets, Budget::DEFAULT).unwrap();
    assert_eq!(
        names(&extraction, "meet-people-panel"),
        named(&[("Alex Example", true)])
    );
}

#[test]
fn a_long_participant_list_is_cut_at_the_cap() {
    let mut root = fixture("meet-people-panel");
    let list = find_mut(&mut root, &|node: &Node| {
        node.role.as_deref() == Some("AXList")
    })
    .unwrap();
    let row = list.children[0].clone();
    for n in 0..70 {
        let mut copy = row.clone();
        copy.title = Some(format!("Guest {n}"));
        copy.description = copy.title.clone();
        copy.children
            .retain(|child| child.value.as_deref() != Some("(You)"));
        list.children.push(copy);
    }
    let extraction = read(App::GoogleMeet, &root).unwrap();
    assert_eq!(
        extraction
            .source("meet-people-panel")
            .unwrap()
            .entries
            .len(),
        MAX_PEOPLE
    );
    assert!(extraction.truncated);
    let mut roster = Roster::new();
    roster.observe(0, &extraction);
    assert!(roster.participants().unwrap().truncated);
}

#[test]
fn debug_output_never_contains_a_name() {
    let extraction = read(App::GoogleMeet, &fixture("meet-two-people-tiles")).unwrap();
    let mut roster = Roster::new();
    roster.observe(0, &extraction);
    let logged = format!(
        "{extraction:?} {roster:?} {:?} {:?}",
        roster.participants(),
        fixture("meet-two-people-tiles")
    );
    for word in ["Alex", "Example", "Guest"] {
        assert!(!logged.contains(word), "Debug output shows {word}");
    }
    assert!(logged.contains("meet-tiles"), "rule ids stay visible");
}

/// The row of the People panel whose title is `name`.
fn people_row<'a>(root: &'a mut Node, name: &str) -> &'a mut Node {
    let name = name.to_owned();
    find_mut(root, &move |node: &Node| {
        node.role.as_deref() == Some("AXGroup") && node.title.as_deref() == Some(name.as_str())
    })
    .unwrap()
}

/// Give a People-panel row another display name: its title and its name text.
fn rename_row(root: &mut Node, from: &str, to: &str) {
    let row = people_row(root, from);
    row.title = Some(to.into());
    row.description = Some(to.into());
    let mut texts = 0;
    for child in row.children.iter_mut() {
        if child.value.as_deref() == Some(from) {
            child.value = Some(to.into());
            texts += 1;
        }
    }
    assert_eq!(texts, 1, "the row shows its name as one text of its own");
}

#[test]
fn a_meet_guest_named_like_the_self_mark_is_not_marked_self() {
    // A guest chooses the display name "(You)". Their row shows it as title and as name text, and
    // that text must not pass for the mark.
    let mut root = fixture("meet-two-people-panel");
    rename_row(&mut root, "Test Guest A", "(You)");
    let extraction = read(App::GoogleMeet, &root).unwrap();
    assert_eq!(
        names(&extraction, "meet-people-panel"),
        named(&[("Alex Example", true), ("(You)", false)])
    );
    let mut roster = Roster::new();
    roster.observe(0, &extraction);
    let selves: Vec<&str> = roster
        .people()
        .iter()
        .filter(|person| person.is_self)
        .map(|person| person.name.as_str())
        .collect();
    assert_eq!(selves, ["Alex Example"]);
}

#[test]
fn a_meet_local_user_named_like_the_self_mark_is_still_marked() {
    // The local user's own name is "(You)": the row then has the name text and the mark.
    let mut root = fixture("meet-two-people-panel");
    rename_row(&mut root, "Alex Example", "(You)");
    let extraction = read(App::GoogleMeet, &root).unwrap();
    assert_eq!(
        names(&extraction, "meet-people-panel"),
        named(&[("(You)", true), ("Test Guest A", false)])
    );
}

#[test]
fn two_self_marks_in_one_zoom_list_mark_nobody() {
    // In Zoom the mark is part of the row's text, so a guest named "Mallory (me)" reads exactly
    // like a local user. Two such rows: nobody is marked in this tick.
    let mut root = fixture("zoom-participants-panel");
    let outline = find_mut(&mut root, &|node: &Node| {
        node.role.as_deref() == Some("AXOutline")
    })
    .unwrap();
    let mut row = outline.children[0].clone();
    let text = find_mut(&mut row, &|node: &Node| {
        node.value.as_deref() == Some("Alex Example (Host, me)")
    })
    .unwrap();
    text.value = Some("Mallory (me)".into());
    outline.children.push(row);
    let extraction = read(App::Zoom, &root).unwrap();
    assert_eq!(
        names(&extraction, "zoom-participants-panel"),
        named(&[("Alex Example", false), ("Mallory", false)])
    );
    let mut roster = Roster::new();
    roster.observe(0, &extraction);
    assert!(roster.people().iter().all(|person| !person.is_self));
    assert_eq!(roster.people().len(), 2);
}
