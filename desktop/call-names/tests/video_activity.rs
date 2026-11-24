//! Video activity is a persistent last-speaker signal, separate from speech.
mod common;
use call_names::names::Name;
use call_names::rules::{App, Rules};
use call_names::session::{read_tick_with_speaking, Budget, Meter, Target};
use call_names::speaking::{
    Classified, Classifier, Confirmed, Found, Mark, Markers, Mode, Reading, SampleRead, TileFound,
    Tokens, SAMPLE_BUDGET,
};
use call_names::timeline::{Timeline, TimelineBuilder, Tracker};
use call_names::tree::ClassSet;
use common::replay::{token_rules_json, Replay};

fn rules() -> Rules {
    Rules::from_json(
        &token_rules_json()
            .replace("dkjMxf", "cfeb93ccb")
            .replace("kssMZb", "c278823c6"),
    )
    .unwrap()
}
fn tokens(r: &Rules) -> Tokens {
    Tokens::for_rule(&r.app(App::GoogleMeet).unwrap().speaking[0]).unwrap()
}
fn reading(s: &[&str]) -> Reading {
    Reading::Classes(ClassSet::from_tokens(s.iter().copied()).unwrap())
}
fn tile(previous: Option<usize>, rules_ok: bool) -> TileFound {
    TileFound {
        name: Name::clean("Test Guest A").unwrap(),
        previous,
        rules_ok,
        single: true,
    }
}

#[test]
fn real_video_capture_keeps_persistent_activity_out_of_speech_and_prefers_the_observers_meter() {
    let r = rules();
    let mut replay = Replay::load("meet-video-r79");
    let mut markers = Markers::new();
    let clock = common::frozen();
    let mut classifier = Classifier::new(Some(tokens(&r)));
    let mut next_tick = 0.0;
    let mut by_name = Vec::new();
    let mut active = [0; 2];
    let mut late_b = 0;
    let mut frames = 0;
    loop {
        if replay.t >= next_tick {
            next_tick += 5.0;
            let mut meter = Meter::new(Budget::DEFAULT, &clock);
            let root = replay.root();
            let (names, found) = read_tick_with_speaking(
                &r,
                &mut replay,
                &[Target {
                    app: App::GoogleMeet,
                    root,
                }],
                &mut meter,
            );
            assert!(names.is_ok());
            let found = found.unwrap();
            assert_eq!(found.len(), 3);
            for m in &found {
                if m.name.as_str() == "Alex Example" {
                    assert!(m.marker.ends_with(".0.0.0.1.0"));
                } else {
                    assert_eq!(
                        m.tile, m.marker,
                        "video activity comes from its stable tile root"
                    );
                }
            }
            let tiles = markers.update(&replay, found);
            by_name = tiles.iter().map(|t| t.name.as_str().to_owned()).collect();
            classifier.decide(&tiles);
        } else {
            let sample = markers.sample(&mut replay, &[0, 1, 2], SAMPLE_BUDGET, &clock);
            frames += 1;
            for (slot, read) in sample.readings {
                let mark = classifier.preview(&read);
                assert_ne!(mark, Mark::Speaking);
                match by_name[slot].as_str() {
                    "Test Guest A" if mark == Mark::Active => active[0] += 1,
                    "Test Guest B" if mark == Mark::Active => {
                        active[1] += 1;
                        if replay.t > 40.0 {
                            late_b += 1;
                        }
                    }
                    "Alex Example" => assert_eq!(mark, Mark::Quiet),
                    _ => {}
                }
            }
        }
        if !replay.advance() {
            break;
        }
    }
    assert!(frames > 200);
    assert!(active.iter().all(|n| *n > 60));
    assert!(late_b > 50, "B remains active long after speech stops");
}

#[test]
fn activity_stays_activity_even_after_the_meter_classifier_learns() {
    let r = Rules::embedded().unwrap();
    let mut c = Classifier::new(Some(tokens(&r)));
    let tiles = vec![tile(None, false); 3];
    for _ in 0..3 {
        c.decide(&tiles);
    }
    assert_eq!(c.mode(), Some(Mode::Learned));
    let mut out = Vec::new();
    for i in 0..160 {
        out.extend(c.push(Confirmed {
            at_ms: i * 250,
            period_ms: 250,
            readings: vec![
                ("p1".into(), reading(&["dkjMxf", "kssMZb"])),
                ("p2".into(), reading(&["dkjMxf"])),
                ("p3".into(), reading(&["renamed", "quiet"])),
            ],
        }));
    }
    out.extend(c.finish());
    assert_eq!(out.len(), 160);
    let speech = c.push(Confirmed {
        at_ms: 41000,
        period_ms: 250,
        readings: vec![
            ("p1".into(), reading(&["dkjMxf", "kssMZb"])),
            ("p2".into(), reading(&["dkjMxf"])),
            ("p3".into(), reading(&["renamed"])),
        ],
    });
    assert_eq!(
        speech[0].marks[2].1,
        Mark::Speaking,
        "border reads do not vote in the learned layout-change detector"
    );
    for s in out {
        assert_eq!(s.marks[0].1, Mark::Active);
        assert_eq!(s.marks[1].1, Mark::Inactive);
        assert_eq!(s.marks[2].1, Mark::Quiet);
    }
}

