//! A real Meet call with three connections: the local user, and one other account on two devices.
//!
//! Meet's People list then holds a heading, "Merged audio", above the devices that share a room.
//! The heading is a list child with a title, like a participant row, but it is not a person. A
//! participant row holds its actions menu (a pop-up button three levels down); a heading holds
//! none. The rule asks for that button, which is a role and so does not depend on the language.
//!
//! The fixtures are the reader's own output on that call ("Alex Example" stands for the local
//! user, "Test Guest A" for the other account), with the People panel open and closed.

mod common;

use call_names::roster::Roster;
use call_names::rules::App;
use call_names::session::{Budget, Skip, Target};
use call_names::tree::Node;
use common::*;

const PANEL: &str = "meet-three-connections-panel";
const TILES: &str = "meet-three-connections-tiles";

fn is_role(node: &Node, role: &str) -> bool {
    node.role.as_deref() == Some(role)
}

/// The People list of a fixture.
fn people_list(root: &mut Node) -> &mut Node {
    let region = find_mut(root, &|node: &Node| is_region(node, "In call")).unwrap();
    find_mut(region, &|node: &Node| is_role(node, "AXList")).unwrap()
}

/// How far below `node` its nearest pop-up button is.
fn menu_depth(node: &Node) -> Option<usize> {
    let below = node.children.iter().filter_map(|child| {
        if is_role(child, "AXPopUpButton") {
            Some(1)
        } else {
            menu_depth(child).map(|depth| depth + 1)
        }
    });
    below.min()
}

#[test]
fn the_people_panel_gives_three_rows_and_no_heading() {
    let mut root = fixture(PANEL);
    // The list really holds four titled children; the second is the heading.
    let titles: Vec<String> = people_list(&mut root)
        .children
        .iter()
        .map(|child| child.title.clone().unwrap())
        .collect();
    assert_eq!(
        titles,
        [
            "Alex Example",
            "Merged audio",
            "Test Guest A",
            "Test Guest A"
        ]
    );
    let extraction = read(App::GoogleMeet, &root).unwrap();
    assert_eq!(
        names(&extraction, "meet-people-panel"),
        named(&[
            ("Alex Example", true),
            ("Test Guest A", false),
            ("Test Guest A", false)
        ])
    );
}

#[test]
fn the_tiles_give_three_entries_with_the_panel_open_or_closed() {
    for fixture_name in [PANEL, TILES] {
        let extraction = read(App::GoogleMeet, &fixture(fixture_name)).unwrap();
        assert_eq!(
            names(&extraction, "meet-tiles"),
            named(&[
                ("Test Guest A", false),
                ("Test Guest A", false),
                ("Alex Example", false)
            ]),
            "{fixture_name}"
        );
    }
    let closed = read(App::GoogleMeet, &fixture(TILES)).unwrap();
    assert_eq!(names(&closed, "meet-people-panel"), named(&[]));
}

#[test]
fn the_recording_holds_two_people_and_one_self_once_the_panel_was_seen() {
    // The panel alone: one account on two devices is one person.
    let panel = read(App::GoogleMeet, &fixture(PANEL)).unwrap();
    let mut roster = Roster::new();
    assert!(roster.observe(0, &panel));
    assert_eq!(
        roster.participants().unwrap().to_json(),
        r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Alex Example","self":true},{"id":"p2","name":"Test Guest A"}],"truncated":false}"#
    );

    // A recording that starts with the panel closed and opens it later.
    let tiles = read(App::GoogleMeet, &fixture(TILES)).unwrap();
    let mut roster = Roster::new();
    assert!(roster.observe(2_000, &tiles));
    assert_eq!(roster.people().len(), 2);
    assert!(roster.people().iter().all(|person| !person.is_self));
    assert!(roster.observe(8_000, &panel));
    assert!(!roster.observe(10_000, &panel));
    assert!(!roster.observe(12_000, &tiles));
    assert_eq!(
        roster.participants().unwrap().to_json(),
        r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Test Guest A"},{"id":"p2","name":"Alex Example","self":true}],"truncated":false}"#
    );
    // One self and exactly one other person: what the 1:1 suggestion needs.
    let others: Vec<&str> = roster
        .people()
        .iter()
        .filter(|person| !person.is_self)
        .map(|person| person.name.as_str())
        .collect();
    assert_eq!(others, ["Test Guest A"]);
    for person in roster.people() {
        assert!(FAKE_NAMES.contains(&person.name.as_str()));
    }
}

#[test]
fn the_heading_is_refused_on_structure_alone_and_none_of_its_text_is_read() {
    let mut root = fixture(PANEL);
    let heading: &Node = &people_list(&mut root).children[1];
    assert_eq!(heading.title.as_deref(), Some("Merged audio"));
    assert_eq!(menu_depth(heading), None);
    let of_heading: Vec<*const Node> = heading
        .descendants()
        .into_iter()
        .map(|node| node as *const Node)
        .collect();

    let mut source = Recording::new();
    let target = [Target {
        app: App::GoogleMeet,
        root: &root,
    }];
    let extraction = read_with(&mut source, &target, Budget::DEFAULT).unwrap();
    assert_eq!(
        extraction
            .source("meet-people-panel")
            .unwrap()
            .entries
            .len(),
        3
    );
    assert!(
        source
            .text_reads
            .iter()
            .all(|(node, _)| !of_heading.contains(node)),
        "a text of the heading was read"
    );
}

