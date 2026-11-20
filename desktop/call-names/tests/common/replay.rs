//! Plays a scrubbed capture with its diffs, sample by sample, as a window that changes over time.
//!
//! A capture is one `full` line (the window when the probe started) and one `diff` line per
//! sample (what changed, appeared or went away since the sample before). [`Replay`] starts at the
//! `full` line; [`Replay::advance`] applies the next diff. It is a [`Source`] whose elements are
//! node paths, so an element keeps its identity from one sample to the next, as an Accessibility
//! element does.
//!
//! Class lists are kept as the scrubber's stable tokens (`c` and eight hex digits). [`Replay`]
//! counts every read by kind and element, so a test can say what a reading asked for.

use call_names::tree::{ClassSet, ReadError, Source, Structure, TextAttr};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Default, Deserialize)]
pub struct ReplayNode {
    pub p: String,
    #[serde(default)]
    pub r: Option<String>,
    #[serde(default)]
    pub sr: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub t: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(default)]
    pub v: Option<String>,
    #[serde(default)]
    pub cls: Vec<String>,
}

#[derive(Deserialize)]
struct Line {
    kind: String,
    #[serde(default)]
    t: f64,
    #[serde(default)]
    nodes: Vec<ReplayNode>,
    #[serde(default)]
    changed: Vec<ReplayNode>,
    #[serde(default)]
    added: Vec<ReplayNode>,
    #[serde(default)]
    removed: Vec<String>,
}

/// One sample of the capture: its time (seconds since the `full` line) and what changed.
pub struct Diff {
    pub t: f64,
    changed: Vec<ReplayNode>,
    added: Vec<ReplayNode>,
    removed: Vec<String>,
}

/// A whole capture, as loaded.
pub struct Capture {
    pub full: Vec<ReplayNode>,
    pub diffs: Vec<Diff>,
}

impl Capture {
    pub fn load(name: &str) -> Capture {
        let path = super::fixture_dir().join(format!("{name}.jsonl"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        Capture::parse(&text)
    }

    pub fn parse(text: &str) -> Capture {
        let mut full = None;
        let mut diffs = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let line: Line = serde_json::from_str(line).expect("a capture line");
            match line.kind.as_str() {
                "full" if full.is_none() => full = Some(line.nodes),
                "diff" => diffs.push(Diff {
                    t: line.t,
                    changed: line.changed,
                    added: line.added,
                    removed: line.removed,
                }),
                _ => {}
            }
        }
        Capture {
            full: full.expect("a full line"),
            diffs,
        }
    }
}

/// What a reading asked for, element by element.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reads {
    pub structure: Vec<String>,
    pub texts: Vec<(String, Vec<TextAttr>)>,
    pub class_lists: Vec<String>,
}

impl Reads {
    pub fn total(&self) -> usize {
        self.structure.len() + self.texts.len() + self.class_lists.len()
    }
}

/// The window of a capture at one sample.
pub struct Replay {
    capture: std::rc::Rc<Capture>,
    state: HashMap<String, ReplayNode>,
    children: HashMap<String, Vec<String>>,
    root: String,
    /// Diffs applied so far.
    step: usize,
    /// Seconds since the `full` line of the sample shown now.
    pub t: f64,
    pub reads: Reads,
    /// Elements whose reads fail with this error, as an app that hangs or a tile that went away.
    pub failing: HashMap<String, ReadError>,
}

impl Replay {
    pub fn new(capture: std::rc::Rc<Capture>) -> Replay {
        let state: HashMap<String, ReplayNode> = capture
            .full
            .iter()
            .map(|node| (node.p.clone(), node.clone()))
            .collect();
        let root = capture
            .full
            .iter()
            .map(|node| node.p.clone())
            .find(|path| !path.contains('.'))
            .expect("a root");
        let mut replay = Replay {
            capture,
            state,
            children: HashMap::new(),
            root,
            step: 0,
            t: 0.0,
            reads: Reads::default(),
            failing: HashMap::new(),
        };
        replay.index();
        replay
    }

    pub fn load(name: &str) -> Replay {
        Replay::new(std::rc::Rc::new(Capture::load(name)))
    }

    pub fn root(&self) -> String {
        self.root.clone()
    }

    /// Diffs applied so far.
    pub fn step(&self) -> usize {
        self.step
    }

