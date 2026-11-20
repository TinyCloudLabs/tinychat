//! One tick of reading, with hard limits.
//!
//! A tick reads each candidate window, keeps the ones that are in a call, and extracts names from
//! the only one left. Every node visit and every text read goes through a [`Meter`]: more than
//! [`Budget::max_nodes`] nodes, a node deeper than [`Budget::max_depth`], more than
//! [`Budget::max_time`] or a failed read discards the whole tick. A discarded tick yields nothing
//! at all, never a partial list. The time is checked before each read as well as after it, so a
//! tick that is out of time does not start another round trip to the app.
//!
//! An element met twice (Zoom's toolbar leads back to its window) is not a reason to discard: it
//! is skipped and still counted against the node budget.

use crate::extract::{Extraction, Scan};
use crate::rules::{App, Rules};
use crate::speaking::{find_markers, FindCost, Marker};
use crate::tree::{Node, ReadError, Source};
use std::time::{Duration, Instant};

/// Limits for one tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub max_nodes: usize,
    pub max_depth: usize,
    pub max_time: Duration,
}

impl Budget {
    pub const DEFAULT: Budget = Budget {
        max_nodes: 3000,
        max_depth: 80,
        max_time: Duration::from_millis(250),
    };
}

impl Default for Budget {
    fn default() -> Self {
        Budget::DEFAULT
    }
}

/// Why a tick that read a window yields nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Discard {
    NodeCap,
    Depth,
    Time,
    /// No longer produced: an element met twice is skipped and counted against the node budget.
    /// Kept so that existing matches on this type still compile.
    Cycle,
    Read(ReadError),
}

/// Time since the tick started.
pub trait Clock {
    fn elapsed(&self) -> Duration;
}

impl<F: Fn() -> Duration> Clock for F {
    fn elapsed(&self) -> Duration {
        self()
    }
}

/// The wall clock, from when it was started.
#[derive(Clone, Copy, Debug)]
pub struct Stopwatch(Instant);

impl Stopwatch {
    pub fn start() -> Self {
        Stopwatch(Instant::now())
    }
}

impl Clock for Stopwatch {
    fn elapsed(&self) -> Duration {
        self.0.elapsed()
    }
}

/// What one tick has spent so far.
pub struct Meter<'c> {
    budget: Budget,
    clock: &'c dyn Clock,
    nodes: usize,
}

impl<'c> Meter<'c> {
    pub fn new(budget: Budget, clock: &'c dyn Clock) -> Self {
        Meter {
            budget,
            clock,
            nodes: 0,
        }
    }

    /// Count one node at `depth` (the root is 0) and check every limit.
    pub fn visit(&mut self, depth: usize) -> Result<(), Discard> {
        self.nodes += 1;
        if self.nodes > self.budget.max_nodes {
            return Err(Discard::NodeCap);
        }
        if depth > self.budget.max_depth {
            return Err(Discard::Depth);
        }
        self.check_time()
    }

    pub fn check_time(&self) -> Result<(), Discard> {
        if self.clock.elapsed() > self.budget.max_time {
            return Err(Discard::Time);
        }
        Ok(())
    }

    pub fn nodes(&self) -> usize {
        self.nodes
    }

    /// How many more nodes fit in the budget.
    pub fn remaining_nodes(&self) -> usize {
        self.budget.max_nodes.saturating_sub(self.nodes)
    }

    pub fn elapsed(&self) -> Duration {
        self.clock.elapsed()
    }
}

/// A window to read: the app it belongs to and its root element (Zoom's meeting window, or the
/// web area of a Meet page).
#[derive(Clone, Debug)]
pub struct Target<N> {
    pub app: App,
    pub root: N,
}

/// Why a tick produced no names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skip {
    /// No candidate window.
    NoTarget,
    /// Windows were read, but none is in a call.
    NotInCall,
    /// More than one window is in a call, so none is trusted.
    SeveralInCall(usize),
    Discarded(Discard),
}

/// One tick over the candidate windows.
pub fn read_tick<S: Source>(
    rules: &Rules,
    source: &mut S,
    targets: &[Target<S::Node>],
    meter: &mut Meter,
) -> Result<Extraction, Skip> {
    read_tick_traced(rules, source, targets, meter, &mut TickTrace::default())
}

