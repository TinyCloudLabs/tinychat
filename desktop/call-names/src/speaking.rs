//! Who is speaking, from the meeting window: phase 2 of "names in the call".
//!
//! Meet marks the participant who speaks in that person's tile: below the tile, one element's
//! class list changes from a quiet class to one of a few speaking classes, within about 0.7 s of
//! the speech, and back when the speech stops. This module follows that marker.
//!
//! - **Finding the markers** ([`find_markers`]), once per names tick, on the scan the tick made:
//!   the app's [`SpeakingRule`] gives each tile, its one name and its marker candidates (structure
//!   only), and one class list is read per candidate to pick the marker. A tile with no name, two
//!   names, no candidate or more than
//!   [`crate::extract::MAX_MARKER_CANDIDATES`] is not followed, and nothing is
//!   followed with fewer than [`MIN_SPEAKING_TILES`] tiles unless the current names tick
//!   establishes at least that many distinct people in a shorter visible layout.
//! - **Sampling** ([`Markers::sample`]), between names ticks: one class-list read per followed
//!   marker and nothing else, so a sample reads no text and no structure. Each sample has
//!   [`SAMPLE_BUDGET`], checked before every read; a read that times out makes the rest of the
//!   sample unknown, never quiet; an element that went away is dropped until the next names tick.
//! - **Classifying** ([`Classifier`]): with the rule's class tokens ("rules" mode), a marker is
//!   speaking when it has a speaking token, quiet when it has the quiet token, and unknown
//!   otherwise or without the tokens every marker has. If no meter exists, a separately
//!   configured last-active-speaker signal produces Active/Inactive, never Speaking/Quiet.
//!   When the window's markers never match the
//!   tokens (Meet renamed its classes), the quiet marker is learned instead ("learned" mode): the
//!   most common class set of all tiles over the first [`LEARN_FOR_MS`] of samples is quiet, and
//!   a marker that lost one of its classes is speaking. A sample in which most tiles change at
//!   once is a change of layout, not speech: it is unknown.
//!
//! Class lists never leave this process and are never kept as text: a [`ClassSet`] holds hashes,
//! and the learned quiet set is a [`ClassSet`] too. Nothing here writes or logs; no `Debug` of a
//! type here shows a name, a class token or an element.

use crate::extract::{Scan, TileCandidates};
use crate::names::Name;
use crate::rules::{ActivityClasses, AppRules, Classes, SpeakingRule, MIN_SPEAKING_TILES};
use crate::session::{Clock, Discard, Meter};
use crate::tree::{class_hash, ClassSet, ReadError, Source};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

/// The time between two speaking samples.
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(200);
/// The time between two samples after [`TIMEOUTS_BEFORE_SLOW`] samples in a row timed out.
pub const SLOW_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
/// How long sampling stays slow.
pub const SLOW_FOR: Duration = Duration::from_secs(30);
/// Samples in a row with a timeout before sampling slows down.
pub const TIMEOUTS_BEFORE_SLOW: u32 = 3;
/// What one sample may cost, checked before each read.
pub const SAMPLE_BUDGET: Duration = Duration::from_millis(40);
/// The messaging timeout of a marker element: the most one read in a sample can cost.
pub const MARKER_TIMEOUT_SECONDS: f32 = 0.05;
/// Most markers read in one sample.
pub const MAX_TILES_PER_SAMPLE: usize = 12;
/// Most marker reads in one second. Beyond that, tiles take turns.
pub const MAX_READS_PER_SECOND: usize = 30;
/// How much sampling the learned mode looks at before it says which class set is quiet.
pub const LEARN_FOR_MS: u64 = 30_000;
/// The fewest class lists the learned mode learns from.
pub const MIN_LEARN_READINGS: usize = 60;
/// Names ticks in a row with tiles but no marker that matches the rule's tokens before the
/// learned mode takes over.
pub const MISSES_BEFORE_LEARNING: u32 = 3;

/// What one marker read says about its tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    /// Last-active-speaker border; never a speech mark.
    Active,
    /// A recognized border without its active token.
    Inactive,
    Speaking,
    Quiet,
    /// The marker could not be read, or its classes say neither.
    Unknown,
}

/// How markers are classified.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// With the rule's class tokens.
    Rules,
    /// With the quiet class set learned from the window.
    Learned,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Rules => "rules",
            Mode::Learned => "learned",
        }
    }
}

/// The class tokens of a rule, hashed as [`ClassSet`] hashes them.
#[derive(Clone)]
pub struct Tokens {
    all: Vec<u64>,
    quiet: Vec<u64>,
    speaking: Vec<u64>,
    active: Option<ActivityTokens>,
}