#[test]
fn camera_changes_keep_two_channels_and_old_json_remains_readable() {
    let mut b = TimelineBuilder::new(App::GoogleMeet, 4, 200);
    b.set_mode(Some(Mode::Rules));
    for (at, mark) in [
        (0, Mark::Speaking),
        (200, Mark::Speaking),
        (400, Mark::Active),
        (600, Mark::Active),
        (800, Mark::Speaking),
        (1000, Mark::Speaking),
    ] {
        b.observe(&Classified {
            at_ms: at,
            period_ms: 200,
            marks: vec![("p1".into(), mark)],
        });
    }
    b.pause();
    let t = b.timeline(None).unwrap();
    assert_eq!(t.people["p1"].active, vec![[400, 800]]);
    assert_eq!(t.people["p1"].speaking, vec![[0, 400], [800, 1200]]);
    let j = t.to_json();
    assert_eq!(Timeline::from_json(&j).unwrap(), t);
    let mut old: serde_json::Value = serde_json::from_str(&j).unwrap();
    old["people"]["p1"]
        .as_object_mut()
        .unwrap()
        .remove("active");
    assert!(Timeline::from_json(&old.to_string()).unwrap().people["p1"]
        .active
        .is_empty());
    let self_t = b.timeline(Some("p1")).unwrap();
    assert!(self_t.people.is_empty());
    assert_eq!(self_t.self_active, vec![[400, 800]]);
}

#[test]
fn one_person_in_mixed_tiles_keeps_both_channels() {
    let mut b = TimelineBuilder::new(App::GoogleMeet, 4, 200);
    b.set_mode(Some(Mode::Rules));
    b.observe(&Classified {
        at_ms: 0,
        period_ms: 200,
        marks: vec![("p1".into(), Mark::Active), ("p1".into(), Mark::Speaking)],
    });
    b.observe(&Classified {
        at_ms: 200,
        period_ms: 200,
        marks: vec![("p1".into(), Mark::Active), ("p1".into(), Mark::Speaking)],
    });
    let t = b.timeline(None).unwrap();
    assert_eq!(t.people["p1"].active, vec![[0, 400]]);
    assert_eq!(t.people["p1"].speaking, vec![[0, 400]]);
}

#[test]
fn spotlight_needs_three_current_people_and_counts_border_reads_separately() {
    let r = Rules::embedded().unwrap();
    let mut tr = Tracker::new(App::GoogleMeet, 4, 200, Some(tokens(&r)));
    let mut found = Found {
        tiles: vec![tile(None, true)],
        hidden: false,
        people: 2,
    };
    tr.tick(0, Some(&found), |_| Some("p1".into()));
    assert!(tr.followed().is_empty());
    found.people = 3;
    tr.tick(100, Some(&found), |_| Some("p1".into()));
    assert_eq!(tr.followed(), vec![0]);
    tr.sample(
        200,
        200,
        SampleRead {
            readings: vec![(0, reading(&["dkjMxf", "kssMZb"]))],
            ..Default::default()
        },
    );
    found.tiles[0].previous = Some(0);
    tr.tick(500, Some(&found), |_| Some("p1".into()));
    let counts = tr.counts();
    assert_eq!(counts.border, 1);
    assert_eq!(counts.unknown, 0);
    tr.sample(
        600,
        200,
        SampleRead {
            readings: vec![(0, reading(&["unrecognized"]))],
            ..Default::default()
        },
    );
    assert_eq!(
        tr.counts().unknown,
        0,
        "readable but unrecognized is not a read failure"
    );
    tr.sample(
        800,
        200,
        SampleRead {
            readings: vec![(0, Reading::Gone)],
            ..Default::default()
        },
    );
    assert_eq!(tr.counts().unknown, 1);
    found.people = 2;
    tr.tick(1000, Some(&found), |_| Some("p1".into()));
    assert!(
        tr.followed().is_empty(),
        "historical membership cannot keep sampling a two-person call"
    );
}

