//! The Accessibility node model.
//!
//! [`Node`] is an owned tree: what a fixture loads and what a snapshot prints. It has no class-list
//! or DOM-id field on purpose, so obfuscated page classes can never become rule anchors: no path
//! step can match a class, and [`Structure`] has no class field either.
//!
//! [`Source`] is how a reading walks a live window: one node at a time, structure first, so that
//! text is requested only where a rule needs it (see `extract`). [`NodeSource`] implements it over
//! an owned [`Node`] tree.
//!
//! Class lists, narrowly. [`Source::class_list`] is the one way a class list is read, and only the
//! speaking marker uses it (see `speaking`): once per marker candidate that a structural path
//! already selected, during a names tick, and once per followed marker in each speaking sample. A
//! class list becomes a [`ClassSet`] at once: 64-bit hashes of at most [`MAX_CLASSES`] tokens,
//! never the tokens themselves. It is compared and dropped; it cannot be serialized, and its
//! `Debug` shows only how many tokens it has.

use serde::{Deserialize, Serialize};
use std::fmt;

/// One Accessibility element and its children.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

impl Node {
    pub fn text(&self, attr: TextAttr) -> Option<&str> {
        match attr {
            TextAttr::Title => self.title.as_deref(),
            TextAttr::Description => self.description.as_deref(),
            TextAttr::Value => self.value.as_deref(),
        }
    }

    /// This node and every node below it, in document order.
    pub fn descendants(&self) -> Vec<&Node> {
        let mut out = Vec::new();
        let mut stack = vec![self];
        while let Some(node) = stack.pop() {
            out.push(node);
            stack.extend(node.children.iter().rev());
        }
        out
    }
}

/// Text can hold names, so `Debug` shows only its length.
impl fmt::Debug for Node {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let len = |text: &Option<String>| text.as_ref().map(|text| text.chars().count());
        f.debug_struct("Node")
            .field("role", &self.role)
            .field("subrole", &self.subrole)
            .field("identifier", &self.identifier)
            .field("title_chars", &len(&self.title))
            .field("description_chars", &len(&self.description))
            .field("value_chars", &len(&self.value))
            .field("url", &self.url.as_ref().map(|_| "<url>"))
            .field("children", &self.children)
            .finish()
    }
}

/// Text attributes. A reading asks for them only where a rule needs them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAttr {
    Title,
    Description,
    Value,
}

/// What a reading learns about every node in scope.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Structure {
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub identifier: Option<String>,
}

/// A read that failed. Any of these discards the tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// This process may not use Accessibility: permission missing or revoked.
    NotTrusted,
    /// The app did not answer within the messaging timeout.
    Timeout,
    /// The element no longer exists.
    Gone,
    /// Any other failure, with the platform's error code.
    Failed(i32),
}

/// A window that can be read lazily, one node at a time.
pub trait Source {
    type Node: Clone;

    /// Role, subrole, identifier and children of one node.
    fn structure(&mut self, node: &Self::Node) -> Result<(Structure, Vec<Self::Node>), ReadError>;

    /// As [`Source::structure`], but the source may stop after `max_children` children. A reading
    /// passes its remaining node budget plus one, so a node with more children than the budget
    /// has room for still overruns it, without a call per child first. The default reads all.
    fn structure_capped(
        &mut self,
        node: &Self::Node,
        max_children: usize,
    ) -> Result<(Structure, Vec<Self::Node>), ReadError> {
        let _ = max_children;
        self.structure(node)
    }

    /// The requested text attributes of one node, in the order asked. Strings only.
    fn texts(
        &mut self,
        node: &Self::Node,
        attrs: &[TextAttr],
    ) -> Result<Vec<Option<String>>, ReadError>;

    /// The class list of one node (`AXDOMClassList` on macOS), as hashes. Only the speaking marker
    /// asks for it, and only on a node a structural path selected. `Ok(None)`: the node has no
    /// class list, or this source cannot read class lists at all, which is the default.
    fn class_list(&mut self, node: &Self::Node) -> Result<Option<ClassSet>, ReadError> {
        let _ = node;
        Ok(None)
    }

    /// Identity, for cycle checks: equal elements must hash equal (`CFHash` on macOS).
    fn identity_hash(&self, node: &Self::Node) -> u64;

    /// True when both handles are the same element (`CFEqual` on macOS).
    fn same(&self, a: &Self::Node, b: &Self::Node) -> bool;
}

/// Most tokens a [`ClassSet`] holds. A speaking marker has three or four; an element with more
/// is not one.
pub const MAX_CLASSES: usize = 16;