impl Tokens {
    pub fn of(classes: &Classes) -> Tokens {
        let hash = |tokens: &[String]| tokens.iter().map(|token| class_hash(token)).collect();
        Tokens {
            all: hash(&classes.all),
            quiet: hash(&classes.quiet),
            speaking: hash(&classes.speaking),
            active: None,
        }
    }

    /// Both recognized signals in one rule; the meter is always preferred.
    pub fn for_rule(rule: &SpeakingRule) -> Option<Tokens> {
        let mut tokens = rule.classes.as_ref().map(Tokens::of).unwrap_or(Tokens {
            all: Vec::new(),
            quiet: Vec::new(),
            speaking: Vec::new(),
            active: None,
        });
        tokens.active = rule
            .active
            .as_ref()
            .map(|active| ActivityTokens::of(&active.classes));
        (rule.classes.is_some() || tokens.active.is_some()).then_some(tokens)
    }

    /// A recognized border, independently of the learned meter classifier.
    pub fn activity(&self, set: &ClassSet) -> Option<Mark> {
        self.active.as_ref().and_then(|active| active.classify(set))
    }

    /// The marker as the rule's tokens read it. Activity never becomes speech.
    pub fn classify(&self, set: &ClassSet) -> Mark {
        if !self.all.is_empty() && self.all.iter().all(|hash| set.contains(*hash)) {
            if self.speaking.iter().any(|hash| set.contains(*hash)) {
                return Mark::Speaking;
            }
            if self.quiet.iter().any(|hash| set.contains(*hash)) {
                return Mark::Quiet;
            }
        }
        self.activity(set).unwrap_or(Mark::Unknown)
    }

    /// The meter itself remains identifiable during transient states without an on/off token.
    fn meter_matches(&self, set: &ClassSet) -> bool {
        !self.all.is_empty() && self.all.iter().all(|hash| set.contains(*hash))
    }

    /// True when the rule's tokens can read this element: it is a marker, quiet or speaking.
    pub fn matches(&self, set: &ClassSet) -> bool {
        self.classify(set) != Mark::Unknown
    }
}

#[derive(Clone)]
struct ActivityTokens {
    all: Vec<u64>,
    on: Vec<u64>,
}

impl ActivityTokens {
    fn of(classes: &ActivityClasses) -> Self {
        Self {
            all: classes.all.iter().map(|token| class_hash(token)).collect(),
            on: classes.on.iter().map(|token| class_hash(token)).collect(),
        }
    }

    fn classify(&self, set: &ClassSet) -> Option<Mark> {
        self.all.iter().all(|hash| set.contains(*hash)).then(|| {
            if self.on.iter().any(|hash| set.contains(*hash)) {
                Mark::Active
            } else {
                Mark::Inactive
            }
        })
    }
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Tokens(<{} all, {} quiet, {} speaking>)",
            self.all.len(),
            self.quiet.len(),
            self.speaking.len()
        )
    }
}

/// A tile whose marker is followed: its element, its marker element and its name.
#[derive(Clone)]
pub struct Marker<H> {
    pub tile: H,
    pub marker: H,
    pub name: Name,
    /// The marker matched the rule's class tokens when it was picked.
    pub rules_ok: bool,
    /// The tile had one marker candidate only (the learned mode follows no other tile).
    pub single: bool,
}

impl<H> fmt::Debug for Marker<H> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Marker")
            .field("name", &self.name)
            .field("rules_ok", &self.rules_ok)
            .field("single", &self.single)
            .finish()
    }
}

/// What one names tick's search for markers did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FindCost {
    /// Class lists read, one per candidate at most.
    pub class_reads: usize,
}

/// The tiles of the app's speaking rule in a scan, each with its marker. Reads one class list per
/// candidate, within the tick's meter: a candidate that matches the rule's tokens is the marker;
/// without one, a tile's only candidate is. Empty when the app has no speaking rule or fewer than
/// its `min_tiles` tiles show. A tick out of time or a failed read gives an error; the names the
/// tick read before are not affected by it.
pub fn find_markers<S: Source>(
    scan: &mut Scan<S::Node>,
    source: &mut S,
    rules: &AppRules,
    meter: &mut Meter,
    cost: &mut FindCost,
) -> Result<Vec<Marker<S::Node>>, Discard> {
    find_markers_with_people(scan, source, rules, meter, cost, 0)
}