#[test]
fn every_participant_row_of_every_fixture_has_its_menu_three_levels_down() {
    // Solo, two people, a speech capture and three connections: the condition holds for every
    // real row, and the rule still returns each of them.
    for (fixture_name, rows) in [
        ("meet-people-panel", 1),
        ("meet-two-people-panel", 2),
        ("meet-speech-people-open", 1),
        (PANEL, 3),
    ] {
        let mut root = fixture(fixture_name);
        let list = people_list(&mut root);
        let with_menu: Vec<Option<usize>> = list
            .children
            .iter()
            .map(menu_depth)
            .filter(Option::is_some)
            .collect();
        assert_eq!(with_menu, vec![Some(3); rows], "{fixture_name}");
        let extraction = read(App::GoogleMeet, &root).unwrap();
        let found = extraction.source("meet-people-panel").unwrap();
        assert_eq!(found.entries.len(), rows, "{fixture_name}");
        assert_eq!(
            found.entries.iter().filter(|entry| entry.is_self).count(),
            1,
            "{fixture_name}"
        );
    }
}

/// The second "Test Guest A" row of the panel fixture, renamed so that it can be told apart.
fn renamed_row(root: &mut Node) -> &mut Node {
    let row = &mut people_list(root).children[3];
    row.title = Some("Test Guest B".into());
    row.description = Some("Test Guest B".into());
    row
}

fn panel_names(root: &Node) -> Vec<(String, bool)> {
    names(&read(App::GoogleMeet, root).unwrap(), "meet-people-panel")
}

#[test]
fn a_list_child_is_a_person_only_with_a_menu_button_at_most_four_levels_down() {
    let all = named(&[
        ("Alex Example", true),
        ("Test Guest A", false),
        ("Test Guest B", false),
    ]);
    let without = named(&[("Alex Example", true), ("Test Guest A", false)]);

    // As captured: the button is three levels down.
    let mut root = fixture(PANEL);
    assert_eq!(menu_depth(renamed_row(&mut root)), Some(3));
    assert_eq!(panel_names(&root), all);

    // One level deeper is still a row.
    let mut root = fixture(PANEL);
    let row = renamed_row(&mut root);
    let menu = row.children.pop().unwrap();
    row.children.push(Node {
        role: Some("AXGroup".into()),
        children: vec![menu],
        ..Node::default()
    });
    assert_eq!(menu_depth(row), Some(4));
    assert_eq!(panel_names(&root), all);

    // Two levels deeper is too far to belong to the row.
    let mut root = fixture(PANEL);
    let row = renamed_row(&mut root);
    let menu = row.children.pop().unwrap();
    let wrapped = Node {
        role: Some("AXGroup".into()),
        children: vec![menu],
        ..Node::default()
    };
    row.children.push(Node {
        role: Some("AXGroup".into()),
        children: vec![wrapped],
        ..Node::default()
    });
    assert_eq!(menu_depth(row), Some(5));
    assert_eq!(panel_names(&root), without);

    // Without the button a titled list child is not a person, whatever it is called.
    let mut root = fixture(PANEL);
    let row = renamed_row(&mut root);
    row.children.pop();
    assert_eq!(menu_depth(row), None);
    assert_eq!(panel_names(&root), without);
}

#[test]
fn the_heading_is_refused_in_any_language_and_a_row_is_kept_under_any_name() {
    let mut root = fixture(PANEL);
    let list = people_list(&mut root);
    // Another wording of the heading, and a participant who took the heading's words as a name.
    list.children[1].title = Some("Audio fusionné".into());
    list.children[1].description = Some("Audio fusionné".into());
    list.children[1].children[0].value = Some("Audio fusionné".into());
    list.children[3].title = Some("Merged audio".into());
    list.children[3].description = Some("Merged audio".into());
    assert_eq!(
        panel_names(&root),
        named(&[
            ("Alex Example", true),
            ("Test Guest A", false),
            ("Merged audio", false)
        ])
    );
}

#[test]
fn a_list_of_headings_only_gives_nobody() {
    let mut root = fixture(PANEL);
    let list = people_list(&mut root);
    let heading = list.children[1].clone();
    list.children = vec![heading.clone(), heading];
    let extraction = read(App::GoogleMeet, &root).unwrap();
    assert_eq!(names(&extraction, "meet-people-panel"), named(&[]));
    // The page is still in a call; only the panel has nobody.
    assert_ne!(read(App::GoogleMeet, &root), Err(Skip::NotInCall));
}