/// The class list of one element, as 64-bit hashes of its tokens, sorted and without repeats.
///
/// The tokens themselves are never kept: [`ClassSet::from_tokens`] hashes each one and drops it.
/// A set is compared and dropped; it is not `Serialize`, and its `Debug` shows only the count.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ClassSet(Vec<u64>);

impl ClassSet {
    /// The set of these tokens. `None` when there are more than [`MAX_CLASSES`] distinct ones.
    pub fn from_tokens<'t>(tokens: impl IntoIterator<Item = &'t str>) -> Option<ClassSet> {
        let mut hashes: Vec<u64> = tokens.into_iter().map(class_hash).collect();
        hashes.sort_unstable();
        hashes.dedup();
        (hashes.len() <= MAX_CLASSES).then_some(ClassSet(hashes))
    }

    /// Tokens in the set.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// True when the set holds the token of this hash (see [`class_hash`]).
    pub fn contains(&self, hash: u64) -> bool {
        self.0.binary_search(&hash).is_ok()
    }

    /// True when every token of `other` is in this set.
    pub fn contains_all(&self, other: &ClassSet) -> bool {
        other.0.iter().all(|hash| self.contains(*hash))
    }

    /// One hash for the whole set, the same for the same tokens in any order.
    pub fn fingerprint(&self) -> u64 {
        self.0
            .iter()
            .fold(FNV_OFFSET, |hash, token| fnv(hash, &token.to_le_bytes()))
    }
}

/// Only the count: hashes of class tokens are not shown either.
impl fmt::Debug for ClassSet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ClassSet(<{} classes>)", self.0.len())
    }
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

fn fnv(hash: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(hash, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// The hash a [`ClassSet`] keeps for a token (64-bit FNV-1a). The rules hash their tokens the same
/// way, so a set is compared with them without holding a token.
pub fn class_hash(token: &str) -> u64 {
    fnv(FNV_OFFSET, token.as_bytes())
}

/// [`Source`] over an owned [`Node`] tree.
#[derive(Clone, Copy, Debug, Default)]
pub struct NodeSource<'a>(std::marker::PhantomData<&'a Node>);

impl NodeSource<'_> {
    pub fn new() -> Self {
        Self(std::marker::PhantomData)
    }
}

impl<'a> Source for NodeSource<'a> {
    type Node = &'a Node;

    fn structure(&mut self, node: &&'a Node) -> Result<(Structure, Vec<&'a Node>), ReadError> {
        let structure = Structure {
            role: node.role.clone(),
            subrole: node.subrole.clone(),
            identifier: node.identifier.clone(),
        };
        Ok((structure, node.children.iter().collect()))
    }

    fn texts(
        &mut self,
        node: &&'a Node,
        attrs: &[TextAttr],
    ) -> Result<Vec<Option<String>>, ReadError> {
        Ok(attrs
            .iter()
            .map(|attr| node.text(*attr).map(str::to_owned))
            .collect())
    }

    fn identity_hash(&self, node: &&'a Node) -> u64 {
        *node as *const Node as usize as u64
    }

    fn same(&self, a: &&'a Node, b: &&'a Node) -> bool {
        std::ptr::eq(*a, *b)
    }
}

/// The flat form of ax-probe captures and `examples/snapshot.rs` output: one object per node with
/// its path (`root.0.3`), depth and short keys. `tools/scrub.py` turns captures into fixtures.
pub mod flat {
    use super::Node;
    use crate::names::json_error;
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;

    /// One node. Other keys in a capture (`cls`, `help`, `AXEnabled`, …) are ignored on read.
    #[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
    pub struct FlatNode {
        pub p: String,
        #[serde(default)]
        pub d: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub r: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub sr: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub t: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub desc: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub v: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub url: Option<String>,
    }