/// What one tick did, for the caller's bookkeeping and for diagnostics: counts and times only,
/// unless `keep_trees` asks for a copy of what was read (a developer's own test call).
#[derive(Debug, Default)]
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) struct TickTrace {
    /// Ask for a copy of each window that was read, with the texts that were read.
    pub keep_trees: bool,
    /// For each target, in order: whether it is in a call, once that is known.
    pub in_call: Vec<Option<bool>>,
    /// The target that was being read when the tick was discarded.
    pub failed: Option<usize>,
    /// The structure walks: time and nodes.
    pub scan_time: Duration,
    pub scan_nodes: usize,
    /// The in-call tests and the rules: time and text reads.
    pub rules_time: Duration,
    pub text_reads: usize,
    /// With `keep_trees`: each window that was read, with its target index.
    pub trees: Vec<(usize, Node)>,
    /// The search for speaking markers: time and class lists read.
    pub speaking_time: Duration,
    pub class_reads: usize,
}

/// As [`read_tick`], and finds the speaking markers of the window that gave the names (see
/// `speaking`), on the same scan and within the same meter. The markers are `None` when the tick
/// gave no names, or when their search ran out of time or failed; that never costs the names.
#[allow(clippy::type_complexity)]
pub fn read_tick_with_speaking<S: Source>(
    rules: &Rules,
    source: &mut S,
    targets: &[Target<S::Node>],
    meter: &mut Meter,
) -> (Result<Extraction, Skip>, Option<Vec<Marker<S::Node>>>) {
    let mut markers = None;
    let result = read_tick_full(
        rules,
        source,
        targets,
        meter,
        &mut TickTrace::default(),
        Some(&mut markers),
    );
    (result, markers)
}

/// As [`read_tick`], and fills `trace`: which targets are in a call, which target a discard came
/// from, and what the structure walks and the rules cost.
pub(crate) fn read_tick_traced<S: Source>(
    rules: &Rules,
    source: &mut S,
    targets: &[Target<S::Node>],
    meter: &mut Meter,
    trace: &mut TickTrace,
) -> Result<Extraction, Skip> {
    read_tick_full(rules, source, targets, meter, trace, None)
}

