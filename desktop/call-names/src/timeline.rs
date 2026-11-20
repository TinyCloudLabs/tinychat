//! The speaking timeline of one recording: who spoke when, as person ids and times only.
//!
//! [`Tracker`] turns the samples of one recording into a [`Timeline`]:
//!
//! - **Confirmation.** A sample waits in memory until the next names tick. It counts only for a
//!   tile that the tick shows again as the same element, with the same marker, for the same
//!   person; the rest of it is dropped. A tick that did not look (it failed or ran out of time)
//!   leaves the samples waiting, for at most [`MAX_PENDING_MS`]. When the capture pauses or the
//!   recording ends there is no next tick: the waiting samples then count for each tile that the
//!   last tick itself showed again for the same person (a tile it showed for the first time
//!   counts for nothing). No window is read for that; a tile handed to another person in those
//!   last seconds is the risk taken.
//! - **Intervals**, per person id, on the recording's clock: from the first "speaking" sample to
//!   the last one plus one sample interval; two intervals closer than [`MERGE_GAP_MS`] are one; an
//!   interval of a single sample is dropped. No delay is subtracted here. `seen` spans say where
//!   the person's marker was read (quiet or speaking), merged the same way. One person in two
//!   tiles speaks when either tile does; two people may speak at once.
//! - **Pauses.** A pause closes every open interval; the resume is kept in `breaks` (the
//!   recording's clock stands still while paused, so a break is where the clock resumed).
//! - **Hidden.** While a names tick finds the call window minimised or behind another tab, the
//!   time from the tick before to the tick after is `hidden`.
//! - **Cap.** At most [`MAX_INTERVALS`] intervals in all; then `truncated`.
//!
//! The file ([`Timeline::to_json`]) is the object the frontend reads through
//! `call_names_speaking_read`:
//!
//! ```json
//! {"v":1,"app":"google-meet","mode":"rules","rules_version":3,"sample_ms":200,"self":"p1",
//!  "people":{"p2":{"speaking":[[12000,15400]],"seen":[[9000,600000]]}},
//!  "self_speaking":[[1000,4000]],"hidden":[[300000,312000]],"breaks":[420000],"truncated":false}
//! ```
//!
//! It holds no name and no class token: people are roster ids, and nothing else is text.
//!
//! `order` (optional, added within version 1): every roster person id of the recording, the
//! user's own included, in roster order (first seen first). The frontend numbers the other side
//! ("Them 1", "Them 2", …) by it after the names file is gone. A file without it is still read.

use crate::names::{json_error, Name, MAX_PEOPLE};
use crate::rules::App;
use crate::speaking::{
    Classified, Classifier, Confirmed, Found, Mark, Mode, Reading, SampleRead, Tokens,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The only timeline format.
pub const VERSION: u32 = 1;
/// Two intervals of one person closer than this are one.
pub const MERGE_GAP_MS: u64 = 1_000;
/// Most intervals in one timeline (speaking, seen, the user's own and hidden together).
pub const MAX_INTERVALS: usize = 20_000;
/// Most breaks in one timeline.
pub const MAX_BREAKS: usize = 1_000;
/// The largest timeline file read.
pub const MAX_TIMELINE_BYTES: u64 = 1024 * 1024;
/// Samples wait at most this long for a names tick to confirm them.
pub const MAX_PENDING_MS: u64 = 20_000;

/// `[start_ms, end_ms]` on the recording's clock.
pub type Span = [u64; 2];

/// The speaking timeline of one recording, as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Timeline {
    pub v: u32,
    pub app: App,
    pub mode: Mode,
    pub rules_version: u64,
    pub sample_ms: u64,
    /// The user's roster id, if the recording knows it.
    #[serde(rename = "self")]
    pub self_id: Option<String>,
    /// Everybody but the user, by roster id.
    pub people: BTreeMap<String, PersonTimeline>,
    pub self_speaking: Vec<Span>,
    pub hidden: Vec<Span>,
    pub breaks: Vec<u64>,
    pub truncated: bool,
    /// Every roster person id of the recording, the user's included, first seen first. Optional:
    /// absent in a file written before it existed, and left out while it is empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonTimeline {
    pub speaking: Vec<Span>,
    pub seen: Vec<Span>,
}

