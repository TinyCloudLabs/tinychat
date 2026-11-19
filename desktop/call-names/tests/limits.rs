//! A budget overrun, a cycle or a failed read yields nothing: the whole tick is discarded.

mod common;

use call_names::roster::Roster;
use call_names::rules::App;
use call_names::session::{read_tick, Budget, Discard, Meter, Skip, Target};
use call_names::tree::{Node, NodeSource, ReadError, Source, Structure, TextAttr};
use common::*;
use std::cell::Cell;
use std::time::Duration;

fn discarded(result: Result<call_names::extract::Extraction, Skip>) -> Discard {
    match result {
        Err(Skip::Discarded(discard)) => discard,
        other => panic!("expected a discarded tick, got {other:?}"),
    }
}

#[test]
fn every_fixture_fits_the_default_budget() {
    for (fixture_name, app) in [
        ("meet-people-panel", App::GoogleMeet),
        ("meet-layout-tiled", App::GoogleMeet),
        ("meet-layout-auto", App::GoogleMeet),
        ("meet-captions-on", App::GoogleMeet),
        ("meet-pip-placeholder", App::GoogleMeet),
        ("meet-speech-people-open", App::GoogleMeet),
        ("meet-two-people-tiles", App::GoogleMeet),
        ("meet-two-people-panel", App::GoogleMeet),
        ("zoom-participants-panel", App::Zoom),
        ("zoom-tiles", App::Zoom),
    ] {
        assert!(read(app, &fixture(fixture_name)).is_ok(), "{fixture_name}");
    }
}

#[test]
fn too_many_nodes_discard_the_tick() {
    let root = fixture("meet-people-panel");
    let budget = Budget {
        max_nodes: 100,
        ..Budget::DEFAULT
    };
    let result = read_with(
        &mut NodeSource::new(),
        &[Target {
            app: App::GoogleMeet,
            root: &root,
        }],
        budget,
    );
    assert_eq!(discarded(result), Discard::NodeCap);
}

/// A window whose static text sits `depth` levels below the root.
fn chain(depth: usize) -> Node {
    let mut node = Node {
        role: Some("AXStaticText".into()),
        value: Some("Alex Example".into()),
        ..Node::default()
    };
    for _ in 0..depth {
        node = Node {
            role: Some("AXGroup".into()),
            children: vec![node],
            ..Node::default()
        };
    }
    let tab = Node {
        role: Some("AXTabGroup".into()),
        description: Some("Alex Example".into()),
        children: vec![
            Node {
                role: Some("AXButton".into()),
                description: Some("Alex Example".into()),
                ..Node::default()
            },
            node,
        ],
        ..Node::default()
    };
    Node {
        role: Some("AXWindow".into()),
        identifier: Some("zm.meeting.window.main".into()),
        children: vec![tab],
        ..Node::default()
    }
}

#[test]
fn a_node_deeper_than_80_discards_the_tick() {
    // window (0) > tab group (1) > groups (2..) > text: the text is at depth 2 + groups.
    assert!(read(App::Zoom, &chain(78)).is_ok());
    assert_eq!(discarded(read(App::Zoom, &chain(79))), Discard::Depth);
    let root = fixture("meet-people-panel");
    let budget = Budget {
        max_depth: 10,
        ..Budget::DEFAULT
    };
    let result = read_with(
        &mut NodeSource::new(),
        &[Target {
            app: App::GoogleMeet,
            root: &root,
        }],
        budget,
    );
    assert_eq!(discarded(result), Discard::Depth);
}

/// Every read costs 10 ms of a fake clock.
struct Slow<'a, 'c> {
    inner: NodeSource<'a>,
    now: &'c Cell<Duration>,
}

