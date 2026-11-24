//! Helpers shared by the integration tests.
#![allow(dead_code)]

use call_names::extract::Extraction;
use call_names::rules::{App, Rules};
use call_names::session::{read_tick, Budget, Meter, Skip, Target};
use call_names::tree::{flat, Node, NodeSource, ReadError, Source, Structure, TextAttr};
use std::time::Duration;

pub const FAKE_NAMES: [&str; 3] = ["Alex Example", "Test Guest A", "Test Guest B"];

pub fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// The only root of a scrubbed capture.
pub fn fixture(name: &str) -> Node {
    let path = fixture_dir().join(format!("{name}.jsonl"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let mut roots = flat::roots_from_jsonl(&text).unwrap();
    assert_eq!(roots.len(), 1, "{name}: expected one root");
    roots.remove(0).1
}

pub fn rules() -> Rules {
    Rules::embedded().unwrap()
}

/// A clock that never moves, so fixture tests do not depend on machine speed.
pub fn frozen() -> impl Fn() -> Duration {
    || Duration::ZERO
}

pub fn read_with<S: Source>(
    source: &mut S,
    targets: &[Target<S::Node>],
    budget: Budget,
) -> Result<Extraction, Skip> {
    let clock = frozen();
    let mut meter = Meter::new(budget, &clock);
    read_tick(&rules(), source, targets, &mut meter)
}

/// One tick over one owned tree with the embedded rules and the default budget.
pub fn read(app: App, root: &Node) -> Result<Extraction, Skip> {
    read_with(
        &mut NodeSource::new(),
        &[Target { app, root }],
        Budget::DEFAULT,
    )
}

/// The names of one source as `(name, self)`.
pub fn names(extraction: &Extraction, source: &str) -> Vec<(String, bool)> {
    extraction
        .source(source)
        .unwrap_or_else(|| panic!("no source {source}"))
        .entries
        .iter()
        .map(|entry| (entry.name.as_str().to_owned(), entry.is_self))
        .collect()
}

pub fn named(list: &[(&str, bool)]) -> Vec<(String, bool)> {
    list.iter()
        .map(|(name, is_self)| ((*name).to_owned(), *is_self))
        .collect()
}

/// The first node, in document order, that satisfies `test`.
pub fn find(root: &Node, test: impl Fn(&Node) -> bool) -> Option<&Node> {
    root.descendants().into_iter().find(|node| test(node))
}

pub fn is_region(node: &Node, label: &str) -> bool {
    node.subrole.as_deref() == Some("AXLandmarkRegion") && node.title.as_deref() == Some(label)
}

/// Remove and return the first node below `root` that satisfies `test`.
pub fn take(root: &mut Node, test: &impl Fn(&Node) -> bool) -> Option<Node> {
    if let Some(index) = root.children.iter().position(test) {
        return Some(root.children.remove(index));
    }
    root.children.iter_mut().find_map(|child| take(child, test))
}

/// The first node below `root` that satisfies `test`, mutably.
pub fn find_mut<'a>(root: &'a mut Node, test: &impl Fn(&Node) -> bool) -> Option<&'a mut Node> {
    if test(root) {
        return Some(root);
    }
    root.children
        .iter_mut()
        .find_map(|child| find_mut(child, test))
}

/// Records every read, by node address.
pub struct Recording<'a> {
    inner: NodeSource<'a>,
    pub structure_reads: Vec<*const Node>,
    pub text_reads: Vec<(*const Node, Vec<TextAttr>)>,
}

impl<'a> Recording<'a> {
    pub fn new() -> Self {
        Recording {
            inner: NodeSource::new(),
            structure_reads: Vec::new(),
            text_reads: Vec::new(),
        }
    }
}

impl<'a> Source for Recording<'a> {
    type Node = &'a Node;

    fn structure(&mut self, node: &&'a Node) -> Result<(Structure, Vec<&'a Node>), ReadError> {
        self.structure_reads.push(*node as *const Node);
        self.inner.structure(node)
    }

    fn texts(
        &mut self,
        node: &&'a Node,
        attrs: &[TextAttr],
    ) -> Result<Vec<Option<String>>, ReadError> {
        self.text_reads.push((*node as *const Node, attrs.to_vec()));
        self.inner.texts(node, attrs)
    }

    fn identity_hash(&self, node: &&'a Node) -> u64 {
        self.inner.identity_hash(node)
    }

    fn same(&self, a: &&'a Node, b: &&'a Node) -> bool {
        self.inner.same(a, b)
    }
}

/// A window given as numbered elements, so children can point back at an ancestor.
#[derive(Default)]
pub struct Arena {
    pub nodes: Vec<ArenaNode>,
    /// Structure reads, by element.
    pub structure_reads: Vec<usize>,
    /// The child limit of each structure read.
    pub child_limits: Vec<usize>,
}

#[derive(Clone, Default)]
pub struct ArenaNode {
    pub structure: Structure,
    pub children: Vec<usize>,
    pub description: Option<String>,
    pub value: Option<String>,
}

impl Arena {
    pub fn of(nodes: Vec<ArenaNode>) -> Self {
        Arena {
            nodes,
            ..Arena::default()
        }
    }

    pub fn node(role: &str, children: &[usize]) -> ArenaNode {
        ArenaNode {
            structure: Structure {
                role: Some(role.into()),
                ..Structure::default()
            },
            children: children.to_vec(),
            ..ArenaNode::default()
        }
    }

    pub fn described(role: &str, description: &str, children: &[usize]) -> ArenaNode {
        ArenaNode {
            description: Some(description.into()),
            ..Arena::node(role, children)
        }
    }

    /// Zoom's meeting window with the given children.
    pub fn zoom_window(children: &[usize]) -> ArenaNode {
        let mut window = Arena::node("AXWindow", children);
        window.structure.identifier = Some("zm.meeting.window.main".into());
        window
    }
}

impl Source for Arena {
    type Node = usize;

    fn structure(&mut self, node: &usize) -> Result<(Structure, Vec<usize>), ReadError> {
        self.structure_capped(node, usize::MAX)
    }

    fn structure_capped(
        &mut self,
        node: &usize,
        max_children: usize,
    ) -> Result<(Structure, Vec<usize>), ReadError> {
        self.structure_reads.push(*node);
        self.child_limits.push(max_children);
        let found = &self.nodes[*node];
        let children = found.children.iter().copied().take(max_children).collect();
        Ok((found.structure.clone(), children))
    }

    fn texts(
        &mut self,
        node: &usize,
        attrs: &[TextAttr],
    ) -> Result<Vec<Option<String>>, ReadError> {
        let found = &self.nodes[*node];
        Ok(attrs
            .iter()
            .map(|attr| match attr {
                TextAttr::Title => None,
                TextAttr::Description => found.description.clone(),
                TextAttr::Value => found.value.clone(),
            })
            .collect())
    }

    fn identity_hash(&self, node: &usize) -> u64 {
        // Every element in one bucket, so the equality check does the work.
        let _ = node;
        7
    }

    fn same(&self, a: &usize, b: &usize) -> bool {
        a == b
    }
}

/// A capture with its diffs, played sample by sample.
pub mod replay;