/// A roster id: `p` and a number.
fn is_person_id(id: &str) -> bool {
    id.len() >= 2
        && id.len() <= 8
        && id.starts_with('p')
        && id[1..].bytes().all(|byte| byte.is_ascii_digit())
}

/// Sorted, each span forward, none overlapping the next.
fn well_ordered(spans: &[Span]) -> bool {
    spans.iter().all(|[start, end]| start <= end)
        && spans.windows(2).all(|pair| pair[0][1] <= pair[1][0])
}

impl Timeline {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a timeline always serializes")
    }

    /// Parse a stored timeline and check it: this version, roster ids, ordered spans, the caps.
    /// An error never quotes the input.
    pub fn from_json(json: &str) -> Result<Timeline, String> {
        let parsed: Timeline = serde_json::from_str(json).map_err(|error| json_error(&error))?;
        if parsed.v != VERSION {
            return Err(format!("version {} is not {VERSION}", parsed.v));
        }
        if parsed
            .self_id
            .as_deref()
            .is_some_and(|id| !is_person_id(id))
        {
            return Err("self is not a person id".into());
        }
        let mut intervals = parsed.self_speaking.len() + parsed.hidden.len();
        for (id, person) in &parsed.people {
            if !is_person_id(id) || parsed.self_id.as_deref() == Some(id.as_str()) {
                return Err("a key of people is not another person's id".into());
            }
            if !well_ordered(&person.speaking) || !well_ordered(&person.seen) {
                return Err("spans out of order".into());
            }
            intervals += person.speaking.len() + person.seen.len();
        }
        if !well_ordered(&parsed.self_speaking) || !well_ordered(&parsed.hidden) {
            return Err("spans out of order".into());
        }
        if intervals > MAX_INTERVALS || parsed.breaks.len() > MAX_BREAKS {
            return Err("too many intervals".into());
        }
        let mut ordered = std::collections::HashSet::new();
        if parsed.order.len() > MAX_PEOPLE
            || !parsed
                .order
                .iter()
                .all(|id| is_person_id(id) && ordered.insert(id.as_str()))
        {
            return Err("order is not a list of distinct person ids".into());
        }
        if parsed.breaks.windows(2).any(|pair| pair[0] > pair[1]) {
            return Err("breaks out of order".into());
        }
        Ok(parsed)
    }
}

/// Spans that grow at the end: the open one and those closed before it.
#[derive(Clone, Debug, Default)]
struct Spans {
    closed: Vec<Span>,
    open: Option<Span>,
}

impl Spans {
    /// Extend the open span to `end` if `start` is within the merge gap of it; else close it and
    /// open `[start, end]`.
    fn add(&mut self, start: u64, end: u64, count: &mut Count) {
        match &mut self.open {
            Some(open) if start <= open[1].saturating_add(MERGE_GAP_MS) => {
                open[1] = open[1].max(end)
            }
            _ => {
                self.close(count);
                self.open = Some([start, end]);
            }
        }
    }

    fn close(&mut self, count: &mut Count) {
        if let Some(span) = self.open.take() {
            count.push(&mut self.closed, span);
        }
    }

    /// The closed spans and the open one, as the file shows them.
    fn all(&self) -> Vec<Span> {
        self.closed.iter().copied().chain(self.open).collect()
    }
}

/// The intervals kept so far, against [`MAX_INTERVALS`].
#[derive(Clone, Copy, Debug, Default)]
struct Count {
    intervals: usize,
    truncated: bool,
}

impl Count {
    fn push(&mut self, list: &mut Vec<Span>, span: Span) {
        if self.intervals >= MAX_INTERVALS {
            self.truncated = true;
            return;
        }
        // A span never starts before the one it follows (the recording's clock only moves on).
        if let Some(last) = list.last() {
            if span[0] < last[1] {
                return;
            }
        }
        list.push(span);
        self.intervals += 1;
    }
}

/// One person's speaking run that is still open.
#[derive(Clone, Copy, Debug)]
struct Run {
    start: u64,
    end: u64,
    samples: u32,
}

#[derive(Clone, Debug, Default)]
struct Track {
    speaking: Vec<Span>,
    run: Option<Run>,
    seen: Spans,
}

