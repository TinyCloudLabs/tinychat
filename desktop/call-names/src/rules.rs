//! Reading rules, as data.
//!
//! The rules are JSON (`rules/embedded.json`, compiled in with `include_str!`), so a later signed
//! rules file can fix label or role drift without a new build. A rule can only:
//! - match a node by role, subrole, identifier (exact or prefix), or exact title/description from a
//!   label list; every path step and skip must name a role, subrole or identifier, so text is never
//!   read on a node that the structure has not already selected;
//! - step to the node itself, a child, the first matching child, or any descendant, never to a
//!   child index;
//! - ask that a matched node has, a few levels below it, a node of a given role, subrole or
//!   identifier (`has`). This is structure only: it cannot name a label, so it never reads text.
//!   It tells a participant row (which holds a menu button) from a heading in the same list;
//! - read a name from the title, description or value of the node the path ends on.
//!
//! What a rules file cannot change lives in code: which apps and windows are read (`ax`), that
//! reading never acts on the window, and the caps on names (`names`). Anything malformed is an
//! error from [`Rules::from_json`]; nothing panics.

use crate::tree::TextAttr;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
use std::fmt;

/// The only rules format this build reads.
pub const FORMAT: u32 = 1;
/// Largest rules file accepted.
pub const MAX_RULES_BYTES: usize = 64 * 1024;
/// The rules compiled into this build.
pub const EMBEDDED_JSON: &str = include_str!("../rules/embedded.json");

const MAX_SOURCES: usize = 16;
const MAX_STEPS: usize = 8;
const MAX_MATCHERS: usize = 16;
const MAX_LIST: usize = 64;
const MAX_TEXT: usize = 200;
/// How far below a node a `has` condition may look.
const MAX_HAS_DEPTH: usize = 8;

/// The meeting apps this crate knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum App {
    GoogleMeet,
    Zoom,
}

/// All rules, as loaded and checked.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rules {
    pub format: u32,
    pub version: u64,
    pub apps: Vec<AppRules>,
}

/// The rules for one app.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppRules {
    pub app: App,
    #[serde(default)]
    pub note: Option<String>,
    /// Subtrees that are never entered, not even for structure.
    #[serde(default)]
    pub prune: Vec<Matcher>,
    /// A path that must reach at least one node, or the window is not in a call. Empty: always.
    #[serde(default)]
    pub in_call: Vec<Step>,
    pub sources: Vec<SourceRule>,
}

/// One place in the window where names appear.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRule {
    pub id: String,
    #[serde(default)]
    pub note: Option<String>,
    /// The source is a participant list: one match for each connection to the call. It says what
    /// kind of source this is and nothing more. The roster keeps one person for each name from
    /// every source, because one account on two devices is two rows with one name.
    #[serde(default)]
    pub one_per_person: bool,
    pub path: Vec<Step>,
    pub name: NameRule,
    /// Marks the match as the local user.
    #[serde(default, rename = "self")]
    pub self_marker: Option<SelfMarker>,
}

/// One step of a path: where to look from each node reached so far, and what must match there.
#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "StepJson")]
pub struct Step {
    pub find: Axis,
    pub matcher: Matcher,
    /// What must lie below the node as well. Checked on structure alone, before any label is read.
    pub has: Option<Has>,
    /// With `descendant`: subtrees whose root matches one of these are neither matched nor entered.
    pub skip: Vec<Matcher>,
}

/// A condition on what lies below a node: some node at most `within` levels down has this role,
/// subrole or identifier. It has no label, so checking it reads no text.
#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "HasJson")]
pub struct Has {
    /// Role, subrole and identifier only: `label` is always `None`.
    pub matcher: Matcher,
    /// How far down to look: 1 is the node's children.
    pub within: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HasJson {
    #[serde(default, deserialize_with = "one_or_many")]
    role: Vec<String>,
    #[serde(default, deserialize_with = "one_or_many")]
    subrole: Vec<String>,
    #[serde(default)]
    identifier: Option<IdMatch>,
    within: usize,
}

impl TryFrom<HasJson> for Has {
    type Error = String;

