//! The people seen during one recording.
//!
//! Each tick's [`Extraction`] is added with the recording's audio clock (`audio_ms`). People get
//! stable ids `p1`, `p2`, … in first-seen order. Equal names are one person, wherever they show:
//! one account that joins on two devices is two rows with one name in a participant list, and one
//! person can fill two tiles. Two people who share a display name cannot be told apart from that,
//! so they are one entry as well.
//!
//! A person is `self` only when the window marked that entry, and a recording has at most one
//! `self`. A guest chooses their own display name and can imitate the mark, so:
//! - a source that marks more than one entry in a tick, or two sources that mark different names,
//!   mark nobody in that tick;
//! - once a person is `self`, a later mark on a different name is a dispute: nobody is `self` for
//!   the rest of the recording. Without a `self`, the frontend makes no 1:1 suggestion.
//!
//! [`Roster::participants`] is the `call_participants` object the frontend reads:
//!
//! ```json
//! {"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"…","self":true},{"id":"p2","name":"…"}],"truncated":false}
//! ```

use crate::extract::Extraction;
use crate::names::{json_error, Name, MAX_PEOPLE};
use crate::rules::App;
use serde::{Deserialize, Serialize};

/// One person, with when they were first and last seen on the recording's audio clock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    pub id: String,
    pub name: Name,
    pub is_self: bool,
    pub first_ms: u64,
    pub last_ms: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Roster {
    app: Option<App>,
    people: Vec<Person>,
    truncated: bool,
    /// Two different people were marked self at different times; nobody is self any more.
    self_disputed: bool,
}

impl Roster {
    pub fn new() -> Self {
        Roster::default()
    }

    pub fn app(&self) -> Option<App> {
        self.app
    }