impl Track {
    fn observe(&mut self, at: u64, period: u64, mark: Mark, count: &mut Count) {
        if mark == Mark::Unknown {
            return;
        }
        let end = at.saturating_add(period);
        self.seen.add(at, end, count);
        match (&mut self.run, mark) {
            (Some(run), Mark::Speaking) if at <= run.end.saturating_add(MERGE_GAP_MS) => {
                run.end = run.end.max(end);
                run.samples += 1;
            }
            (_, Mark::Speaking) => {
                self.close_run(count);
                self.run = Some(Run {
                    start: at,
                    end,
                    samples: 1,
                });
            }
            (Some(run), _) if at > run.end.saturating_add(MERGE_GAP_MS) => self.close_run(count),
            _ => {}
        }
    }

    /// A run of one sample is dropped: a lone "on" with no other within the merge gap.
    fn close_run(&mut self, count: &mut Count) {
        if let Some(run) = self.run.take() {
            if run.samples >= 2 {
                count.push(&mut self.speaking, [run.start, run.end]);
            }
        }
    }

    fn close(&mut self, count: &mut Count) {
        self.close_run(count);
        self.seen.close(count);
    }

    fn speaking_now(&self) -> Vec<Span> {
        let open = self
            .run
            .filter(|run| run.samples >= 2)
            .map(|run| [run.start, run.end]);
        self.speaking.iter().copied().chain(open).collect()
    }
}

/// Builds the intervals of one recording from classified samples, in time order.
#[derive(Clone, Debug)]
pub struct TimelineBuilder {
    app: App,
    rules_version: u64,
    sample_ms: u64,
    mode: Option<Mode>,
    people: BTreeMap<String, Track>,
    hidden: Spans,
    breaks: Vec<u64>,
    count: Count,
    /// The time of the last names tick, where a hidden span may have begun.
    last_tick: Option<u64>,
    changed: bool,
    /// The roster's person ids, first seen first.
    order: Vec<String>,
}

impl TimelineBuilder {
    pub fn new(app: App, rules_version: u64, sample_ms: u64) -> Self {
        TimelineBuilder {
            app,
            rules_version,
            sample_ms,
            mode: None,
            people: BTreeMap::new(),
            hidden: Spans::default(),
            breaks: Vec::new(),
            count: Count::default(),
            last_tick: None,
            changed: false,
            order: Vec::new(),
        }
    }

    /// The roster's person ids as they are now, first seen first (at most [`MAX_PEOPLE`]).
    pub fn set_order(&mut self, ids: &[String]) {
        let ids = &ids[..ids.len().min(MAX_PEOPLE)];
        if self.order != ids {
            self.order = ids.to_vec();
            self.changed = true;
        }
    }

    pub fn set_mode(&mut self, mode: Option<Mode>) {
        if mode.is_some() && mode != self.mode {
            self.mode = mode;
            self.changed = true;
        }
    }

    /// One classified sample. A person in two tiles speaks when either tile does.
    pub fn observe(&mut self, sample: &Classified) {
        let mut marks: BTreeMap<&str, Mark> = BTreeMap::new();
        for (person, mark) in &sample.marks {
            let best = marks.entry(person.as_str()).or_insert(Mark::Unknown);
            *best = match (*best, *mark) {
                (Mark::Speaking, _) | (_, Mark::Speaking) => Mark::Speaking,
                (Mark::Quiet, _) | (_, Mark::Quiet) => Mark::Quiet,
                _ => Mark::Unknown,
            };
        }
        for (person, mark) in marks {
            if mark == Mark::Unknown {
                continue;
            }
            let track = self.people.entry(person.to_owned()).or_default();
            track.observe(sample.at_ms, sample.period_ms, mark, &mut self.count);
            self.changed = true;
        }
    }

    /// A names tick at `at_ms` found the call window hidden or not.
    pub fn hidden(&mut self, at_ms: u64, hidden: bool) {
        let since = self.last_tick.unwrap_or(at_ms).min(at_ms);
        self.last_tick = Some(at_ms);
        match (&mut self.hidden.open, hidden) {
            (Some(open), _) => {
                open[1] = open[1].max(at_ms);
                if !hidden {
                    self.hidden.close(&mut self.count);
                }
                self.changed = true;
            }
            (None, true) => {
                self.hidden.open = Some([since, at_ms]);
                self.changed = true;
            }
            (None, false) => {}
        }
    }

    /// The capture paused: close every open interval.
    pub fn pause(&mut self) {
        for track in self.people.values_mut() {
            track.close(&mut self.count);
        }
        self.hidden.close(&mut self.count);
        self.last_tick = None;
        self.changed = true;
    }