    /// Diffs in the capture.
    pub fn steps(&self) -> usize {
        self.capture.diffs.len()
    }

    /// Apply the next diff. False when there is none left.
    pub fn advance(&mut self) -> bool {
        let capture = self.capture.clone();
        let Some(diff) = capture.diffs.get(self.step) else {
            return false;
        };
        let structural = !diff.added.is_empty() || !diff.removed.is_empty();
        for node in diff.changed.iter().chain(&diff.added) {
            self.state.insert(node.p.clone(), node.clone());
        }
        for path in &diff.removed {
            self.state.remove(path);
        }
        self.step += 1;
        self.t = diff.t;
        if structural {
            self.index();
        }
        true
    }

    /// The node at a path now, if it exists.
    pub fn node(&self, path: &str) -> Option<&ReplayNode> {
        self.state.get(path)
    }

    /// The class tokens of the node at a path now.
    pub fn classes(&self, path: &str) -> Vec<String> {
        self.state
            .get(path)
            .map(|node| node.cls.clone())
            .unwrap_or_default()
    }

    /// The paths of the children of a node now, in index order.
    pub fn children_of(&self, path: &str) -> Vec<String> {
        self.children.get(path).cloned().unwrap_or_default()
    }

    fn index(&mut self) {
        let mut children: HashMap<String, Vec<(usize, String)>> = HashMap::new();
        for path in self.state.keys() {
            if let Some((parent, index)) = path.rsplit_once('.') {
                if self.state.contains_key(parent) {
                    let index = index.parse().expect("a child index");
                    children
                        .entry(parent.to_owned())
                        .or_default()
                        .push((index, path.clone()));
                }
            }
        }
        self.children = children
            .into_iter()
            .map(|(parent, mut list)| {
                list.sort();
                (parent, list.into_iter().map(|(_, path)| path).collect())
            })
            .collect();
    }

    fn fail(&self, path: &str) -> Result<(), ReadError> {
        match self.failing.get(path) {
            Some(error) => Err(*error),
            None if self.state.contains_key(path) => Ok(()),
            None => Err(ReadError::Gone),
        }
    }
}

impl Source for Replay {
    type Node = String;

    fn structure(&mut self, node: &String) -> Result<(Structure, Vec<String>), ReadError> {
        self.reads.structure.push(node.clone());
        self.fail(node)?;
        let found = &self.state[node];
        let structure = Structure {
            role: found.r.clone(),
            subrole: found.sr.clone(),
            identifier: found.id.clone(),
        };
        Ok((structure, self.children_of(node)))
    }

    fn texts(
        &mut self,
        node: &String,
        attrs: &[TextAttr],
    ) -> Result<Vec<Option<String>>, ReadError> {
        self.reads.texts.push((node.clone(), attrs.to_vec()));
        self.fail(node)?;
        let found = &self.state[node];
        Ok(attrs
            .iter()
            .map(|attr| match attr {
                TextAttr::Title => found.t.clone(),
                TextAttr::Description => found.desc.clone(),
                TextAttr::Value => found.v.clone(),
            })
            .collect())
    }

    fn class_list(&mut self, node: &String) -> Result<Option<ClassSet>, ReadError> {
        self.reads.class_lists.push(node.clone());
        self.fail(node)?;
        let found = &self.state[node];
        if found.cls.is_empty() {
            return Ok(None);
        }
        Ok(ClassSet::from_tokens(found.cls.iter().map(String::as_str)))
    }

    fn identity_hash(&self, node: &String) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        node.hash(&mut hasher);
        hasher.finish()
    }

    fn same(&self, a: &String, b: &String) -> bool {
        a == b
    }
}

/// The tester's events of a speaking test, as the scrubber wrote them: seconds since the capture's
/// `full` line, and the tile of the speaker (0 is the first tile under the main landmark).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub t: f64,
    pub kind: String,
    pub turn: Option<u32>,
    pub tile: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EventsFile {
    kind: String,
    v: u32,
    events: Vec<Event>,
}

pub fn events(name: &str) -> Vec<Event> {
    let path = super::fixture_dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let file: EventsFile = serde_json::from_str(&text).expect("an events file");
    assert_eq!((file.kind.as_str(), file.v), ("speaking-events", 1));
    file.events
}