impl<'a> Source for Slow<'a, '_> {
    type Node = &'a Node;

    fn structure(&mut self, node: &&'a Node) -> Result<(Structure, Vec<&'a Node>), ReadError> {
        self.now.set(self.now.get() + Duration::from_millis(10));
        self.inner.structure(node)
    }

    fn texts(
        &mut self,
        node: &&'a Node,
        attrs: &[TextAttr],
    ) -> Result<Vec<Option<String>>, ReadError> {
        self.now.set(self.now.get() + Duration::from_millis(10));
        self.inner.texts(node, attrs)
    }

    fn identity_hash(&self, node: &&'a Node) -> u64 {
        self.inner.identity_hash(node)
    }

    fn same(&self, a: &&'a Node, b: &&'a Node) -> bool {
        self.inner.same(a, b)
    }
}

#[test]
fn running_out_of_time_discards_the_tick() {
    let root = fixture("meet-people-panel");
    let now = Cell::new(Duration::ZERO);
    let clock = || now.get();
    let mut meter = Meter::new(Budget::DEFAULT, &clock);
    let mut source = Slow {
        inner: NodeSource::new(),
        now: &now,
    };
    let result = read_tick(
        &rules(),
        &mut source,
        &[Target {
            app: App::GoogleMeet,
            root: &root,
        }],
        &mut meter,
    );
    assert_eq!(discarded(result), Discard::Time);
    assert!(
        now.get() <= Duration::from_millis(270),
        "stopped soon after the budget"
    );

    // The same window with a frozen clock reads fine, and a discarded tick never reaches a roster.
    let mut roster = Roster::new();
    if let Ok(extraction) = read(App::GoogleMeet, &root) {
        assert!(roster.observe(0, &extraction));
    }
    assert_eq!(roster.people().len(), 1);
}

/// Zoom's meeting window with one tile and a toolbar: 0 window, 1 tab group, 2 its button,
/// 3 toolbar, 4 a toolbar button. Tests add the loops.
fn zoom_with_toolbar() -> Arena {
    Arena::of(vec![
        Arena::zoom_window(&[1, 3]),
        Arena::described("AXTabGroup", "Alex Example, Computer audio muted", &[2]),
        Arena::described("AXButton", "Alex Example", &[]),
        Arena::node("AXGroup", &[4]),
        Arena::described("AXButton", "Mute", &[]),
    ])
}

fn zoom_target() -> [Target<usize>; 1] {
    [Target {
        app: App::Zoom,
        root: 0,
    }]
}

#[test]
fn a_toolbar_that_leads_back_to_the_window_does_not_cost_the_tick() {
    // Zoom's toolbar lists an ancestor among its children. The repeat is skipped, so the tile is
    // still read.
    let mut arena = zoom_with_toolbar();
    arena.nodes[3].children = vec![4, 0, 3];
    let extraction = read_with(&mut arena, &zoom_target(), Budget::DEFAULT).unwrap();
    assert_eq!(
        names(&extraction, "zoom-tiles"),
        named(&[("Alex Example", false)])
    );
    // Each element was read once: the repeats were not read again.
    let mut reads = arena.structure_reads.clone();
    reads.sort_unstable();
    assert_eq!(reads, [0, 1, 2, 3, 4]);
}

#[test]
fn an_element_under_two_parents_is_read_once() {
    // The tile's button is also listed by the toolbar, and twice by its own parent.
    let mut arena = zoom_with_toolbar();
    arena.nodes[1].children = vec![2, 2];
    arena.nodes[3].children = vec![4, 2];
    let extraction = read_with(&mut arena, &zoom_target(), Budget::DEFAULT).unwrap();
    assert_eq!(
        names(&extraction, "zoom-tiles"),
        named(&[("Alex Example", false)])
    );
    assert_eq!(
        arena
            .structure_reads
            .iter()
            .filter(|&&node| node == 2)
            .count(),
        1
    );
}