/// A short visible layout is eligible only with at least three distinct names in this tick.
/// Historical roster entries alone cannot prove that people have not left the call.
pub fn find_markers_with_people<S: Source>(
    scan: &mut Scan<S::Node>,
    source: &mut S,
    rules: &AppRules,
    meter: &mut Meter,
    cost: &mut FindCost,
    people: usize,
) -> Result<Vec<Marker<S::Node>>, Discard> {
    let Some(rule) = rules.speaking.first() else {
        return Ok(Vec::new());
    };
    let least = rule.min_tiles.max(MIN_SPEAKING_TILES);
    let tiles = scan.speaking_tiles(source, rule, meter)?;
    let short_layout = people >= least && scan.speaking_tile_count(source, rule, meter)? < least;
    let needed = if short_layout { 1 } else { least };
    if tiles.len() < needed {
        return Ok(Vec::new());
    }
    let tokens = rule.classes.as_ref().map(Tokens::of);
    let mut out = Vec::new();
    for TileCandidates {
        tile,
        candidates,
        name,
    } in tiles
    {
        let mut single = candidates.len() == 1;
        let mut matched = None;
        let mut first = None;
        for candidate in candidates {
            meter.check_time()?;
            cost.class_reads += 1;
            let set = match source.class_list(&candidate) {
                Ok(set) => set,
                // This candidate went away since the scan: not a marker.
                Err(ReadError::Gone) => continue,
                Err(error) => return Err(Discard::Read(error)),
            };
            meter.check_time()?;
            let Some(set) = set else {
                continue;
            };
            if tokens
                .as_ref()
                .is_some_and(|tokens| tokens.meter_matches(&set))
            {
                // Identity and state recognition are separate: keep this meter during
                // unknown states, but still permit the existing learned-mode fallback
                // if Meet has renamed its quiet/speaking tokens.
                let rules_ok = tokens.as_ref().is_some_and(|tokens| tokens.matches(&set));
                matched = Some((candidate, rules_ok));
                break;
            }
            first.get_or_insert(candidate);
        }
        // Only look for activity when the primary candidates have no recognized meter.
        // Each tick obtains candidates from its new scan. A redrawn tile cannot retain a
        // previously selected meter/border solely because its name stayed the same.
        if matched.is_none() {
            if let Some(active) = &rule.active {
                let active_tokens = ActivityTokens::of(&active.classes);
                let candidates = scan.activity_candidates(source, &tile, &active.marker, meter)?;
                let mut borders = Vec::new();
                for candidate in candidates {
                    meter.check_time()?;
                    cost.class_reads += 1;
                    let set = match source.class_list(&candidate) {
                        Ok(set) => set,
                        Err(ReadError::Gone) => continue,
                        Err(error) => return Err(Discard::Read(error)),
                    };
                    meter.check_time()?;
                    if set
                        .as_ref()
                        .is_some_and(|set| active_tokens.classify(set).is_some())
                    {
                        borders.push(candidate);
                    }
                }
                if borders.len() == 1 {
                    matched = borders.pop().map(|marker| (marker, true));
                    single = true;
                } else if borders.len() > 1 {
                    // Ambiguous activity must not enter a learned speech classifier.
                    continue;
                }
            }
        }
        let (marker, rules_ok) = match (matched, first) {
            (Some((marker, rules_ok)), _) => (marker, rules_ok),
            (None, Some(marker)) => (marker, false),
            (None, None) => continue,
        };
        out.push(Marker {
            tile,
            marker,
            name,
            rules_ok,
            single,
        });
    }
    if out.len() < needed {
        out.clear();
    }
    Ok(out)
}

/// One tile of a names tick, as the service sees it: no element, only its name and flags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TileFound {
    pub name: Name,
    /// The tile of the names tick before that is the same element, with the same marker.
    pub previous: Option<usize>,
    pub rules_ok: bool,
    pub single: bool,
}

/// What a names tick found for speaking.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Found {
    /// The followed tiles, in window order. Empty: nothing is followed until the next tick.
    pub tiles: Vec<TileFound>,
    /// The call window is minimised, or its browser shows another tab: the markers may not move.
    pub hidden: bool,
    /// Distinct names from the current names tick, not the recording's historical roster.
    pub people: usize,
}

/// One marker read in a sample.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reading {
    Classes(ClassSet),
    /// Not read (out of time, after a timeout), or the element has no class list.
    Unknown,
    /// The element went away; its tile is not followed until the next names tick.
    Gone,
}