#[test]
fn activity_rule_rejects_text_selectors_and_empty_or_overlapping_tokens() {
    let mut j: serde_json::Value = serde_json::from_str(call_names::rules::EMBEDDED_JSON).unwrap();
    let original = j.clone();
    j["apps"][0]["speaking"][0]["active"]["marker"][0]["label"] = serde_json::json!(["secret"]);
    assert!(Rules::from_json(&j.to_string()).is_err());
    j = original.clone();
    j["apps"][0]["speaking"][0]["active"]["classes"]["all"] = serde_json::json!([]);
    assert!(Rules::from_json(&j.to_string()).is_err());
    j = original;
    j["apps"][0]["speaking"][0]["active"]["classes"]["on"] = serde_json::json!(["dkjMxf"]);
    assert!(Rules::from_json(&j.to_string()).is_err());
}

#[test]
fn a_short_layout_is_found_with_three_current_names_but_not_with_two() {
    use call_names::extract::Scan;
    use call_names::speaking::{find_markers_with_people, FindCost};
    use common::replay::Capture;
    let r = rules();
    let app = r.app(App::GoogleMeet).unwrap();
    let mut capture = Capture::load("meet-video-r79");
    let removed = "a0w0p0.0.1.0.0.0.1.1.1";
    capture
        .full
        .retain(|n| n.p != removed && !n.p.starts_with(&format!("{removed}.")));
    let mut source = Replay::new(std::rc::Rc::new(capture));
    let clock = common::frozen();
    for people in [2, 3] {
        let mut meter = Meter::new(Budget::DEFAULT, &clock);
        let root = source.root();
        let mut scan = Scan::read(&mut source, root, app, &mut meter).unwrap();
        let found = find_markers_with_people(
            &mut scan,
            &mut source,
            app,
            &mut meter,
            &mut FindCost::default(),
            people,
        )
        .unwrap();
        assert_eq!(found.len(), if people == 3 { 2 } else { 0 });
    }
}

#[test]
fn redraw_drops_unconfirmed_old_activity_and_reacquires_the_new_marker() {
    let r = Rules::embedded().unwrap();
    let mut tr = Tracker::new(App::GoogleMeet, 4, 200, Some(tokens(&r)));
    let mut found = Found {
        tiles: vec![tile(None, true)],
        hidden: false,
        people: 3,
    };
    tr.tick(0, Some(&found), |_| Some("p1".into()));
    for at in [200, 400] {
        tr.sample(
            at,
            200,
            SampleRead {
                readings: vec![(0, reading(&["dkjMxf", "kssMZb"]))],
                ..Default::default()
            },
        );
    }
    // None means either the tile or its selected marker was replaced.
    tr.tick(600, Some(&found), |_| Some("p1".into()));
    assert!(
        tr.timeline(None).is_none(),
        "samples of the disappeared marker were not confirmed"
    );
    for at in [800, 1000] {
        tr.sample(
            at,
            200,
            SampleRead {
                readings: vec![(0, reading(&["DYfzY", "cYKTje", "Oaajhc"]))],
                ..Default::default()
            },
        );
    }
    found.tiles[0].previous = Some(0);
    tr.tick(1400, Some(&found), |_| Some("p1".into()));
    tr.finish();
    let t = tr.timeline(None).unwrap();
    assert!(t.people["p1"].active.is_empty());
    assert_eq!(t.people["p1"].speaking, vec![[800, 1200]]);
}

#[test]
fn active_spans_have_the_same_validation_as_speech() {
    let mut b = TimelineBuilder::new(App::GoogleMeet, 4, 200);
    b.set_mode(Some(Mode::Rules));
    for at in [0, 200] {
        b.observe(&Classified {
            at_ms: at,
            period_ms: 200,
            marks: vec![("p1".into(), Mark::Active)],
        });
    }
    let mut j: serde_json::Value =
        serde_json::from_str(&b.timeline(None).unwrap().to_json()).unwrap();
    j["people"]["p1"]["active"] = serde_json::json!([[1000, 500]]);
    assert!(Timeline::from_json(&j.to_string()).is_err());
    j["people"]["p1"]["active"] = serde_json::json!([[0, 1000], [500, 1500]]);
    assert!(Timeline::from_json(&j.to_string()).is_err());
}