    /// The capture resumed at `at_ms` on its clock.
    pub fn resume(&mut self, at_ms: u64) {
        if self.breaks.last() == Some(&at_ms) {
            return;
        }
        if self.breaks.len() == MAX_BREAKS {
            self.count.truncated = true;
            return;
        }
        if self.breaks.last().is_none_or(|last| *last < at_ms) {
            self.breaks.push(at_ms);
            self.changed = true;
        }
    }

    /// Something the file shows changed since [`TimelineBuilder::saved`].
    pub fn changed(&self) -> bool {
        self.changed
    }

    pub fn saved(&mut self) {
        self.changed = false;
    }

    /// The timeline as it is now, with open intervals shown as closed. `None` before the mode is
    /// known or before any marker was read.
    pub fn timeline(&self, self_id: Option<&str>) -> Option<Timeline> {
        let mode = self.mode?;
        if self.people.is_empty() {
            return None;
        }
        let mut people = BTreeMap::new();
        let mut self_speaking = Vec::new();
        let mut intervals = self.count.intervals;
        let mut truncated = self.count.truncated;
        let mut room = |spans: Vec<Span>, closed: usize| -> Vec<Span> {
            // The open spans are counted here; past the cap they are left out.
            let open = spans.len().saturating_sub(closed);
            if intervals + open > MAX_INTERVALS {
                truncated = true;
                return spans[..closed.min(spans.len())].to_vec();
            }
            intervals += open;
            spans
        };
        for (id, track) in &self.people {
            let speaking = room(track.speaking_now(), track.speaking.len());
            let seen = room(track.seen.all(), track.seen.closed.len());
            if Some(id.as_str()) == self_id {
                self_speaking = speaking;
            } else {
                people.insert(id.clone(), PersonTimeline { speaking, seen });
            }
        }
        let hidden = room(self.hidden.all(), self.hidden.closed.len());
        Some(Timeline {
            v: VERSION,
            app: self.app,
            mode,
            rules_version: self.rules_version,
            sample_ms: self.sample_ms,
            self_id: self_id.filter(|id| is_person_id(id)).map(str::to_owned),
            people,
            self_speaking,
            hidden,
            breaks: self.breaks.clone(),
            truncated,
            order: self.order.clone(),
        })
    }
}

/// What the status file says about speaking: counts and the mode, never a name or a class.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    /// Samples taken in this recording.
    pub samples: u64,
    /// Samples with at least one marker not read, or out of time.
    pub unknown: u64,
    /// Tiles followed after the last names tick.
    pub tiles: usize,
    pub mode: Option<Mode>,
}

/// A sample that waits for the next names tick.
#[derive(Clone, Debug)]
struct Pending {
    at_ms: u64,
    period_ms: u64,
    readings: Vec<(usize, Reading)>,
}

/// The speaking state of one recording: the followed tiles, the samples that wait for a names
/// tick, the classifier and the builder.
pub struct Tracker {
    builder: TimelineBuilder,
    classifier: Classifier,
    /// Per tile of the last names tick that looked: the person it belongs to, when followed.
    slots: Vec<Option<String>>,
    /// Per tile of that tick: it showed the tile again, as the same element, for the same person.
    confirmed: Vec<bool>,
    pending: Vec<Pending>,
    paused: bool,
    counts: Counts,
}

impl Tracker {
    pub fn new(app: App, rules_version: u64, sample_ms: u64, tokens: Option<Tokens>) -> Self {
        Tracker {
            builder: TimelineBuilder::new(app, rules_version, sample_ms),
            classifier: Classifier::new(tokens),
            slots: Vec::new(),
            confirmed: Vec::new(),
            pending: Vec::new(),
            paused: false,
            counts: Counts::default(),
        }
    }