/// What one sample read, and what it cost. Counts, times and hashed class sets only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SampleRead {
    /// One per tile asked for, in the order asked.
    pub readings: Vec<(usize, Reading)>,
    /// Round trips to the app.
    pub calls: u64,
    pub elapsed: Duration,
    /// A read timed out; the rest of the sample is unknown.
    pub timed_out: bool,
    /// The app rests after timeouts in names ticks: nothing was read.
    pub resting: bool,
    /// A read said the permission is missing.
    pub not_trusted: bool,
}

/// The followed markers of one window, from one names tick to the next.
pub struct Markers<H> {
    slots: Vec<Option<Marker<H>>>,
}

impl<H> Default for Markers<H> {
    fn default() -> Self {
        Markers { slots: Vec::new() }
    }
}

impl<H: Clone> Markers<H> {
    pub fn new() -> Self {
        Markers::default()
    }

    /// Tiles followed now, including those whose element went away since the names tick.
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// The marker element of a tile, while it is followed.
    pub fn marker(&self, slot: usize) -> Option<&H> {
        self.slots.get(slot)?.as_ref().map(|found| &found.marker)
    }

    /// Follow the markers of a new names tick instead. Each new tile says which tile of the tick
    /// before is the same element with the same marker (`CFEqual` on macOS), so that the samples
    /// taken in between can be kept.
    pub fn update<S: Source<Node = H>>(
        &mut self,
        source: &S,
        found: Vec<Marker<H>>,
    ) -> Vec<TileFound> {
        let tiles = found
            .iter()
            .map(|new| TileFound {
                name: new.name.clone(),
                previous: self.slots.iter().position(|old| {
                    old.as_ref().is_some_and(|old| {
                        source.same(&old.tile, &new.tile) && source.same(&old.marker, &new.marker)
                    })
                }),
                rules_ok: new.rules_ok,
                single: new.single,
            })
            .collect();
        self.slots = found.into_iter().map(Some).collect();
        tiles
    }

    /// Follow nothing.
    pub fn clear(&mut self) {
        self.slots.clear();
    }

    /// One sample: the class list of the marker of each tile asked for, in order. The budget is
    /// checked before each read on `clock`; what is left when it runs out, and everything after a
    /// timeout or a missing permission, is unknown. An element that went away is dropped.
    pub fn sample<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        slots: &[usize],
        budget: Duration,
        clock: &dyn Clock,
    ) -> SampleRead {
        let started = clock.elapsed();
        let mut out = SampleRead::default();
        let mut stopped = false;
        for &slot in slots {
            let reading = match self.slots.get(slot).and_then(Option::as_ref) {
                _ if stopped => Reading::Unknown,
                None => Reading::Gone,
                Some(_) if clock.elapsed().saturating_sub(started) >= budget => {
                    stopped = true;
                    Reading::Unknown
                }
                Some(found) => {
                    out.calls += 1;
                    match source.class_list(&found.marker) {
                        Ok(Some(set)) => Reading::Classes(set),
                        Ok(None) | Err(ReadError::Failed(_)) => Reading::Unknown,
                        Err(ReadError::Gone) => {
                            self.slots[slot] = None;
                            Reading::Gone
                        }
                        Err(ReadError::Timeout) => {
                            out.timed_out = true;
                            stopped = true;
                            Reading::Unknown
                        }
                        Err(ReadError::NotTrusted) => {
                            out.not_trusted = true;
                            stopped = true;
                            Reading::Unknown
                        }
                    }
                }
            };
            out.readings.push((slot, reading));
        }
        out.elapsed = clock.elapsed().saturating_sub(started);
        out
    }
}

/// The tiles a sample reads: all of them while they fit, else up to the limit, taking turns from
/// `cursor` (which moves on). At most [`MAX_TILES_PER_SAMPLE`], and at most
/// [`MAX_READS_PER_SECOND`] reads a second at this sample interval.
pub fn tiles_to_read(eligible: &[usize], interval: Duration, cursor: &mut usize) -> Vec<usize> {
    let per_second = MAX_READS_PER_SECOND as u128 * interval.as_millis().max(1) / 1000;
    let limit = (per_second as usize).clamp(1, MAX_TILES_PER_SAMPLE);
    if eligible.len() <= limit {
        return eligible.to_vec();
    }
    let start = *cursor % eligible.len();
    *cursor = (start + limit) % eligible.len();
    let mut out: Vec<usize> = (0..limit)
        .map(|offset| eligible[(start + offset) % eligible.len()])
        .collect();
    out.sort_unstable();
    out
}