    pub fn people(&self) -> &[Person] {
        &self.people
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// Add one tick. Returns true when the participants object changed (people, `self` marks or
    /// `truncated`), which is when it should be saved again. A tick from another app than the
    /// first one seen is ignored.
    pub fn observe(&mut self, audio_ms: u64, extraction: &Extraction) -> bool {
        if self.app.is_some_and(|app| app != extraction.app) {
            return false;
        }
        // The names this tick shows, in the order met.
        let mut order: Vec<&Name> = Vec::new();
        // The names this tick marks as the local user. A source with more than one mark gives none.
        let mut selves: Vec<&Name> = Vec::new();
        for source in &extraction.sources {
            for entry in &source.entries {
                if !order.contains(&&entry.name) {
                    order.push(&entry.name);
                }
            }
            let mut marked = source.entries.iter().filter(|entry| entry.is_self);
            if let (Some(entry), None) = (marked.next(), marked.next()) {
                if !selves.contains(&&entry.name) {
                    selves.push(&entry.name);
                }
            }
        }
        let mut changed = false;
        if extraction.truncated && !self.truncated {
            self.truncated = true;
            changed = true;
        }
        if order.is_empty() {
            return changed;
        }
        self.app = Some(extraction.app);
        for name in order {
            if let Some(person) = self.people.iter_mut().find(|person| &person.name == name) {
                person.last_ms = person.last_ms.max(audio_ms);
            } else if self.people.len() == MAX_PEOPLE {
                changed |= !self.truncated;
                self.truncated = true;
            } else {
                let id = format!("p{}", self.people.len() + 1);
                self.people.push(Person {
                    id,
                    name: name.clone(),
                    is_self: false,
                    first_ms: audio_ms,
                    last_ms: audio_ms,
                });
                changed = true;
            }
        }
        if let [name] = selves.as_slice() {
            changed |= self.mark_self(name);
        }
        changed
    }

    /// Mark the person of this name as the local user. Returns true when a mark changed.
    fn mark_self(&mut self, name: &Name) -> bool {
        if self.self_disputed {
            return false;
        }
        match self.people.iter().position(|person| person.is_self) {
            Some(index) if &self.people[index].name == name => false,
            Some(index) => {
                // A second, different person carries the mark: trust neither.
                self.people[index].is_self = false;
                self.self_disputed = true;
                true
            }
            None => match self.people.iter_mut().find(|person| &person.name == name) {
                Some(person) => {
                    person.is_self = true;
                    true
                }
                None => false,
            },
        }
    }

    /// The `call_participants` object; `None` until someone has been seen.
    pub fn participants(&self) -> Option<CallParticipants> {
        let app = self.app?;
        Some(CallParticipants {
            v: CallParticipants::VERSION,
            source: ParticipantsSource::CallWindow,
            app,
            people: self
                .people
                .iter()
                .map(|person| Participant {
                    id: person.id.clone(),
                    name: person.name.clone(),
                    is_self: person.is_self,
                })
                .collect(),
            truncated: self.truncated,
        })
    }
}

/// The `call_participants` object stored with the recording.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallParticipants {
    pub v: u32,
    pub source: ParticipantsSource,
    pub app: App,
    pub people: Vec<Participant>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParticipantsSource {
    #[serde(rename = "call_window")]
    CallWindow,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Participant {
    pub id: String,
    pub name: Name,
    #[serde(rename = "self", default, skip_serializing_if = "std::ops::Not::not")]
    pub is_self: bool,
}

impl CallParticipants {
    pub const VERSION: u32 = 1;

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("participants always serialize")
    }

    /// Parse a saved object, refusing other versions and more than [`MAX_PEOPLE`] people.
    pub fn from_json(json: &str) -> Result<CallParticipants, String> {
        // serde's own message can quote the text it choked on, which may be a name.
        let parsed: CallParticipants =
            serde_json::from_str(json).map_err(|error| json_error(&error))?;
        if parsed.v != Self::VERSION {
            return Err(format!("version {} is not {}", parsed.v, Self::VERSION));
        }
        if parsed.people.len() > MAX_PEOPLE {
            return Err(format!(
                "{} people; the limit is {MAX_PEOPLE}",
                parsed.people.len()
            ));
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::{Entry, SourceNames};

    fn entry(name: &str, is_self: bool) -> Entry {
        Entry {
            name: Name::clean(name).unwrap(),
            is_self,
        }
    }

    fn tick(app: App, sources: Vec<(&str, bool, Vec<Entry>)>) -> Extraction {
        Extraction {
            app,
            sources: sources
                .into_iter()
                .map(|(id, one_per_person, entries)| SourceNames {
                    id: id.into(),
                    one_per_person,
                    entries,
                })
                .collect(),
            truncated: false,
        }
    }

    fn panel(entries: Vec<Entry>) -> Extraction {
        tick(
            App::GoogleMeet,
            vec![("panel", true, entries), ("tiles", false, vec![])],
        )
    }

    fn tiles(entries: Vec<Entry>) -> Extraction {
        tick(
            App::GoogleMeet,
            vec![("panel", true, vec![]), ("tiles", false, entries)],
        )
    }

    fn summary(roster: &Roster) -> Vec<(String, String, bool)> {
        roster
            .people()
            .iter()
            .map(|p| (p.id.clone(), p.name.as_str().to_owned(), p.is_self))
            .collect()
    }

    #[test]
    fn ids_follow_first_seen_order_across_ticks() {
        let mut roster = Roster::new();
        assert!(roster.observe(1_000, &tiles(vec![entry("Robin Sample", false)])));
        assert!(roster.observe(
            6_000,
            &panel(vec![
                entry("Alex Example", true),
                entry("Robin Sample", false)
            ])
        ));
        assert!(!roster.observe(
            11_000,
            &panel(vec![
                entry("Alex Example", true),
                entry("Robin Sample", false)
            ])
        ));
        assert_eq!(
            summary(&roster),
            [
                ("p1".into(), "Robin Sample".into(), false),
                ("p2".into(), "Alex Example".into(), true)
            ]
        );
        assert_eq!(
            (roster.people()[0].first_ms, roster.people()[0].last_ms),
            (1_000, 11_000)
        );
        assert_eq!(roster.people()[1].first_ms, 6_000);
    }

    #[test]
    fn self_mark_comes_from_the_window_and_stays() {
        let mut roster = Roster::new();
        roster.observe(0, &tiles(vec![entry("Alex Example", false)]));
        assert!(!roster.people()[0].is_self);
        assert!(roster.observe(5_000, &panel(vec![entry("Alex Example", true)])));
        assert!(roster.people()[0].is_self);
        assert!(!roster.observe(10_000, &tiles(vec![entry("Alex Example", false)])));
        assert!(roster.people()[0].is_self);
    }

    fn selves(roster: &Roster) -> Vec<&str> {
        roster
            .people()
            .iter()
            .filter(|person| person.is_self)
            .map(|person| person.name.as_str())
            .collect()
    }

    #[test]
    fn a_recording_has_at_most_one_self() {
        let mut roster = Roster::new();
        roster.observe(
            0,
            &panel(vec![
                entry("Alex Example", true),
                entry("Robin Sample", false),
            ]),
        );
        assert_eq!(selves(&roster), ["Alex Example"]);
        // A later tick marks a different person: that is a dispute, and nobody is self any more.
        assert!(roster.observe(5_000, &panel(vec![entry("Robin Sample", true)])));
        assert!(selves(&roster).is_empty());
        // The dispute lasts for the recording, whatever later ticks show.
        let clean = panel(vec![
            entry("Alex Example", true),
            entry("Robin Sample", false),
        ]);
        assert!(!roster.observe(10_000, &clean));
        assert!(selves(&roster).is_empty());
        let json = roster.participants().unwrap().to_json();
        assert!(!json.contains("\"self\""), "{json}");
        assert_eq!(roster.people().len(), 2);
    }

    #[test]
    fn two_self_marks_in_one_source_mark_nobody_in_that_tick() {
        let mut roster = Roster::new();
        roster.observe(
            0,
            &panel(vec![entry("Alex Example", true), entry("Mallory", true)]),
        );
        assert!(selves(&roster).is_empty());
        assert_eq!(roster.people().len(), 2);
        // That tick decided nothing; a tick with one mark still counts.
        let clean = panel(vec![entry("Alex Example", true), entry("Mallory", false)]);
        assert!(roster.observe(5_000, &clean));
        assert_eq!(selves(&roster), ["Alex Example"]);
    }

    #[test]
    fn two_sources_that_mark_different_names_mark_nobody_in_that_tick() {
        let mut roster = Roster::new();
        let split = tick(
            App::GoogleMeet,
            vec![
                ("panel", true, vec![entry("Alex Example", true)]),
                ("other", true, vec![entry("Mallory", true)]),
            ],
        );
        roster.observe(0, &split);
        assert!(selves(&roster).is_empty());
        // Two sources that agree are one mark.
        let agree = tick(
            App::GoogleMeet,
            vec![
                ("panel", true, vec![entry("Alex Example", true)]),
                ("other", true, vec![entry("Alex Example", true)]),
            ],
        );
        assert!(roster.observe(5_000, &agree));
        assert_eq!(selves(&roster), ["Alex Example"]);
    }

    #[test]
    fn a_parse_error_never_quotes_the_input() {
        let json =
            r#"{"v":1,"source":"call_window","app":"Zebra Quartz","people":[],"truncated":false}"#;
        let error = CallParticipants::from_json(json).unwrap_err();
        assert!(
            !error.contains("Zebra") && !error.contains("Quartz"),
            "{error}"
        );
        assert!(
            error.starts_with("data error at line 1, column "),
            "{error}"
        );
        let error = CallParticipants::from_json("{\"v\":1,\"people\":[\"Zebra Quartz").unwrap_err();
        assert!(!error.contains("Zebra"), "{error}");
        assert!(error.starts_with("end of input error"), "{error}");
    }

    #[test]
    fn the_same_name_twice_in_a_participant_list_is_one_person() {
        // One account that joins on two devices is two rows with one name.
        let mut roster = Roster::new();
        let rows = panel(vec![
            entry("Alex Example", true),
            entry("Robin Sample", false),
            entry("Robin Sample", false),
        ]);
        assert!(roster.observe(0, &rows));
        assert_eq!(
            summary(&roster),
            [
                ("p1".into(), "Alex Example".into(), true),
                ("p2".into(), "Robin Sample".into(), false)
            ]
        );
        // The same rows in later ticks, from either source, add nobody.
        assert!(!roster.observe(5_000, &rows));
        assert!(!roster.observe(
            9_000,
            &tiles(vec![
                entry("Robin Sample", false),
                entry("Robin Sample", false),
                entry("Alex Example", false),
            ])
        ));
        assert_eq!(roster.people().len(), 2);
        assert_eq!(roster.people()[1].last_ms, 9_000);

        // The user's own second device has no mark of its own: still one person, and the user.
        let mut roster = Roster::new();
        roster.observe(
            0,
            &panel(vec![
                entry("Alex Example", true),
                entry("Alex Example", false),
            ]),
        );
        assert_eq!(
            summary(&roster),
            [("p1".into(), "Alex Example".into(), true)]
        );
    }

    #[test]
    fn one_person_in_two_tiles_is_one_person() {
        let mut roster = Roster::new();
        roster.observe(
            0,
            &tiles(vec![
                entry("Alex Example", false),
                entry("Alex Example", false),
            ]),
        );
        assert_eq!(
            summary(&roster),
            [("p1".into(), "Alex Example".into(), false)]
        );
    }

    #[test]
    fn panel_and_tiles_in_one_tick_do_not_double_count() {
        let mut roster = Roster::new();
        let both = tick(
            App::GoogleMeet,
            vec![
                (
                    "panel",
                    true,
                    vec![entry("Alex Example", true), entry("Robin Sample", false)],
                ),
                (
                    "tiles",
                    false,
                    vec![entry("Robin Sample", false), entry("Alex Example", false)],
                ),
            ],
        );
        roster.observe(0, &both);
        assert_eq!(
            summary(&roster),
            [
                ("p1".into(), "Alex Example".into(), true),
                ("p2".into(), "Robin Sample".into(), false)
            ]
        );
    }

    #[test]
    fn at_most_fifty_people_then_truncated() {
        let mut roster = Roster::new();
        let many: Vec<Entry> = (0..60)
            .map(|n| entry(&format!("Person {n}"), false))
            .collect();
        assert!(roster.observe(0, &panel(many)));
        assert_eq!(roster.people().len(), MAX_PEOPLE);
        assert!(roster.truncated());
        assert_eq!(roster.people()[49].id, "p50");
        let json = roster.participants().unwrap().to_json();
        assert!(json.ends_with("\"truncated\":true}"), "{json}");
    }

    #[test]
    fn a_truncated_extraction_marks_the_roster() {
        let mut roster = Roster::new();
        let mut extraction = panel(vec![entry("Alex Example", true)]);
        extraction.truncated = true;
        assert!(roster.observe(0, &extraction));
        assert!(roster.truncated());
    }

    #[test]
    fn another_app_is_ignored() {
        let mut roster = Roster::new();
        roster.observe(0, &panel(vec![entry("Alex Example", true)]));
        let zoom = tick(
            App::Zoom,
            vec![("zoom", true, vec![entry("Robin Sample", false)])],
        );
        assert!(!roster.observe(5_000, &zoom));
        assert_eq!(roster.people().len(), 1);
        assert_eq!(roster.app(), Some(App::GoogleMeet));
    }

    #[test]
    fn empty_ticks_change_nothing() {
        let mut roster = Roster::new();
        assert!(!roster.observe(0, &panel(vec![])));
        assert_eq!(roster.participants(), None);
        assert_eq!(roster.app(), None);
    }

    #[test]
    fn participants_json_has_the_agreed_shape() {
        let mut roster = Roster::new();
        roster.observe(
            0,
            &panel(vec![
                entry("Robin Sample", true),
                entry("Alex Example", false),
            ]),
        );
        let json = roster.participants().unwrap().to_json();
        assert_eq!(
            json,
            r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Robin Sample","self":true},{"id":"p2","name":"Alex Example"}],"truncated":false}"#
        );
        assert_eq!(
            CallParticipants::from_json(&json).unwrap(),
            roster.participants().unwrap()
        );
    }

    #[test]
    fn participants_json_parse_refuses_bad_input() {
        assert!(CallParticipants::from_json(
            r#"{"v":2,"source":"call_window","app":"zoom","people":[],"truncated":false}"#
        )
        .is_err());
        assert!(CallParticipants::from_json(
            r#"{"v":1,"source":"elsewhere","app":"zoom","people":[],"truncated":false}"#
        )
        .is_err());
        assert!(CallParticipants::from_json(
            r#"{"v":1,"source":"call_window","app":"teams","people":[],"truncated":false}"#
        )
        .is_err());
        assert!(CallParticipants::from_json(r#"{"v":1,"source":"call_window","app":"zoom","people":[{"id":"p1","name":" "}],"truncated":false}"#).is_err());
        let many: Vec<String> = (1..=51)
            .map(|n| format!(r#"{{"id":"p{n}","name":"P{n}"}}"#))
            .collect();
        let json = format!(
            r#"{{"v":1,"source":"call_window","app":"zoom","people":[{}],"truncated":true}}"#,
            many.join(",")
        );
        assert!(CallParticipants::from_json(&json).is_err());
    }
}
