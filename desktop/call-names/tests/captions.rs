//! Nothing under Meet's live captions region is ever read.
//!
//! The fixture is a solo call with captions on. Its caption block is labelled with the
//! speaker's name ("Alex Example" stands for the real name), so captions really do hold names; the
//! rules must find names only in the tiles and the People panel.

mod common;

use call_names::roster::Roster;
use call_names::rules::App;
use call_names::session::{Budget, Target};
use call_names::tree::Node;
use common::*;
use std::collections::HashSet;

fn addresses(region: &Node) -> HashSet<*const Node> {
    region
        .descendants()
        .into_iter()
        .skip(1)
        .map(|node| node as *const Node)
        .collect()
}

/// Reads one tick and checks that no read of any kind touched a node below the region.
fn read_around(root: &Node, region: &Node) -> call_names::extract::Extraction {
    let below = addresses(region);
    assert!(!below.is_empty());
    let mut source = Recording::new();
    let extraction = read_with(
        &mut source,
        &[Target {
            app: App::GoogleMeet,
            root,
        }],
        Budget::DEFAULT,
    )
    .unwrap();
    assert!(
        source
            .text_reads
            .iter()
            .all(|(node, _)| !below.contains(node)),
        "text was read under the region"
    );
    assert!(
        source
            .structure_reads
            .iter()
            .all(|node| !below.contains(node)),
        "the region was entered"
    );
    extraction
}

#[test]
fn captions_with_a_name_are_never_read() {
    let root = fixture("meet-captions-on");
    let region = find(&root, |node| is_region(node, "Captions")).unwrap();
    assert!(region
        .descendants()
        .iter()
        .any(|node| node.value.as_deref() == Some("Alex Example")));
    let extraction = read_around(&root, region);
    // The same person shows in two tiles here; the roster keeps one person.
    assert_eq!(
        names(&extraction, "meet-tiles"),
        named(&[("Alex Example", false), ("Alex Example", false)])
    );
    let mut roster = Roster::new();
    roster.observe(0, &extraction);
    assert_eq!(roster.people().len(), 1);
}

/// Move the captions region into main and give its speaker label a name found nowhere else.
fn captions_inside_main(label: &str) -> Node {
    let mut root = fixture("meet-captions-on");
    let mut region = take(&mut root, &|node: &Node| is_region(node, "Captions")).unwrap();
    region.title = Some(label.into());
    region.description = Some(label.into());
    let speaker = find_mut(&mut region, &|node: &Node| {
        node.value.as_deref() == Some("Alex Example")
    })
    .unwrap();
    speaker.value = Some("Caption Speaker".into());
    let main = find_mut(&mut root, &|node: &Node| {
        node.subrole.as_deref() == Some("AXLandmarkMain")
    })
    .unwrap();
    main.children.insert(0, region);
    root
}

#[test]
fn captions_moved_inside_main_are_still_not_read() {
    let root = captions_inside_main("Captions");
    let region = find(&root, |node| is_region(node, "Captions")).unwrap();
    let extraction = read_around(&root, region);
    assert!(extraction
        .entries()
        .all(|entry| entry.name.as_str() != "Caption Speaker"));
    assert_eq!(
        names(&extraction, "meet-tiles")[0],
        ("Alex Example".to_owned(), false)
    );
}

#[test]
fn a_relabelled_captions_region_inside_main_is_skipped_by_structure() {
    // A wording or language change defeats the label prune; the tile rule still skips every
    // landmark below main.
    let root = captions_inside_main("Untertitel");
    let region = find(&root, |node| is_region(node, "Untertitel")).unwrap();
    let below = addresses(region);
    let mut source = Recording::new();
    let extraction = read_with(
        &mut source,
        &[Target {
            app: App::GoogleMeet,
            root: &root,
        }],
        Budget::DEFAULT,
    )
    .unwrap();
    assert!(
        source
            .text_reads
            .iter()
            .all(|(node, _)| !below.contains(node)),
        "text was read under the region"
    );
    assert!(extraction
        .entries()
        .all(|entry| entry.name.as_str() != "Caption Speaker"));
}