/// A sample whose tiles the next names tick confirmed: each reading belongs to a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmed {
    /// On the recording's clock.
    pub at_ms: u64,
    /// The sample interval when it was taken.
    pub period_ms: u64,
    /// Person id and reading, one per tile read.
    pub readings: Vec<(String, Reading)>,
}

/// A confirmed sample, classified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classified {
    pub at_ms: u64,
    pub period_ms: u64,
    /// Person id and mark, one per tile read.
    pub marks: Vec<(String, Mark)>,
}

/// Says, sample by sample, which tiles are speaking: with the rule's tokens, or with the quiet
/// set it learned. The mode is decided from the names ticks ([`Classifier::decide`]): "rules" as
/// soon as a marker matches the tokens, "learned" after [`MISSES_BEFORE_LEARNING`] ticks with
/// tiles and no such marker, and then for the rest of the recording.
pub struct Classifier {
    tokens: Option<Tokens>,
    mode: Option<Mode>,
    misses: u32,
    /// Samples before a mode, or while the learned mode learns.
    waiting: Vec<Confirmed>,
    /// The learned quiet class set.
    quiet: Option<ClassSet>,
}

impl fmt::Debug for Classifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Classifier")
            .field("tokens", &self.tokens)
            .field("mode", &self.mode)
            .field("waiting", &self.waiting.len())
            .field("learned", &self.quiet.is_some())
            .finish()
    }
}

impl Classifier {
    /// A classifier for a rule with these tokens (`None`: the rule names no classes).
    pub fn new(tokens: Option<Tokens>) -> Classifier {
        Classifier {
            tokens,
            mode: None,
            misses: 0,
            waiting: Vec::new(),
            quiet: None,
        }
    }

    /// The mode, once decided.
    pub fn mode(&self) -> Option<Mode> {
        self.mode
    }

    /// One reading as the classifier reads it now, without keeping anything: unknown before a
    /// mode, and while the learned mode learns. Not for the timeline.
    pub fn preview(&self, reading: &Reading) -> Mark {
        let Reading::Classes(set) = reading else {
            return Mark::Unknown;
        };
        if let Some(mark) = self.tokens.as_ref().and_then(|tokens| tokens.activity(set)) {
            return mark;
        }
        match (self.mode, &self.tokens, &self.quiet) {
            (Some(Mode::Rules), Some(tokens), _) => tokens.classify(set),
            (Some(Mode::Learned), _, Some(quiet)) if set.contains_all(quiet) => Mark::Quiet,
            (Some(Mode::Learned), _, Some(_)) => Mark::Speaking,
            _ => Mark::Unknown,
        }
    }

    /// Whether this sample read a recognized border, even before a mode is chosen.
    pub fn is_border(&self, reading: &Reading) -> bool {
        match reading {
            Reading::Classes(set) => self
                .tokens
                .as_ref()
                .is_some_and(|tokens| tokens.activity(set).is_some()),
            _ => false,
        }
    }

    /// Whether a tile may be followed in the mode as it is now: the learned mode follows only a
    /// tile with one marker candidate.
    pub fn follows(&self, tile: &TileFound) -> bool {
        self.mode != Some(Mode::Learned) || tile.single
    }

    /// A names tick found these tiles. Returns samples that the decision classified.
    pub fn decide(&mut self, tiles: &[TileFound]) -> Vec<Classified> {
        self.decide_with_people(tiles, 0)
    }

    pub fn decide_with_people(&mut self, tiles: &[TileFound], people: usize) -> Vec<Classified> {
        if self.mode == Some(Mode::Learned)
            || (tiles.len() < MIN_SPEAKING_TILES && people < MIN_SPEAKING_TILES)
        {
            return Vec::new();
        }
        if self.tokens.is_some() && tiles.iter().any(|tile| tile.rules_ok) {
            self.misses = 0;
            if self.mode.is_none() {
                self.mode = Some(Mode::Rules);
                let waiting = std::mem::take(&mut self.waiting);
                return waiting
                    .into_iter()
                    .flat_map(|sample| self.push(sample))
                    .collect();
            }
            return Vec::new();
        }
        self.misses += 1;
        if self.misses >= MISSES_BEFORE_LEARNING {
            // The waiting samples, if any, are the first the learned mode learns from.
            self.mode = Some(Mode::Learned);
        }
        Vec::new()
    }

