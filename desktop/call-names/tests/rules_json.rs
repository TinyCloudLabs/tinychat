//! Malformed rules fail to load with an error, never a panic.

use call_names::rules::{Rules, RulesError, MAX_RULES_BYTES};

const VALID: &str = r#"{
  "format": 1,
  "version": 3,
  "apps": [
    {
      "app": "zoom",
      "in_call": [{ "find": "self", "role": "AXWindow", "identifier": { "exact": "zm.meeting.window.main" } }],
      "sources": [
        {
          "id": "zoom-tiles",
          "path": [{ "find": "descendant", "role": "AXTabGroup" }, { "find": "child", "role": "AXButton" }],
          "name": { "from": ["description"], "prefix_of_previous": "description" }
        }
      ]
    }
  ]
}"#;

/// The valid file with one piece of text replaced.
fn with(from: &str, to: &str) -> String {
    assert!(VALID.contains(from), "{from}");
    VALID.replacen(from, to, 1)
}

#[test]
fn the_valid_example_loads() {
    let rules = Rules::from_json(VALID).unwrap();
    assert_eq!(rules.version, 3);
}

#[test]
fn broken_json_is_a_json_error() {
    for json in [
        "",
        "{",
        "[]",
        "null",
        "{\"format\": 1}",
        &VALID[..VALID.len() - 3],
        &with("\"zoom-tiles\"", "7"),
    ] {
        assert!(
            matches!(Rules::from_json(json), Err(RulesError::Json(_))),
            "{json}"
        );
    }
}

#[test]
fn unknown_fields_and_values_are_refused() {
    for json in [
        with("\"version\": 3,", "\"version\": 3, \"extra\": true,"),
        with("\"app\": \"zoom\"", "\"app\": \"teams\""),
        with("\"find\": \"child\"", "\"find\": \"parent\""),
        with(
            "\"find\": \"child\", \"role\": \"AXButton\"",
            "\"find\": \"child\", \"role\": \"AXButton\", \"index\": 0",
        ),
        with("\"from\": [\"description\"]", "\"from\": [\"help\"]"),
        with(
            "{ \"exact\": \"zm.meeting.window.main\" }",
            "{ \"regex\": \".*\" }",
        ),
        with("\"role\": \"AXTabGroup\"", "\"role\": 4"),
    ] {
        assert!(
            matches!(Rules::from_json(&json), Err(RulesError::Json(_))),
            "{json}"
        );
    }
}

#[test]
fn checks_reject_what_parses() {
    let cases = [
        with("\"format\": 1", "\"format\": 2"),
        with("\"version\": 3", "\"version\": 0"),
        // A step that is only a label would read the text of every node.
        with("{ \"find\": \"child\", \"role\": \"AXButton\" }", "{ \"find\": \"child\", \"label\": [\"Alex\"] }"),
        with("{ \"find\": \"child\", \"role\": \"AXButton\" }", "{ \"find\": \"child\" }"),
        with("\"role\": \"AXTabGroup\" }", "\"role\": \"AXTabGroup\", \"label\": [] }"),
        with("\"role\": \"AXTabGroup\" }", "\"role\": \"AXTabGroup\", \"label\": [\"  \"] }"),
        with("{ \"find\": \"child\", \"role\": \"AXButton\" }", "{ \"find\": \"child\", \"role\": \"AXButton\", \"skip\": [{ \"role\": \"AXHeading\" }] }"),
        with("{ \"find\": \"descendant\", \"role\": \"AXTabGroup\" }", "{ \"find\": \"descendant\", \"role\": \"AXTabGroup\", \"skip\": [{ \"label\": [\"x\"] }] }"),
        with("\"from\": [\"description\"]", "\"from\": []"),
        with("\"from\": [\"description\"]", "\"from\": [\"description\", \"description\"]"),
        with("\"id\": \"zoom-tiles\"", "\"id\": \"\""),
        with("{ \"find\": \"descendant\", \"role\": \"AXTabGroup\" }, ", ""),
        with("\"path\": [{ \"find\": \"descendant\", \"role\": \"AXTabGroup\" }, { \"find\": \"child\", \"role\": \"AXButton\" }]", "\"path\": []"),
        with("\"prefix_of_previous\": \"description\"", "\"prefix_of_previous\": \"description\" }, \"self\": { \"find\": \"self\", \"role\": \"AXStaticText\", \"value\": [\"(You)\"]"),
        with("\"prefix_of_previous\": \"description\"", "\"suffix_tags\": { \"tags\": [\"Host\"], \"self_tags\": [\"me\"] }"),
        with("\"sources\": [", "\"sources\": [] , \"unused\": ["),
        with("\"apps\": [", "\"apps\": [] , \"unused\": ["),
    ];
    for json in cases {
        match Rules::from_json(&json) {
            Err(RulesError::Invalid(_)) => {}
            // serde reports some of these (unknown keys after a rewrite) as JSON errors; both refuse.
            Err(RulesError::Json(_)) => {}
            other => panic!("accepted invalid rules: {other:?}\n{json}"),
        }
    }
}

#[test]
fn duplicates_are_refused() {
    let app = VALID
        .split("\"apps\": [")
        .nth(1)
        .unwrap()
        .trim_end()
        .trim_end_matches('}')
        .trim_end()
        .trim_end_matches(']');
    let twice = format!("{{ \"format\": 1, \"version\": 1, \"apps\": [{app}, {app}] }}");
    assert!(
        matches!(Rules::from_json(&twice), Err(RulesError::Invalid(_))),
        "{twice}"
    );
}

#[test]
fn an_oversized_file_is_refused_before_parsing() {
    let padded = format!("{VALID}{}", " ".repeat(MAX_RULES_BYTES));
    assert!(matches!(
        Rules::from_json(&padded),
        Err(RulesError::TooLarge(_))
    ));
}

#[test]
fn errors_print_without_panicking() {
    for error in [
        RulesError::TooLarge(1),
        RulesError::Json("x".into()),
        RulesError::Invalid("y".into()),
    ] {
        assert!(!error.to_string().is_empty());
    }
}