#[test]
fn repeated_elements_still_count_against_the_node_budget() {
    // An element that lists itself a thousand times cannot be walked for free.
    let mut arena = zoom_with_toolbar();
    arena.nodes[3].children = vec![3; 1000];
    let budget = Budget {
        max_nodes: 200,
        ..Budget::DEFAULT
    };
    let result = read_with(&mut arena, &zoom_target(), budget);
    assert_eq!(discarded(result), Discard::NodeCap);
}

#[test]
fn children_are_capped_at_the_room_left_in_the_node_budget() {
    // The source is told how many children are worth making: the room left plus one, so that a
    // node with too many children still overruns the budget.
    let mut arena = zoom_with_toolbar();
    arena.nodes[3].children = (0..5000).map(|_| 4).collect();
    let budget = Budget {
        max_nodes: 50,
        ..Budget::DEFAULT
    };
    let result = read_with(&mut arena, &zoom_target(), budget);
    assert_eq!(discarded(result), Discard::NodeCap);
    assert_eq!(arena.child_limits[0], 50, "the root: 49 left, plus one");
    assert!(arena.child_limits.iter().all(|&limit| limit <= 50));

    // With room to spare nothing is cut.
    let mut arena = zoom_with_toolbar();
    let extraction = read_with(&mut arena, &zoom_target(), Budget::DEFAULT).unwrap();
    assert_eq!(
        names(&extraction, "zoom-tiles"),
        named(&[("Alex Example", false)])
    );
    assert_eq!(arena.child_limits[0], Budget::DEFAULT.max_nodes);
}

/// Fails one kind of read with the given error.
struct Failing<'a> {
    inner: NodeSource<'a>,
    texts_fail: Option<ReadError>,
    structure_fails: Option<ReadError>,
}

impl<'a> Source for Failing<'a> {
    type Node = &'a Node;

    fn structure(&mut self, node: &&'a Node) -> Result<(Structure, Vec<&'a Node>), ReadError> {
        match self.structure_fails {
            Some(error) if node.role.as_deref() == Some("AXList") => Err(error),
            _ => self.inner.structure(node),
        }
    }

    fn texts(
        &mut self,
        node: &&'a Node,
        attrs: &[TextAttr],
    ) -> Result<Vec<Option<String>>, ReadError> {
        match self.texts_fail {
            Some(error) if node.role.as_deref() == Some("AXStaticText") => Err(error),
            _ => self.inner.texts(node, attrs),
        }
    }

    fn identity_hash(&self, node: &&'a Node) -> u64 {
        self.inner.identity_hash(node)
    }

    fn same(&self, a: &&'a Node, b: &&'a Node) -> bool {
        self.inner.same(a, b)
    }
}

#[test]
fn a_failed_read_discards_the_tick() {
    let root = fixture("meet-people-panel");
    let targets = [Target {
        app: App::GoogleMeet,
        root: &root,
    }];
    let mut timeout = Failing {
        inner: NodeSource::new(),
        texts_fail: Some(ReadError::Timeout),
        structure_fails: None,
    };
    assert_eq!(
        discarded(read_with(&mut timeout, &targets, Budget::DEFAULT)),
        Discard::Read(ReadError::Timeout)
    );
    let mut gone = Failing {
        inner: NodeSource::new(),
        texts_fail: None,
        structure_fails: Some(ReadError::Gone),
    };
    assert_eq!(
        discarded(read_with(&mut gone, &targets, Budget::DEFAULT)),
        Discard::Read(ReadError::Gone)
    );
}

#[test]
fn revoked_access_is_reported_as_not_trusted() {
    let root = fixture("meet-people-panel");
    let targets = [Target {
        app: App::GoogleMeet,
        root: &root,
    }];
    let mut revoked = Failing {
        inner: NodeSource::new(),
        texts_fail: None,
        structure_fails: Some(ReadError::NotTrusted),
    };
    assert_eq!(
        discarded(read_with(&mut revoked, &targets, Budget::DEFAULT)),
        Discard::Read(ReadError::NotTrusted)
    );
}