    /// Classify a confirmed sample. Returns the samples that are ready, in time order: this one
    /// in "rules" mode; in "learned" mode, nothing until the quiet set is learned, then all the
    /// samples it learned from at once.
    pub fn push(&mut self, sample: Confirmed) -> Vec<Classified> {
        match (self.mode, &self.tokens, &self.quiet) {
            (Some(Mode::Rules), Some(tokens), _) => vec![classify_rules(tokens, sample)],
            (Some(Mode::Learned), _, Some(quiet)) => {
                vec![with_activity(self.tokens.as_ref(), sample, |sample| {
                    classify_learned(quiet, sample)
                })]
            }
            (Some(Mode::Learned), _, None) => {
                self.waiting.push(sample);
                self.learn(false)
            }
            // No mode yet (or rules without tokens, which `decide` never chooses).
            _ => {
                self.waiting.push(sample);
                Vec::new()
            }
        }
    }

    /// The recording ended: the learned mode learns from what it has, if that is enough. Samples
    /// that can still not be classified are returned as unknown.
    pub fn finish(&mut self) -> Vec<Classified> {
        if self.mode == Some(Mode::Learned) && self.quiet.is_none() {
            return self.learn(true);
        }
        std::mem::take(&mut self.waiting)
            .into_iter()
            .map(|sample| with_activity(self.tokens.as_ref(), sample, unknown))
            .collect()
    }

    fn learn(&mut self, last: bool) -> Vec<Classified> {
        let (Some(first), Some(newest)) = (self.waiting.first(), self.waiting.last()) else {
            return Vec::new();
        };
        if !last && newest.at_ms.saturating_sub(first.at_ms) < LEARN_FOR_MS {
            return Vec::new();
        }
        let mut counts: HashMap<u64, (&ClassSet, usize)> = HashMap::new();
        let mut total = 0;
        for sample in &self.waiting {
            for (_, reading) in &sample.readings {
                if let Reading::Classes(set) = reading {
                    if self
                        .tokens
                        .as_ref()
                        .is_some_and(|tokens| tokens.activity(set).is_some())
                    {
                        continue;
                    }
                    counts.entry(set.fingerprint()).or_insert((set, 0)).1 += 1;
                    total += 1;
                }
            }
        }
        let best = counts
            .values()
            .max_by_key(|(set, count)| (*count, set.fingerprint()))
            .map(|(set, count)| ((*set).clone(), *count));
        let waiting = std::mem::take(&mut self.waiting);
        match best {
            // Quiet is what most tiles show most of the time.
            Some((set, count)) if total >= MIN_LEARN_READINGS && count * 2 > total => {
                let ready = waiting
                    .into_iter()
                    .map(|sample| {
                        with_activity(self.tokens.as_ref(), sample, |sample| {
                            classify_learned(&set, sample)
                        })
                    })
                    .collect();
                self.quiet = Some(set);
                ready
            }
            // No class set stands out: these samples say nothing; learn from the next ones.
            _ => waiting
                .into_iter()
                .map(|sample| with_activity(self.tokens.as_ref(), sample, unknown))
                .collect(),
        }
    }
}

/// Preserve the separate signal even if the meter classifier is learning or has no decision.
fn with_activity(
    tokens: Option<&Tokens>,
    sample: Confirmed,
    classify: impl FnOnce(Confirmed) -> Classified,
) -> Classified {
    let active: Vec<Option<Mark>> = sample
        .readings
        .iter()
        .map(|(_, reading)| match reading {
            Reading::Classes(set) => tokens.and_then(|tokens| tokens.activity(set)),
            _ => None,
        })
        .collect();
    let mut sample = sample;
    // Border classes cannot participate in the learned meter layout-change vote.
    for ((_, reading), active) in sample.readings.iter_mut().zip(&active) {
        if active.is_some() {
            *reading = Reading::Unknown;
        }
    }
    let mut classified = classify(sample);
    for ((_, mark), active) in classified.marks.iter_mut().zip(active) {
        if let Some(active) = active {
            *mark = active;
        }
    }
    classified
}

fn unknown(sample: Confirmed) -> Classified {
    Classified {
        at_ms: sample.at_ms,
        period_ms: sample.period_ms,
        marks: sample
            .readings
            .into_iter()
            .map(|(person, _)| (person, Mark::Unknown))
            .collect(),
    }
}

fn classify_rules(tokens: &Tokens, sample: Confirmed) -> Classified {
    Classified {
        at_ms: sample.at_ms,
        period_ms: sample.period_ms,
        marks: sample
            .readings
            .into_iter()
            .map(|(person, reading)| {
                let mark = match &reading {
                    Reading::Classes(set) => tokens.classify(set),
                    Reading::Unknown | Reading::Gone => Mark::Unknown,
                };
                (person, mark)
            })
            .collect(),
    }
}