/// One timed turn: who spoke (a tile number) from `start` to `end`, in seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Turn {
    pub turn: u32,
    pub tile: usize,
    pub start: f64,
    pub end: f64,
}

/// The speech of each turn, in order.
pub fn turns(events: &[Event]) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    for event in events {
        match event.kind.as_str() {
            "speech_start" => out.push(Turn {
                turn: event.turn.expect("a turn"),
                tile: event.tile.expect("a tile"),
                start: event.t,
                end: f64::NAN,
            }),
            "speech_end" => {
                let last = out.last_mut().expect("speech starts before it ends");
                assert_eq!(Some(last.turn), event.turn);
                last.end = event.t;
            }
            _ => {}
        }
    }
    out
}

/// The class names of the Meet speaking rule and the scrubber's token for each, so that a rule
/// can read the fixture's class lists.
pub const MEET_CLASS_TOKENS: [(&str, &str); 7] = [
    ("DYfzY", "cace893be"),
    ("cYKTje", "c34db12c0"),
    ("gjg47c", "c9ffe0173"),
    ("Oaajhc", "c1edf03cb"),
    ("HX2H7", "c524b0d6f"),
    ("wEsLMd", "cc8a7d408"),
    ("OgVli", "c18c9959b"),
];

/// The embedded rules with the speaking rule's class names replaced by the fixture's tokens.
pub fn token_rules_json() -> String {
    let mut json = call_names::rules::EMBEDDED_JSON.to_owned();
    for (class, token) in MEET_CLASS_TOKENS {
        let quoted = format!("\"{class}\"");
        assert_eq!(
            json.matches(&quoted).count(),
            1,
            "{class} once in the rules"
        );
        json = json.replace(&quoted, &format!("\"{token}\""));
    }
    json
}

pub fn token_rules() -> call_names::rules::Rules {
    call_names::rules::Rules::from_json(&token_rules_json()).unwrap()
}

/// The replay as the window the service reads: names ticks and speaking samples on the replay as
/// it is now. The test moves the replay on.
pub struct ReplayWindow {
    pub replay: std::rc::Rc<std::cell::RefCell<Replay>>,
    markers: call_names::speaking::Markers<String>,
    found: Option<call_names::speaking::Found>,
    /// Samples asked for.
    pub samples: std::rc::Rc<std::cell::Cell<usize>>,
}

impl ReplayWindow {
    pub fn new(replay: std::rc::Rc<std::cell::RefCell<Replay>>) -> Self {
        ReplayWindow {
            replay,
            markers: call_names::speaking::Markers::new(),
            found: None,
            samples: Default::default(),
        }
    }
}

impl call_names::service::Window for ReplayWindow {
    fn permission(&self) -> call_names::ax::Permission {
        call_names::ax::Permission::Granted
    }

    fn read(
        &mut self,
        rules: &call_names::rules::Rules,
        _apps: &[call_names::ax::RunningApp],
        budget: call_names::session::Budget,
    ) -> call_names::ax::TickReport {
        let mut replay = self.replay.borrow_mut();
        let clock = super::frozen();
        let mut meter = call_names::session::Meter::new(budget, &clock);
        let root = replay.root();
        let (names, found) = call_names::session::read_tick_with_speaking(
            rules,
            &mut *replay,
            &[call_names::session::Target {
                app: call_names::rules::App::GoogleMeet,
                root,
            }],
            &mut meter,
        );
        self.found = found.map(|found| call_names::speaking::Found {
            tiles: self.markers.update(&*replay, found),
            hidden: false,
        });
        call_names::ax::TickReport {
            outcome: names.map_err(call_names::ax::NoNames::from),
            nodes: meter.nodes(),
            elapsed: std::time::Duration::ZERO,
        }
    }

    fn stop(&mut self) {
        self.markers.clear();
    }

    fn speaking(&mut self) -> Option<call_names::speaking::Found> {
        self.found.take()
    }

    fn sample(&mut self, slots: &[usize]) -> call_names::speaking::SampleRead {
        self.samples.set(self.samples.get() + 1);
        let clock = super::frozen();
        let mut replay = self.replay.borrow_mut();
        self.markers.sample(
            &mut *replay,
            slots,
            call_names::speaking::SAMPLE_BUDGET,
            &clock,
        )
    }
}