    fn try_from(json: HasJson) -> Result<Self, String> {
        Ok(Has {
            matcher: Matcher {
                role: json.role,
                subrole: json.subrole,
                identifier: json.identifier,
                label: None,
            },
            within: json.within,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StepJson {
    find: Axis,
    #[serde(default, deserialize_with = "one_or_many")]
    role: Vec<String>,
    #[serde(default, deserialize_with = "one_or_many")]
    subrole: Vec<String>,
    #[serde(default)]
    identifier: Option<IdMatch>,
    #[serde(default)]
    label: Option<Vec<String>>,
    #[serde(default)]
    has: Option<Has>,
    #[serde(default)]
    skip: Vec<Matcher>,
}

impl TryFrom<StepJson> for Step {
    type Error = String;

    fn try_from(json: StepJson) -> Result<Self, String> {
        Ok(Step {
            find: json.find,
            matcher: Matcher {
                role: json.role,
                subrole: json.subrole,
                identifier: json.identifier,
                label: json.label,
            },
            has: json.has,
            skip: json.skip,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    /// The node itself.
    #[serde(rename = "self")]
    Itself,
    Child,
    /// The first child that matches, if any.
    FirstChild,
    Descendant,
}

/// What a node must be. Every set field must hold; lists mean "any of".
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Matcher {
    #[serde(default, deserialize_with = "one_or_many")]
    pub role: Vec<String>,
    #[serde(default, deserialize_with = "one_or_many")]
    pub subrole: Vec<String>,
    #[serde(default)]
    pub identifier: Option<IdMatch>,
    /// The title or the description equals one of these exactly.
    #[serde(default)]
    pub label: Option<Vec<String>>,
}

impl Matcher {
    fn is_structural(&self) -> bool {
        !self.role.is_empty() || !self.subrole.is_empty() || self.identifier.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum IdMatch {
    Exact(String),
    Prefix(String),
}

impl IdMatch {
    pub fn matches(&self, identifier: Option<&str>) -> bool {
        match (self, identifier) {
            (IdMatch::Exact(want), Some(id)) => id == want,
            (IdMatch::Prefix(want), Some(id)) => id.starts_with(want.as_str()),
            (_, None) => false,
        }
    }
}

/// How the name is read from the node a path ends on.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NameRule {
    /// Attributes tried in order; the first non-empty one is the name.
    pub from: Vec<TextAttr>,
    /// Texts that are never names, such as an interface word in the same place.
    #[serde(default)]
    pub ignore: Vec<String>,
    /// A trailing `(Tag, Tag)` group is removed when all its tags are known.
    #[serde(default)]
    pub suffix_tags: Option<SuffixTags>,
    /// The name must begin this attribute of the node matched by the previous step: equal to
    /// it, or followed by ", ".
    #[serde(default)]
    pub prefix_of_previous: Option<TextAttr>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuffixTags {
    pub tags: Vec<String>,
    /// Tags that mark the local user, such as "me".
    #[serde(default)]
    pub self_tags: Vec<String>,
}

/// A text near the match that marks it as the local user, such as "(You)".
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelfMarker {
    pub find: Axis,
    #[serde(deserialize_with = "one_or_many")]
    pub role: Vec<String>,
    /// The marker's value equals one of these exactly.
    pub value: Vec<String>,
}

fn one_or_many<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match OneOrMany::deserialize(deserializer)? {
        OneOrMany::One(one) => vec![one],
        OneOrMany::Many(many) => many,
    })
}

/// Why rules did not load.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RulesError {
    TooLarge(usize),
    Json(String),
    Invalid(String),
}

impl fmt::Display for RulesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RulesError::TooLarge(bytes) => write!(
                f,
                "rules file is {bytes} bytes; the limit is {MAX_RULES_BYTES}"
            ),
            RulesError::Json(error) => write!(f, "rules file is not valid: {error}"),
            RulesError::Invalid(error) => write!(f, "rules file is invalid: {error}"),
        }
    }
}

impl std::error::Error for RulesError {}

impl Rules {
    /// The rules compiled into this build.
    pub fn embedded() -> Result<Rules, RulesError> {
        Rules::from_json(EMBEDDED_JSON)
    }

    /// Parse and check a rules file.
    pub fn from_json(json: &str) -> Result<Rules, RulesError> {
        if json.len() > MAX_RULES_BYTES {
            return Err(RulesError::TooLarge(json.len()));
        }
        let rules: Rules =
            serde_json::from_str(json).map_err(|error| RulesError::Json(error.to_string()))?;
        rules.check().map_err(RulesError::Invalid)?;
        Ok(rules)
    }

    pub fn app(&self, app: App) -> Option<&AppRules> {
        self.apps.iter().find(|rules| rules.app == app)
    }

    fn check(&self) -> Result<(), String> {
        if self.format != FORMAT {
            return Err(format!("format {} is not {FORMAT}", self.format));
        }
        if self.version == 0 {
            return Err("version must be at least 1".into());
        }
        if self.apps.is_empty() {
            return Err("no apps".into());
        }
        let mut apps = HashSet::new();
        let mut ids = HashSet::new();
        for app in &self.apps {
            if !apps.insert(app.app) {
                return Err(format!("{:?} appears twice", app.app));
            }
            let at = format!("{:?}", app.app);
            check_note(&app.note, &at)?;
            check_count(app.prune.len(), MAX_MATCHERS, &format!("{at} prune"))?;
            for matcher in &app.prune {
                check_matcher(matcher, &format!("{at} prune"))?;
            }
            check_count(app.in_call.len(), MAX_STEPS, &format!("{at} in_call"))?;
            for step in &app.in_call {
                check_step(step, &format!("{at} in_call"))?;
            }
            if app.sources.is_empty() || app.sources.len() > MAX_SOURCES {
                return Err(format!("{at} needs 1 to {MAX_SOURCES} sources"));
            }
            for source in &app.sources {
                check_source(source)?;
                if !ids.insert(source.id.as_str()) {
                    return Err(format!("source id {:?} appears twice", source.id));
                }
            }
        }
        Ok(())
    }
}

fn check_source(source: &SourceRule) -> Result<(), String> {
    check_text(&source.id, "source id")?;
    let at = format!("source {:?}", source.id);
    check_note(&source.note, &at)?;
    if source.path.is_empty() || source.path.len() > MAX_STEPS {
        return Err(format!("{at}: path needs 1 to {MAX_STEPS} steps"));
    }
    for step in &source.path {
        check_step(step, &at)?;
    }
    let name = &source.name;
    if name.from.is_empty() || name.from.len() > 3 {
        return Err(format!("{at}: name.from needs 1 to 3 attributes"));
    }
    if name.from.iter().collect::<HashSet<_>>().len() != name.from.len() {
        return Err(format!("{at}: name.from repeats an attribute"));
    }
    check_list(&name.ignore, &format!("{at} name.ignore"), true)?;
    if let Some(tags) = &name.suffix_tags {
        check_list(&tags.tags, &format!("{at} suffix_tags.tags"), false)?;
        check_list(
            &tags.self_tags,
            &format!("{at} suffix_tags.self_tags"),
            true,
        )?;
        if tags.self_tags.iter().any(|tag| !tags.tags.contains(tag)) {
            return Err(format!("{at}: every self tag must also be a tag"));
        }
    }
    if name.prefix_of_previous.is_some() && source.path.len() < 2 {
        return Err(format!("{at}: prefix_of_previous needs a previous step"));
    }
    if let Some(marker) = &source.self_marker {
        if !matches!(marker.find, Axis::Child | Axis::Descendant) {
            return Err(format!("{at}: self.find must be child or descendant"));
        }
        check_list(&marker.role, &format!("{at} self.role"), false)?;
        check_list(&marker.value, &format!("{at} self.value"), false)?;
    }
    Ok(())
}

fn check_step(step: &Step, at: &str) -> Result<(), String> {
    check_matcher(&step.matcher, at)?;
    if let Some(has) = &step.has {
        check_matcher(&has.matcher, &format!("{at} has"))?;
        if has.within == 0 || has.within > MAX_HAS_DEPTH {
            return Err(format!("{at} has: within must be 1 to {MAX_HAS_DEPTH}"));
        }
    }
    if !step.skip.is_empty() && step.find != Axis::Descendant {
        return Err(format!("{at}: skip only applies to descendant steps"));
    }
    check_count(step.skip.len(), MAX_MATCHERS, &format!("{at} skip"))?;
    for matcher in &step.skip {
        check_matcher(matcher, &format!("{at} skip"))?;
    }
    Ok(())
}

fn check_matcher(matcher: &Matcher, at: &str) -> Result<(), String> {
    if !matcher.is_structural() {
        return Err(format!(
            "{at}: every matcher needs a role, subrole or identifier"
        ));
    }
    check_list(&matcher.role, &format!("{at} role"), true)?;
    check_list(&matcher.subrole, &format!("{at} subrole"), true)?;
    match &matcher.identifier {
        Some(IdMatch::Exact(id) | IdMatch::Prefix(id)) => {
            check_text(id, &format!("{at} identifier"))?
        }
        None => {}
    }
    if let Some(labels) = &matcher.label {
        check_list(labels, &format!("{at} label"), false)?;
    }
    Ok(())
}

fn check_list(list: &[String], at: &str, may_be_empty: bool) -> Result<(), String> {
    if list.is_empty() && !may_be_empty {
        return Err(format!("{at}: list is empty"));
    }
    check_count(list.len(), MAX_LIST, at)?;
    list.iter().try_for_each(|item| check_text(item, at))
}

fn check_count(count: usize, max: usize, at: &str) -> Result<(), String> {
    if count > max {
        return Err(format!("{at}: more than {max} entries"));
    }
    Ok(())
}

fn check_text(text: &str, at: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > MAX_TEXT {
        return Err(format!("{at}: text must be 1 to {MAX_TEXT} characters"));
    }
    Ok(())
}

fn check_note(note: &Option<String>, at: &str) -> Result<(), String> {
    match note {
        Some(note) if note.chars().count() > 1000 => Err(format!("{at}: note is too long")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_rules_load() {
        let rules = Rules::embedded().unwrap();
        assert!(rules.app(App::GoogleMeet).is_some());
        assert!(rules.app(App::Zoom).is_some());
        assert!(EMBEDDED_JSON.len() < MAX_RULES_BYTES);
    }

    #[test]
    fn app_ids_are_the_output_strings() {
        assert_eq!(
            serde_json::to_string(&App::GoogleMeet).unwrap(),
            "\"google-meet\""
        );
        assert_eq!(serde_json::to_string(&App::Zoom).unwrap(), "\"zoom\"");
    }

    #[test]
    fn id_match_exact_and_prefix() {
        assert!(IdMatch::Exact("a".into()).matches(Some("a")));
        assert!(!IdMatch::Exact("a".into()).matches(Some("ab")));
        assert!(IdMatch::Prefix("a".into()).matches(Some("ab")));
        assert!(!IdMatch::Prefix("a".into()).matches(None));
    }
}