    /// A names tick at `at_ms`. `found` is what it found (`None`: it did not look, so the samples
    /// keep waiting), and `person` gives the roster id of a name.
    pub fn tick(
        &mut self,
        at_ms: u64,
        found: Option<&Found>,
        person: impl Fn(&Name) -> Option<String>,
    ) {
        let Some(found) = found else {
            self.pending
                .retain(|sample| at_ms.saturating_sub(sample.at_ms) <= MAX_PENDING_MS);
            return;
        };
        let ids: Vec<Option<String>> = found.tiles.iter().map(|tile| person(&tile.name)).collect();
        // The waiting samples count for the tiles this tick shows again, for the same person.
        for sample in std::mem::take(&mut self.pending) {
            let readings: Vec<(String, Reading)> = sample
                .readings
                .into_iter()
                .filter_map(|(slot, reading)| {
                    let id = self.slots.get(slot)?.as_ref()?;
                    let again =
                        found.tiles.iter().zip(&ids).any(|(tile, new)| {
                            tile.previous == Some(slot) && new.as_ref() == Some(id)
                        });
                    again.then(|| (id.clone(), reading))
                })
                .collect();
            if readings.is_empty() {
                continue;
            }
            let ready = self.classifier.push(Confirmed {
                at_ms: sample.at_ms,
                period_ms: sample.period_ms,
                readings,
            });
            self.observe(ready);
        }
        let ready = self.classifier.decide(&found.tiles);
        self.observe(ready);
        self.builder.set_mode(self.classifier.mode());
        self.builder.hidden(at_ms, found.hidden);
        self.confirmed = found
            .tiles
            .iter()
            .zip(&ids)
            .map(|(tile, id)| {
                let before = tile
                    .previous
                    .and_then(|old| self.slots.get(old).cloned().flatten());
                id.is_some() && before == *id
            })
            .collect();
        self.slots = found
            .tiles
            .iter()
            .zip(ids)
            .map(|(tile, id)| id.filter(|_| self.classifier.follows(tile)))
            .collect();
        self.counts.tiles = self.followed().len();
        self.counts.mode = self.classifier.mode();
    }

    /// The tiles a sample reads now, by their index in the last names tick.
    pub fn followed(&self) -> Vec<usize> {
        if self.slots.iter().flatten().count() < crate::rules::MIN_SPEAKING_TILES {
            return Vec::new();
        }
        (0..self.slots.len())
            .filter(|&slot| self.slots[slot].is_some())
            .collect()
    }

    /// Stop following every tile until the next names tick (the sample found the app resting,
    /// or the permission missing).
    pub fn unfollow(&mut self) {
        self.slots.clear();
        self.confirmed.clear();
        self.counts.tiles = 0;
    }

    /// One sample, taken at `at_ms` on the recording's clock. It waits for the next names tick.
    pub fn sample(&mut self, at_ms: u64, period_ms: u64, read: SampleRead) {
        if read.readings.is_empty() {
            return;
        }
        self.counts.samples += 1;
        if read
            .readings
            .iter()
            .any(|(_, reading)| !matches!(reading, Reading::Classes(_)))
        {
            self.counts.unknown += 1;
        }
        self.pending.push(Pending {
            at_ms,
            period_ms,
            readings: read.readings,
        });
    }

    /// The capture paused: the waiting samples count for the tiles the last names tick confirmed
    /// (see the module documentation), then open intervals close.
    pub fn pause(&mut self) {
        if !self.paused {
            self.accept_pending();
            self.paused = true;
            self.builder.pause();
        }
    }

    /// Without a next names tick: keep the waiting readings of each tile whose person the last
    /// tick confirmed, and drop the rest.
    fn accept_pending(&mut self) {
        for sample in std::mem::take(&mut self.pending) {
            let readings: Vec<(String, Reading)> = sample
                .readings
                .into_iter()
                .filter_map(|(slot, reading)| {
                    let id = self.slots.get(slot)?.as_ref()?;
                    let confirmed = self.confirmed.get(slot).copied().unwrap_or(false);
                    confirmed.then(|| (id.clone(), reading))
                })
                .collect();
            if readings.is_empty() {
                continue;
            }
            let ready = self.classifier.push(Confirmed {
                at_ms: sample.at_ms,
                period_ms: sample.period_ms,
                readings,
            });
            self.observe(ready);
        }
    }

    /// The capture is live again at `at_ms`: after a pause, that is a break.
    pub fn resume(&mut self, at_ms: u64) {
        if std::mem::take(&mut self.paused) {
            self.builder.resume(at_ms);
        }
    }

    /// The recording ended: the waiting samples count for the tiles the last names tick
    /// confirmed, and what the classifier still holds is classified if it can be.
    pub fn finish(&mut self) {
        self.accept_pending();
        let ready = self.classifier.finish();
        self.observe(ready);
        self.pause();
    }

    pub fn counts(&self) -> Counts {
        self.counts
    }

