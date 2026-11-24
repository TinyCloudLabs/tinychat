//! The `has` condition of a path step: a node of some role, subrole or identifier a few levels
//! below the matched node. It is structure only, so a rules file cannot use it to read text.

use call_names::rules::{Axis, IdMatch, Rules, RulesError};

const VALID: &str = r#"{
  "format": 1,
  "version": 2,
  "apps": [
    {
      "app": "google-meet",
      "sources": [
        {
          "id": "list",
          "path": [
            { "find": "descendant", "role": "AXList" },
            { "find": "child", "role": "AXGroup", "has": { "role": "AXPopUpButton", "within": 4 } }
          ],
          "name": { "from": ["title"] }
        }
      ]
    }
  ]
}"#;

const HAS: &str = r#""has": { "role": "AXPopUpButton", "within": 4 }"#;

/// The valid file with its `has` condition replaced.
fn with_has(has: &str) -> String {
    assert!(VALID.contains(HAS));
    VALID.replacen(HAS, has, 1)
}

#[test]
fn a_step_can_ask_for_a_role_below_the_node() {
    let rules = Rules::from_json(VALID).unwrap();
    let path = &rules.apps[0].sources[0].path;
    assert!(path[0].has.is_none());
    assert_eq!(path[1].find, Axis::Child);
    let has = path[1].has.as_ref().unwrap();
    assert_eq!(has.matcher.role, ["AXPopUpButton"]);
    assert_eq!(has.within, 4);
    assert!(has.matcher.label.is_none());
}

#[test]
fn has_takes_roles_subroles_and_identifiers() {
    for has in [
        r#""has": { "role": ["AXPopUpButton", "AXMenuButton"], "within": 1 }"#,
        r#""has": { "subrole": "AXTabButton", "within": 8 }"#,
        r#""has": { "identifier": { "prefix": "row-" }, "within": 2 }"#,
    ] {
        let rules = Rules::from_json(&with_has(has)).unwrap();
        let found = rules.apps[0].sources[0].path[1].has.clone().unwrap();
        assert!(found.within >= 1, "{has}");
    }
    let rules = Rules::from_json(&with_has(
        r#""has": { "identifier": { "prefix": "row-" }, "within": 2 }"#,
    ))
    .unwrap();
    let has = rules.apps[0].sources[0].path[1].has.clone().unwrap();
    assert_eq!(has.matcher.identifier, Some(IdMatch::Prefix("row-".into())));
}

#[test]
fn has_cannot_name_a_label_or_any_other_text() {
    // A label would mean a text read on nodes the rule has not selected: the format has no such
    // field, so the file does not load.
    for has in [
        r#""has": { "role": "AXStaticText", "label": ["(You)"], "within": 2 }"#,
        r#""has": { "role": "AXStaticText", "value": ["(You)"], "within": 2 }"#,
        r#""has": { "role": "AXStaticText", "title": "x", "within": 2 }"#,
        r#""has": { "role": "AXPopUpButton", "within": 4, "index": 0 }"#,
    ] {
        assert!(
            matches!(Rules::from_json(&with_has(has)), Err(RulesError::Json(_))),
            "{has}"
        );
    }
}

#[test]
fn has_needs_a_structure_and_a_small_depth() {
    for has in [
        // Nothing to look for.
        r#""has": { "within": 2 }"#,
        r#""has": { "role": [], "within": 2 }"#,
        r#""has": { "role": " ", "within": 2 }"#,
        // No depth, or too deep to belong to the node.
        r#""has": { "role": "AXPopUpButton", "within": 0 }"#,
        r#""has": { "role": "AXPopUpButton", "within": 9 }"#,
        r#""has": { "role": "AXPopUpButton", "within": 3000 }"#,
    ] {
        assert!(
            matches!(
                Rules::from_json(&with_has(has)),
                Err(RulesError::Invalid(_))
            ),
            "{has}"
        );
    }
    for has in [
        r#""has": { "role": "AXPopUpButton" }"#,
        r#""has": { "role": "AXPopUpButton", "within": -1 }"#,
        r#""has": { "role": "AXPopUpButton", "within": "4" }"#,
        r#""has": "AXPopUpButton""#,
    ] {
        assert!(
            matches!(Rules::from_json(&with_has(has)), Err(RulesError::Json(_))),
            "{has}"
        );
    }
}

#[test]
fn the_embedded_people_panel_rule_asks_for_the_row_menu() {
    let rules = Rules::embedded().unwrap();
    let meet = rules
        .apps
        .iter()
        .find(|app| {
            app.sources
                .iter()
                .any(|source| source.id == "meet-people-panel")
        })
        .unwrap();
    let panel = meet
        .sources
        .iter()
        .find(|source| source.id == "meet-people-panel")
        .unwrap();
    let row = panel.path.last().unwrap();
    let has = row.has.as_ref().expect("the row step has a condition");
    assert_eq!(has.matcher.role, ["AXPopUpButton"]);
    assert_eq!(has.within, 4);
    // No other embedded rule needs one.
    let others = rules
        .apps
        .iter()
        .flat_map(|app| app.sources.iter())
        .filter(|source| source.id != "meet-people-panel")
        .flat_map(|source| source.path.iter());
    assert!(others.into_iter().all(|step| step.has.is_none()));
}