/// Quiet: the marker has every class of the quiet set (it may have more, such as a class that
/// animates the change). Speaking: one of them is gone. When most tiles of a sample change at
/// once, the layout changed: the whole sample is unknown.
fn classify_learned(quiet: &ClassSet, sample: Confirmed) -> Classified {
    let mut marks: Vec<(String, Mark)> = sample
        .readings
        .into_iter()
        .map(|(person, reading)| {
            let mark = match &reading {
                Reading::Classes(set) if set.contains_all(quiet) => Mark::Quiet,
                Reading::Classes(_) => Mark::Speaking,
                Reading::Unknown | Reading::Gone => Mark::Unknown,
            };
            (person, mark)
        })
        .collect();
    let read = marks
        .iter()
        .filter(|(_, mark)| *mark != Mark::Unknown)
        .count();
    let speaking = marks
        .iter()
        .filter(|(_, mark)| *mark == Mark::Speaking)
        .count();
    if read >= MIN_SPEAKING_TILES && speaking > (read / 2).max(2) {
        marks.iter_mut().for_each(|(_, mark)| *mark = Mark::Unknown);
    }
    Classified {
        at_ms: sample.at_ms,
        period_ms: sample.period_ms,
        marks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(tokens: &[&str]) -> ClassSet {
        ClassSet::from_tokens(tokens.iter().copied()).unwrap()
    }

    fn tokens() -> Tokens {
        Tokens::of(&Classes {
            all: vec!["base".into(), "meter".into()],
            quiet: vec!["calm".into()],
            speaking: vec!["loud1".into(), "loud2".into()],
        })
    }

    fn sample(at_ms: u64, readings: &[(&str, &[&str])]) -> Confirmed {
        Confirmed {
            at_ms,
            period_ms: 200,
            readings: readings
                .iter()
                .map(|(person, classes)| ((*person).to_owned(), Reading::Classes(set(classes))))
                .collect(),
        }
    }

    fn tile(rules_ok: bool) -> TileFound {
        TileFound {
            name: Name::clean("Test Guest A").unwrap(),
            previous: None,
            rules_ok,
            single: true,
        }
    }

    #[test]
    fn the_rule_tokens_read_a_marker() {
        let tokens = tokens();
        assert_eq!(
            tokens.classify(&set(&["base", "meter", "calm"])),
            Mark::Quiet
        );
        assert_eq!(
            tokens.classify(&set(&["base", "meter", "calm", "fade"])),
            Mark::Quiet
        );
        assert_eq!(
            tokens.classify(&set(&["base", "meter", "loud2"])),
            Mark::Speaking
        );
        assert_eq!(tokens.classify(&set(&["meter", "loud2"])), Mark::Unknown);
        assert_eq!(tokens.classify(&set(&["base", "meter"])), Mark::Unknown);
        assert!(!tokens.matches(&set(&["other"])));
        assert_eq!(
            format!("{tokens:?}"),
            "Tokens(<2 all, 1 quiet, 2 speaking>)"
        );
    }

    #[test]
    fn rules_mode_is_chosen_at_once_and_classifies_what_waited() {
        let mut classifier = Classifier::new(Some(tokens()));
        assert!(classifier
            .push(sample(0, &[("p1", &["base", "meter", "loud1"])]))
            .is_empty());
        let ready = classifier.decide(&[tile(true), tile(false), tile(true)]);
        assert_eq!(classifier.mode(), Some(Mode::Rules));
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].marks, [("p1".to_owned(), Mark::Speaking)]);
        let next = classifier.push(sample(200, &[("p1", &["base", "meter", "calm"])]));
        assert_eq!(next[0].marks, [("p1".to_owned(), Mark::Quiet)]);
    }

    #[test]
    fn fewer_than_three_tiles_decide_nothing() {
        let mut classifier = Classifier::new(Some(tokens()));
        for _ in 0..5 {
            classifier.decide(&[tile(false), tile(false)]);
        }
        assert_eq!(classifier.mode(), None);
    }

    #[test]
    fn without_matching_tokens_the_quiet_set_is_learned_after_thirty_seconds() {
        let mut classifier = Classifier::new(Some(tokens()));
        let tiles = [tile(false), tile(false), tile(false)];
        classifier.decide(&tiles);
        classifier.decide(&tiles);
        assert_eq!(classifier.mode(), None);
        classifier.decide(&tiles);
        assert_eq!(classifier.mode(), Some(Mode::Learned));
        let quiet: &[&str] = &["x1", "x2", "q"];
        let quiet_fading: &[&str] = &["x1", "x2", "q", "fade"];
        let loud: &[&str] = &["x1", "x2", "s", "fade"];
        let mut ready = Vec::new();
        for step in 0..=150u64 {
            let p1 = if (20..40).contains(&step) {
                loud
            } else {
                quiet
            };
            let p2 = if step == 41 { quiet_fading } else { quiet };
            ready.extend(
                classifier.push(sample(step * 200, &[("p1", p1), ("p2", p2), ("p3", quiet)])),
            );
            if step < 150 {
                assert!(ready.is_empty(), "nothing before 30 s of samples");
            }
        }
        assert_eq!(ready.len(), 151);
        let marks = |step: usize, person: usize| ready[step].marks[person].1;
        assert_eq!(marks(10, 0), Mark::Quiet);
        assert_eq!(marks(25, 0), Mark::Speaking);
        // A quiet marker with an extra class is still quiet.
        assert_eq!(marks(41, 1), Mark::Quiet);
        // Learned, it classifies at once.
        let now = classifier.push(sample(
            40_000,
            &[("p1", loud), ("p2", quiet), ("p3", quiet)],
        ));
        assert_eq!(now[0].marks[0].1, Mark::Speaking);
        assert_eq!(now[0].marks[1].1, Mark::Quiet);
    }

    #[test]
    fn most_tiles_changing_at_once_is_a_layout_change() {
        let quiet = set(&["a", "b"]);
        let changed: &[&str] = &["c"];
        let one = classify_learned(
            &quiet,
            sample(
                0,
                &[("p1", changed), ("p2", &["a", "b"]), ("p3", &["a", "b"])],
            ),
        );
        assert_eq!(one.marks[0].1, Mark::Speaking);
        let two = classify_learned(
            &quiet,
            sample(0, &[("p1", changed), ("p2", changed), ("p3", &["a", "b"])]),
        );
        assert_eq!(
            two.marks[1].1,
            Mark::Speaking,
            "two people may speak at once"
        );
        let all = classify_learned(
            &quiet,
            sample(0, &[("p1", changed), ("p2", changed), ("p3", changed)]),
        );
        assert!(all.marks.iter().all(|(_, mark)| *mark == Mark::Unknown));
    }

    #[test]
    fn a_short_recording_learns_from_what_it_has_or_says_unknown() {
        let mut classifier = Classifier::new(None);
        let tiles = [tile(false), tile(false), tile(false)];
        for _ in 0..MISSES_BEFORE_LEARNING {
            classifier.decide(&tiles);
        }
        let quiet: &[&str] = &["q"];
        for step in 0..5u64 {
            classifier.push(sample(
                step * 200,
                &[("p1", quiet), ("p2", quiet), ("p3", quiet)],
            ));
        }
        // 15 readings are too few to learn from.
        let done = classifier.finish();
        assert_eq!(done.len(), 5);
        assert!(done
            .iter()
            .all(|sample| sample.marks.iter().all(|(_, mark)| *mark == Mark::Unknown)));
    }

    #[test]
    fn tiles_take_turns_beyond_the_read_limit() {
        let all: Vec<usize> = (0..10).collect();
        let mut cursor = 0;
        // 30 reads a second at 5 Hz: six tiles a sample.
        let first = tiles_to_read(&all, SAMPLE_INTERVAL, &mut cursor);
        let second = tiles_to_read(&all, SAMPLE_INTERVAL, &mut cursor);
        assert_eq!(first, [0, 1, 2, 3, 4, 5]);
        assert_eq!(second, [0, 1, 6, 7, 8, 9]);
        // Three tiles fit.
        assert_eq!(
            tiles_to_read(&[0, 1, 2], SAMPLE_INTERVAL, &mut cursor),
            [0, 1, 2]
        );
        // Never more than twelve, even at one sample a second.
        let many: Vec<usize> = (0..20).collect();
        assert_eq!(tiles_to_read(&many, SLOW_SAMPLE_INTERVAL, &mut 0).len(), 12);
    }

    #[test]
    fn debug_shows_no_class_and_no_name() {
        let classifier = Classifier::new(Some(tokens()));
        let marker = Marker {
            tile: "element",
            marker: "element",
            name: Name::clean("Test Guest A").unwrap(),
            rules_ok: true,
            single: true,
        };
        let shown = format!(
            "{classifier:?} {marker:?} {:?} {:?}",
            set(&["loud1"]),
            tile(true)
        );
        for secret in ["loud1", "calm", "base", "Test", "Guest", "element"] {
            assert!(!shown.contains(secret), "{shown}");
        }
    }
}