    /// The roster's person ids, the user's included, first seen first: the timeline's `order`.
    pub fn set_order(&mut self, ids: &[String]) {
        self.builder.set_order(ids);
    }

    /// A preliminary look at a sample, before any names tick confirmed it: each tile read, its
    /// person and its mark as the classifier reads it now (unknown before a mode, or while the
    /// learned mode learns). For a developer's tool; the timeline does not use it.
    pub fn preview(&self, read: &SampleRead) -> Vec<(usize, Option<String>, Mark)> {
        read.readings
            .iter()
            .map(|(slot, reading)| {
                let person = self.slots.get(*slot).cloned().flatten();
                (*slot, person, self.classifier.preview(reading))
            })
            .collect()
    }

    pub fn changed(&self) -> bool {
        self.builder.changed()
    }

    pub fn saved(&mut self) {
        self.builder.saved();
    }

    /// The timeline as it is now; `self_id` is the user's roster id, if known.
    pub fn timeline(&self, self_id: Option<&str>) -> Option<Timeline> {
        self.builder.timeline(self_id)
    }

    fn observe(&mut self, ready: Vec<Classified>) {
        for sample in &ready {
            self.builder.observe(sample);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(at_ms: u64, marks: &[(&str, Mark)]) -> Classified {
        Classified {
            at_ms,
            period_ms: 200,
            marks: marks
                .iter()
                .map(|(person, mark)| ((*person).to_owned(), *mark))
                .collect(),
        }
    }

    fn builder() -> TimelineBuilder {
        let mut builder = TimelineBuilder::new(App::GoogleMeet, 3, 200);
        builder.set_mode(Some(Mode::Rules));
        builder
    }

    /// `on` for the sample times given (ms), quiet for every other 200 ms step up to `until`.
    fn feed(builder: &mut TimelineBuilder, person: &str, on: &[u64], until: u64) {
        for at in (0..=until).step_by(200) {
            let mark = if on.contains(&at) {
                Mark::Speaking
            } else {
                Mark::Quiet
            };
            builder.observe(&sample(at, &[(person, mark)]));
        }
    }

    #[test]
    fn an_interval_runs_from_the_first_on_to_the_last_on_plus_one_sample() {
        let mut builder = builder();
        feed(&mut builder, "p2", &[1000, 1200, 1400], 5000);
        let timeline = builder.timeline(None).unwrap();
        assert_eq!(timeline.people["p2"].speaking, [[1000, 1600]]);
        assert_eq!(timeline.people["p2"].seen, [[0, 5200]]);
    }

    #[test]
    fn gaps_up_to_one_second_merge_and_a_lone_sample_is_dropped() {
        let mut builder = builder();
        // 1000-1400, a 0.8 s pause, 2200-2400: one interval. 5000 alone: dropped.
        // 8000-8200, then 9400-9600: 1.0 s after 8400 still merges; 11000+ does not.
        feed(
            &mut builder,
            "p2",
            &[
                1000, 1200, 2200, 2400, 5000, 8000, 8200, 9400, 9600, 11000, 11200,
            ],
            12000,
        );
        let timeline = builder.timeline(None).unwrap();
        assert_eq!(
            timeline.people["p2"].speaking,
            [[1000, 2600], [8000, 9800], [11000, 11400]]
        );
    }

    #[test]
    fn two_people_at_once_are_both_kept_and_one_person_in_two_tiles_counts_once() {
        let mut builder = builder();
        for at in (0..=2000).step_by(200) {
            let on = (400..=1200).contains(&at);
            let p2 = if on { Mark::Speaking } else { Mark::Quiet };
            // p3 shows in two tiles: one of them quiet, one speaking.
            builder.observe(&sample(
                at,
                &[
                    ("p2", p2),
                    ("p3", Mark::Quiet),
                    ("p3", p2),
                    ("p4", Mark::Unknown),
                ],
            ));
        }
        let timeline = builder.timeline(None).unwrap();
        assert_eq!(timeline.people["p2"].speaking, [[400, 1400]]);
        assert_eq!(timeline.people["p3"].speaking, [[400, 1400]]);
        // Never read: not in the file.
        assert!(!timeline.people.contains_key("p4"));
    }

    #[test]
    fn unknown_samples_are_not_seen_and_a_vanished_tile_ends_its_spans() {
        let mut builder = builder();
        for at in (0..=10_000).step_by(200) {
            let p2 = match at {
                0..=2000 => Mark::Quiet,
                2200..=6000 => Mark::Unknown,
                _ => Mark::Quiet,
            };
            let mut marks = vec![("p2", p2)];
            // p3's tile goes away after 3 s.
            if at <= 3000 {
                marks.push((
                    "p3",
                    if at >= 1000 {
                        Mark::Speaking
                    } else {
                        Mark::Quiet
                    },
                ));
            }
            builder.observe(&sample(at, &marks));
        }
        let timeline = builder.timeline(None).unwrap();
        assert_eq!(timeline.people["p2"].seen, [[0, 2200], [6200, 10_200]]);
        assert_eq!(timeline.people["p3"].speaking, [[1000, 3200]]);
        assert_eq!(timeline.people["p3"].seen, [[0, 3200]]);
    }

    #[test]
    fn a_pause_closes_intervals_and_the_resume_is_a_break() {
        let mut builder = builder();
        feed(&mut builder, "p2", &[1000, 1200, 1400], 1400);
        builder.pause();
        builder.resume(1600);
        // The clock stood still: the next samples follow at once.
        for at in [1600u64, 1800, 2000] {
            builder.observe(&sample(at, &[("p2", Mark::Speaking)]));
        }
        let timeline = builder.timeline(None).unwrap();
        assert_eq!(timeline.people["p2"].speaking, [[1000, 1600], [1600, 2200]]);
        assert_eq!(timeline.breaks, [1600]);
        assert_eq!(timeline.people["p2"].seen, [[0, 1600], [1600, 2200]]);
    }

    #[test]
    fn hidden_spans_reach_from_the_tick_before_to_the_tick_after() {
        let mut builder = builder();
        feed(&mut builder, "p2", &[], 1000);
        builder.hidden(0, false);
        builder.hidden(5_000, false);
        builder.hidden(10_000, true);
        builder.hidden(15_000, true);
        builder.hidden(20_000, false);
        builder.hidden(25_000, true);
        let timeline = builder.timeline(None).unwrap();
        assert_eq!(timeline.hidden, [[5_000, 20_000], [20_000, 25_000]]);
    }

    #[test]
    fn the_user_goes_to_self_speaking_and_not_to_people() {
        let mut builder = builder();
        feed(&mut builder, "p1", &[200, 400], 1000);
        feed(&mut builder, "p2", &[600, 800], 1000);
        let timeline = builder.timeline(Some("p1")).unwrap();
        assert_eq!(timeline.self_id.as_deref(), Some("p1"));
        assert_eq!(timeline.self_speaking, [[200, 600]]);
        assert_eq!(timeline.people.keys().collect::<Vec<_>>(), ["p2"]);
        let without = builder.timeline(None).unwrap();
        assert_eq!(without.self_id, None);
        assert!(without.people.contains_key("p1"));
        assert!(without.to_json().contains("\"self\":null"));
    }

    #[test]
    fn nothing_is_written_before_a_mode_or_a_reading() {
        let mut builder = TimelineBuilder::new(App::GoogleMeet, 3, 200);
        builder.observe(&sample(0, &[("p2", Mark::Quiet)]));
        assert_eq!(builder.timeline(None), None);
        let mut builder = TimelineBuilder::new(App::GoogleMeet, 3, 200);
        builder.set_mode(Some(Mode::Learned));
        builder.observe(&sample(0, &[("p2", Mark::Unknown)]));
        assert_eq!(builder.timeline(None), None);
    }

    #[test]
    fn past_twenty_thousand_intervals_the_timeline_is_truncated() {
        let mut builder = builder();
        // Each 4 s: one 400 ms interval and one seen span (the gap breaks both).
        let mut at = 0;
        for _ in 0..10_100 {
            builder.observe(&sample(at, &[("p2", Mark::Speaking)]));
            builder.observe(&sample(at + 200, &[("p2", Mark::Speaking)]));
            at += 4_000;
        }
        let timeline = builder.timeline(None).unwrap();
        assert!(timeline.truncated);
        let person = &timeline.people["p2"];
        assert!(person.speaking.len() + person.seen.len() <= MAX_INTERVALS);
        assert!(Timeline::from_json(&timeline.to_json()).is_ok());
    }

    #[test]
    fn the_file_round_trips_and_a_bad_one_is_refused_without_quoting_it() {
        let mut builder = builder();
        feed(&mut builder, "p2", &[200, 400], 1000);
        builder.resume(5000);
        let timeline = builder.timeline(Some("p1")).unwrap();
        let json = timeline.to_json();
        assert_eq!(
            json,
            r#"{"v":1,"app":"google-meet","mode":"rules","rules_version":3,"sample_ms":200,"self":"p1","people":{"p2":{"speaking":[[200,600]],"seen":[[0,1200]]}},"self_speaking":[],"hidden":[],"breaks":[5000],"truncated":false}"#
        );
        assert_eq!(Timeline::from_json(&json).unwrap(), timeline);
        for bad in [
            json.replace("\"v\":1", "\"v\":2"),
            json.replace("\"p2\"", "\"Zebra Quartz\""),
            json.replace("\"p2\"", "\"p1\""),
            json.replace("[[200,600]]", "[[600,200]]"),
            json.replace("[[200,600]]", "[[200,600],[500,700]]"),
            json.replace("\"mode\":\"rules\"", "\"mode\":\"Zebra Quartz\""),
            json.replace(
                "\"truncated\":false",
                "\"truncated\":false,\"names\":[\"Zebra Quartz\"]",
            ),
            json.replace("\"self\":\"p1\"", "\"self\":\"Zebra Quartz\""),
        ] {
            let error = Timeline::from_json(&bad).unwrap_err();
            assert!(
                !error.contains("Zebra") && !error.contains("Quartz"),
                "{error}"
            );
        }
    }

    #[test]
    fn the_order_lists_every_roster_id_and_is_checked_when_read() {
        let mut builder = builder();
        feed(&mut builder, "p2", &[200, 400], 1000);
        let without = builder.timeline(Some("p1")).unwrap().to_json();
        assert!(
            !without.contains("\"order\""),
            "left out while empty: {without}"
        );
        let ids = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        builder.saved();
        builder.set_order(&ids(&["p1", "p2"]));
        assert!(builder.changed());
        builder.saved();
        builder.set_order(&ids(&["p1", "p2"]));
        assert!(!builder.changed(), "the same order changes nothing");
        builder.set_order(&ids(&["p1", "p2", "p3"]));
        let timeline = builder.timeline(Some("p1")).unwrap();
        assert_eq!(timeline.order, ["p1", "p2", "p3"]);
        let json = timeline.to_json();
        assert!(
            json.ends_with(r#""truncated":false,"order":["p1","p2","p3"]}"#),
            "{json}"
        );
        assert_eq!(Timeline::from_json(&json).unwrap(), timeline);
        // A file without it (written before it existed) still reads.
        assert_eq!(
            Timeline::from_json(&without).unwrap().order,
            Vec::<String>::new()
        );
        for bad in [
            json.replace(r#""order":["p1","p2","p3"]"#, r#""order":["p1","p1"]"#),
            json.replace(r#""order":["p1","p2","p3"]"#, r#""order":["Zebra Quartz"]"#),
        ] {
            let error = Timeline::from_json(&bad).unwrap_err();
            assert!(!error.contains("Zebra"), "{error}");
        }
    }

    #[test]
    fn a_two_hour_call_stays_far_below_the_size_limit() {
        // Six people, 7,200 s at 5 Hz, a turn of 4 s every 20 s per person in round, pauses
        // inside turns, everybody seen throughout: the busiest plausible meeting.
        let mut builder = builder();
        let people: Vec<String> = (1..=6).map(|n| format!("p{n}")).collect();
        for step in 0..(7_200 * 5) {
            let at = step as u64 * 200;
            let speaker = (at / 20_000) as usize % people.len();
            let in_turn = at % 20_000 < 4_000 && at % 1_400 > 300;
            let marks: Vec<(String, Mark)> = people
                .iter()
                .enumerate()
                .map(|(index, id)| {
                    let on = in_turn && index == speaker;
                    (id.clone(), if on { Mark::Speaking } else { Mark::Quiet })
                })
                .collect();
            builder.observe(&Classified {
                at_ms: at,
                period_ms: 200,
                marks,
            });
        }
        let json = builder.timeline(Some("p1")).unwrap().to_json();
        assert!(json.len() < 64 * 1024, "{} bytes", json.len());
        assert!((json.len() as u64) < MAX_TIMELINE_BYTES / 10);
    }
}