#[test]
fn meter_without_a_state_token_is_kept_instead_of_falling_back_to_activity() {
    use common::replay::{Capture, MEET_CLASS_TOKENS};
    let r = rules();
    let mut capture = Capture::load("meet-video-r79");
    let quiet = MEET_CLASS_TOKENS
        .iter()
        .find(|(name, _)| *name == "gjg47c")
        .unwrap()
        .1;
    for n in &mut capture.full {
        n.cls.retain(|token| token != quiet);
    }
    let mut source = Replay::new(std::rc::Rc::new(capture));
    let clock = common::frozen();
    let mut meter = Meter::new(Budget::DEFAULT, &clock);
    let root = source.root();
    let (_, found) = read_tick_with_speaking(
        &r,
        &mut source,
        &[Target {
            app: App::GoogleMeet,
            root,
        }],
        &mut meter,
    );
    let found = found.unwrap();
    assert_eq!(found.len(), 3);
    let observer = found
        .iter()
        .find(|m| m.name.as_str() == "Alex Example")
        .unwrap();
    assert!(observer.marker.ends_with(".0.0.0.1.0"));
    assert!(
        !observer.rules_ok,
        "meter identity does not imply a recognized state"
    );
}

#[test]
fn live_camera_toggle_snapshots_reselect_meter_then_root_then_meter() {
    let r = rules();
    let clock = common::frozen();
    let mut markers = Markers::new();
    for (index, fixture) in [
        "meet-toggle-r79-1",
        "meet-toggle-r79-2",
        "meet-toggle-r79-3",
    ]
    .iter()
    .enumerate()
    {
        let mut source = Replay::load(fixture);
        let root = source.root();
        let mut meter = Meter::new(Budget::DEFAULT, &clock);
        let (_, found) = read_tick_with_speaking(
            &r,
            &mut source,
            &[Target {
                app: App::GoogleMeet,
                root,
            }],
            &mut meter,
        );
        let found = found.unwrap();
        assert_eq!(found.len(), 3);
        let host = found
            .iter()
            .find(|m| m.name.as_str() == "Test Guest A")
            .unwrap();
        if index == 1 {
            assert_eq!(host.tile, host.marker);
        } else {
            assert!(host.marker.ends_with(".0.0.0.1.0"));
        }
        let updated = markers.update(&source, found);
        assert_eq!(
            updated
                .iter()
                .find(|t| t.name.as_str() == "Test Guest A")
                .unwrap()
                .previous,
            None,
            "changing the marker invalidates prior samples even if the tile path stays the same"
        );
    }
}

#[test]
fn renamed_camera_off_state_tokens_still_allow_the_existing_learning_fallback() {
    use common::replay::{Capture, MEET_CLASS_TOKENS};
    let r = rules();
    let mut capture = Capture::load("meet-speaking-s56");
    let quiet = MEET_CLASS_TOKENS
        .iter()
        .find(|(name, _)| *name == "gjg47c")
        .unwrap()
        .1;
    for n in &mut capture.full {
        for token in &mut n.cls {
            if token == quiet {
                *token = "renamed-quiet".into();
            }
        }
    }
    let mut source = Replay::new(std::rc::Rc::new(capture));
    let clock = common::frozen();
    let mut markers = Markers::new();
    let mut classifier = Classifier::new(Some(tokens(&r)));
    for _ in 0..3 {
        let mut meter = Meter::new(Budget::DEFAULT, &clock);
        let root = source.root();
        let (_, found) = read_tick_with_speaking(
            &r,
            &mut source,
            &[Target {
                app: App::GoogleMeet,
                root,
            }],
            &mut meter,
        );
        let found = found.unwrap();
        assert_eq!(found.len(), 3);
        for m in &found {
            assert!(m.marker.ends_with(".0.0.0.1.0"));
            assert!(!m.rules_ok);
        }
        classifier.decide(&markers.update(&source, found));
    }
    assert_eq!(classifier.mode(), Some(Mode::Learned));
    let mut out = Vec::new();
    for i in 0..160 {
        let read = markers.sample(&mut source, &[0, 1, 2], SAMPLE_BUDGET, &clock);
        out.extend(
            classifier.push(Confirmed {
                at_ms: i * 250,
                period_ms: 250,
                readings: read
                    .readings
                    .into_iter()
                    .map(|(slot, read)| (format!("p{}", slot + 1), read))
                    .collect(),
            }),
        );
    }
    out.extend(classifier.finish());
    assert_eq!(out.len(), 160);
    assert!(out
        .iter()
        .all(|sample| sample.marks.iter().all(|(_, mark)| *mark == Mark::Quiet)));
}