    /// Text can hold names, so `Debug` shows only its length.
    impl std::fmt::Debug for FlatNode {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            let len = |text: &Option<String>| text.as_ref().map(|text| text.chars().count());
            f.debug_struct("FlatNode")
                .field("p", &shown_path(&self.p))
                .field("d", &self.d)
                .field("r", &self.r)
                .field("sr", &self.sr)
                .field("id", &self.id)
                .field("t_chars", &len(&self.t))
                .field("desc_chars", &len(&self.desc))
                .field("v_chars", &len(&self.v))
                .field("url", &self.url.as_ref().map(|_| "<url>"))
                .finish()
        }
    }

    /// Why a capture did not load. No variant carries text from the capture except a well-formed
    /// node path: `Json` holds only the kind of error and its line and column.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum FlatError {
        Json(String),
        NoFullLine,
        BadPath(String),
        MissingParent(String),
    }

    /// A node path as it may be shown: itself when it is only letters, digits and dots, else its
    /// length.
    fn shown_path(path: &str) -> String {
        if path
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.')
        {
            path.to_owned()
        } else {
            format!("<{} chars>", path.chars().count())
        }
    }

    impl std::fmt::Display for FlatError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                FlatError::Json(error) => write!(f, "not a capture: {error}"),
                FlatError::NoFullLine => write!(f, "capture has no \"full\" line"),
                FlatError::BadPath(path) => write!(f, "bad node path {path:?}"),
                FlatError::MissingParent(path) => {
                    write!(f, "node {path:?} has no parent in the capture")
                }
            }
        }
    }

    impl std::error::Error for FlatError {}

    #[derive(Deserialize)]
    struct Line {
        kind: String,
        #[serde(default)]
        nodes: Vec<FlatNode>,
    }

    /// The trees of the first `full` line of a JSONL capture, one per root, in root order.
    pub fn roots_from_jsonl(text: &str) -> Result<Vec<(String, Node)>, FlatError> {
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let line: Line =
                serde_json::from_str(line).map_err(|error| FlatError::Json(json_error(&error)))?;
            if line.kind == "full" {
                return from_flat(&line.nodes);
            }
        }
        Err(FlatError::NoFullLine)
    }

    /// Rebuild trees from flat nodes. Children keep their index order; gaps are allowed.
    pub fn from_flat(nodes: &[FlatNode]) -> Result<Vec<(String, Node)>, FlatError> {
        type Key = (String, Vec<usize>);
        let mut keyed: BTreeMap<Key, &FlatNode> = BTreeMap::new();
        for node in nodes {
            keyed.insert(path_key(&node.p)?, node);
        }
        // Build bottom-up: the deepest paths first, attaching each node to its parent.
        let mut built: BTreeMap<Key, Node> = BTreeMap::new();
        let mut keys: Vec<Key> = keyed.keys().cloned().collect();
        keys.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| b.cmp(a)));
        for key in keys {
            let flat = keyed[&key];
            let mut node = built.remove(&key).unwrap_or_default();
            node.role = flat.r.clone();
            node.subrole = flat.sr.clone();
            node.identifier = flat.id.clone();
            node.title = flat.t.clone();
            node.description = flat.desc.clone();
            node.value = flat.v.clone();
            node.url = flat.url.clone();
            if key.1.is_empty() {
                built.insert(key, node);
                continue;
            }
            let parent_key = (key.0.clone(), key.1[..key.1.len() - 1].to_vec());
            if !keyed.contains_key(&parent_key) {
                return Err(FlatError::MissingParent(shown_path(&flat.p)));
            }
            // Keys are visited in reverse order, so children arrive last-first.
            built
                .entry(parent_key)
                .or_default()
                .children
                .insert(0, node);
        }
        Ok(built
            .into_iter()
            .filter(|(key, _)| key.1.is_empty())
            .map(|(key, node)| (key.0, node))
            .collect())
    }

    /// Flat nodes of one tree, in document order, under the given root label.
    pub fn to_flat(root: &Node, label: &str) -> Vec<FlatNode> {
        let mut out = Vec::new();
        let mut stack = vec![(root, label.to_owned(), 0usize)];
        while let Some((node, path, depth)) = stack.pop() {
            for (index, child) in node.children.iter().enumerate().rev() {
                stack.push((child, format!("{path}.{index}"), depth + 1));
            }
            out.push(FlatNode {
                p: path,
                d: depth,
                r: node.role.clone(),
                sr: node.subrole.clone(),
                id: node.identifier.clone(),
                t: node.title.clone(),
                desc: node.description.clone(),
                v: node.value.clone(),
                url: node.url.clone(),
            });
        }
        out
    }

    fn path_key(path: &str) -> Result<(String, Vec<usize>), FlatError> {
        let mut parts = path.split('.');
        let root = parts
            .next()
            .filter(|root| !root.is_empty())
            .ok_or_else(|| FlatError::BadPath(shown_path(path)))?;
        let indexes = parts
            .map(|part| {
                part.parse::<usize>()
                    .map_err(|_| FlatError::BadPath(shown_path(path)))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok((root.to_owned(), indexes))
    }
}

#[cfg(test)]
mod tests {
    use super::flat::{from_flat, roots_from_jsonl, to_flat, FlatError, FlatNode};
    use super::*;

    fn leaf(role: &str, value: &str) -> Node {
        Node {
            role: Some(role.into()),
            value: Some(value.into()),
            ..Node::default()
        }
    }

    #[test]
    fn flat_round_trip_keeps_order_and_fields() {
        let tree = Node {
            role: Some("AXWindow".into()),
            identifier: Some("zm.meeting.window.main".into()),
            children: vec![
                Node {
                    role: Some("AXGroup".into()),
                    children: vec![leaf("AXStaticText", "a"), leaf("AXStaticText", "b")],
                    ..Node::default()
                },
                leaf("AXStaticText", "c"),
            ],
            ..Node::default()
        };
        let flat = to_flat(&tree, "w0");
        let paths: Vec<&str> = flat.iter().map(|node| node.p.as_str()).collect();
        assert_eq!(paths, ["w0", "w0.0", "w0.0.0", "w0.0.1", "w0.1"]);
        assert_eq!(flat[2].d, 2);
        let rebuilt = from_flat(&flat).unwrap();
        assert_eq!(rebuilt, vec![("w0".to_owned(), tree)]);
    }

    #[test]
    fn flat_children_sort_numerically_and_allow_gaps() {
        let node = |p: &str, v: &str| FlatNode {
            p: p.into(),
            v: Some(v.into()),
            ..FlatNode::default()
        };
        let flat = vec![
            node("r.10", "ten"),
            node("r", "root"),
            node("r.2", "two"),
            node("r.0", "zero"),
        ];
        let (_, tree) = from_flat(&flat).unwrap().remove(0);
        let values: Vec<_> = tree
            .children
            .iter()
            .map(|child| child.value.as_deref().unwrap())
            .collect();
        assert_eq!(values, ["zero", "two", "ten"]);
    }

    #[test]
    fn flat_rejects_orphans_and_bad_paths() {
        let node = |p: &str| FlatNode {
            p: p.into(),
            ..FlatNode::default()
        };
        assert_eq!(
            from_flat(&[node("r"), node("r.0.1")]),
            Err(FlatError::MissingParent("r.0.1".into()))
        );
        assert_eq!(
            from_flat(&[node("r.x")]),
            Err(FlatError::BadPath("r.x".into()))
        );
        assert_eq!(
            roots_from_jsonl("{\"kind\":\"meta\"}\n"),
            Err(FlatError::NoFullLine)
        );
        assert!(matches!(
            roots_from_jsonl("not json"),
            Err(FlatError::Json(_))
        ));
    }

    #[test]
    fn flat_debug_and_errors_never_show_capture_text() {
        let node = FlatNode {
            p: "r.0".into(),
            r: Some("AXStaticText".into()),
            t: Some("Zebra Quartz".into()),
            desc: Some("Zebra Quartz".into()),
            v: Some("Zebra Quartz".into()),
            url: Some("https://example.org/zebra".into()),
            ..FlatNode::default()
        };
        let shown = format!("{node:?} {:?}", vec![node.clone()]);
        for secret in ["Zebra", "Quartz", "example.org"] {
            assert!(!shown.contains(secret), "{shown}");
        }
        assert!(shown.contains("v_chars: Some(12)"), "{shown}");
        assert!(shown.contains("AXStaticText"), "{shown}");

        // serde would quote the offending string; the error keeps only kind and position.
        let line = r#"{"kind":"full","nodes":[{"p":"r","d":"Zebra Quartz"}]}"#;
        let error = roots_from_jsonl(line).unwrap_err();
        let shown = format!("{error} {error:?}");
        assert!(
            !shown.contains("Zebra") && !shown.contains("Quartz"),
            "{shown}"
        );
        assert!(
            matches!(&error, FlatError::Json(what) if what.starts_with("data error at line 1, column ")),
            "{error:?}"
        );

        // A path that is not a path is not echoed either.
        let bad = FlatNode {
            p: "Zebra Quartz.x".into(),
            ..FlatNode::default()
        };
        let error = from_flat(std::slice::from_ref(&bad)).unwrap_err();
        assert_eq!(error, FlatError::BadPath("<14 chars>".into()));
        assert!(!format!("{bad:?}").contains("Zebra"));
    }

    #[test]
    fn debug_never_prints_text() {
        let node = Node {
            role: Some("AXStaticText".into()),
            value: Some("Alex Example".into()),
            ..Node::default()
        };
        let shown = format!("{node:?}");
        assert!(!shown.contains("Alex"), "{shown}");
        assert!(shown.contains("value_chars: Some(12)"), "{shown}");
    }
}