/// As [`read_tick_traced`]; with `markers`, also the speaking markers of the window that gave the
/// names, after its names and only when they were read.
pub(crate) fn read_tick_full<S: Source>(
    rules: &Rules,
    source: &mut S,
    targets: &[Target<S::Node>],
    meter: &mut Meter,
    trace: &mut TickTrace,
    markers: Option<&mut Option<Vec<Marker<S::Node>>>>,
) -> Result<Extraction, Skip> {
    trace.in_call = vec![None; targets.len()];
    if targets.is_empty() {
        return Err(Skip::NoTarget);
    }
    let mut in_call = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        let Some(app_rules) = rules.app(target.app) else {
            continue;
        };
        let fail = |trace: &mut TickTrace, discard| {
            trace.failed = Some(index);
            Skip::Discarded(discard)
        };
        meter.check_time().map_err(|discard| fail(trace, discard))?;

        let (began, nodes) = (meter.elapsed(), meter.nodes());
        let scanned = Scan::read(source, target.root.clone(), app_rules, meter);
        trace.scan_time += meter.elapsed().saturating_sub(began);
        trace.scan_nodes += meter.nodes() - nodes;
        let mut scan = scanned.map_err(|discard| fail(trace, discard))?;

        let began = meter.elapsed();
        let tested = scan.in_call(source, app_rules, meter);
        trace.rules_time += meter.elapsed().saturating_sub(began);
        trace.text_reads += scan.text_reads();
        let is_in_call = tested.map_err(|discard| fail(trace, discard))?;
        trace.in_call[index] = Some(is_in_call);
        if is_in_call {
            in_call.push((index, scan, app_rules));
        } else if trace.keep_trees {
            trace.trees.extend(scan.to_node().map(|tree| (index, tree)));
        }
    }
    let several = in_call.len();
    let mut only = in_call.pop().filter(|_| several == 1);
    let result = match only.as_mut() {
        Some((index, scan, app_rules)) => {
            let (began, reads) = (meter.elapsed(), scan.text_reads());
            let extracted = scan.extract(source, app_rules, meter);
            trace.rules_time += meter.elapsed().saturating_sub(began);
            trace.text_reads += scan.text_reads() - reads;
            extracted.map_err(|discard| {
                trace.failed = Some(*index);
                Skip::Discarded(discard)
            })
        }
        None if several == 0 => Err(Skip::NotInCall),
        None => Err(Skip::SeveralInCall(several)),
    };
    if let (Some(markers), Some((_, scan, app_rules)), Ok(_)) = (markers, only.as_mut(), &result) {
        // After the names, on the same scan: a search that fails or runs out of time finds no
        // markers and leaves the names as they are.
        let began = meter.elapsed();
        let mut cost = FindCost::default();
        *markers = find_markers(scan, source, app_rules, meter, &mut cost).ok();
        trace.speaking_time += meter.elapsed().saturating_sub(began);
        trace.class_reads += cost.class_reads;
    }
    if trace.keep_trees {
        // The one window that was read for names, with what the rules read in it.
        if let Some((index, scan, _)) = &only {
            trace
                .trees
                .extend(scan.to_node().map(|tree| (*index, tree)));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn meter_counts_nodes_depth_and_time() {
        let now = Cell::new(Duration::ZERO);
        let clock = || now.get();
        let budget = Budget {
            max_nodes: 2,
            max_depth: 1,
            max_time: Duration::from_millis(10),
        };
        let mut meter = Meter::new(budget, &clock);
        assert_eq!(meter.visit(0), Ok(()));
        assert_eq!(meter.visit(2), Err(Discard::Depth));
        assert_eq!(meter.visit(0), Err(Discard::NodeCap));

        let mut meter = Meter::new(budget, &clock);
        now.set(Duration::from_millis(11));
        assert_eq!(meter.visit(0), Err(Discard::Time));
        assert_eq!(meter.check_time(), Err(Discard::Time));
    }

    #[test]
    fn the_trace_says_which_windows_are_in_a_call_and_what_the_tick_cost() {
        use crate::tree::{flat, NodeSource};
        let load = |text: &str| flat::roots_from_jsonl(text).unwrap().remove(0).1;
        let left = load(include_str!("../tests/fixtures/meet-left-call.jsonl"));
        let call = load(include_str!("../tests/fixtures/meet-people-panel.jsonl"));
        let rules = Rules::embedded().unwrap();
        let targets = [&left, &call].map(|root| Target {
            app: App::GoogleMeet,
            root,
        });
        let clock = || Duration::ZERO;

        let mut trace = TickTrace::default();
        let mut meter = Meter::new(Budget::DEFAULT, &clock);
        let extraction = read_tick_traced(
            &rules,
            &mut NodeSource::new(),
            &targets,
            &mut meter,
            &mut trace,
        );
        assert!(extraction.is_ok());
        assert_eq!(trace.in_call, [Some(false), Some(true)]);
        assert_eq!(trace.failed, None);
        assert_eq!(trace.scan_nodes, meter.nodes());
        assert!(trace.text_reads > 0);
        assert!(trace.trees.is_empty(), "nothing is kept unless asked for");

        let mut trace = TickTrace {
            keep_trees: true,
            ..TickTrace::default()
        };
        let mut meter = Meter::new(Budget::DEFAULT, &clock);
        read_tick_traced(
            &rules,
            &mut NodeSource::new(),
            &targets,
            &mut meter,
            &mut trace,
        )
        .unwrap();
        let kept: Vec<usize> = trace.trees.iter().map(|(index, _)| *index).collect();
        assert_eq!(kept, [0, 1]);

        // A discard names the window it came from.
        let mut trace = TickTrace::default();
        let tight = Budget {
            max_nodes: 100,
            ..Budget::DEFAULT
        };
        let mut meter = Meter::new(tight, &clock);
        let result = read_tick_traced(
            &rules,
            &mut NodeSource::new(),
            &targets,
            &mut meter,
            &mut trace,
        );
        assert_eq!(result, Err(Skip::Discarded(Discard::NodeCap)));
        assert_eq!(trace.failed, Some(1));
        assert_eq!(trace.in_call, [Some(false), None]);
    }

    #[test]
    fn default_budget_matches_the_plan() {
        assert_eq!(
            Budget::default(),
            Budget {
                max_nodes: 3000,
                max_depth: 80,
                max_time: Duration::from_millis(250)
            }
        );
    }
}
