//! Names and the caps on them.
//!
//! A [`Name`] is always one line, trimmed, and at most [`MAX_NAME_CHARS`] characters. Its `Debug`
//! prints only the length, so a name cannot reach a log through `{:?}`; it has no `Display`.
//! These caps are code, not rules: a rules file cannot change them.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Longest name kept, in characters (Unicode scalar values).
pub const MAX_NAME_CHARS: usize = 80;
/// Most people kept for one recording, and most names taken from one source in one tick.
pub const MAX_PEOPLE: usize = 50;

/// A display name as shown in the call window, cleaned.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Name(String);

impl Name {
    /// Clean a raw text: line breaks, tabs and other control characters become spaces, runs of
    /// spaces collapse, bidirectional controls are removed, the ends are trimmed, and the result is
    /// cut to [`MAX_NAME_CHARS`]. `None` when nothing is left.
    pub fn clean(raw: &str) -> Option<Name> {
        let mut out = String::new();
        let mut count = 0;
        let mut space = false;
        for ch in raw.chars() {
            if is_invisible(ch) {
                continue;
            }
            if ch.is_whitespace() || ch.is_control() {
                space = !out.is_empty();
                continue;
            }
            let need = if space { 2 } else { 1 };
            if count + need > MAX_NAME_CHARS {
                break;
            }
            if space {
                out.push(' ');
                count += 1;
                space = false;
            }
            out.push(ch);
            count += 1;
        }
        (!out.is_empty()).then_some(Name(out))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Bidirectional controls, zero-width space and byte-order mark: they can disguise a name.
/// Zero-width joiners stay; some scripts and emoji need them.
fn is_invisible(ch: char) -> bool {
    matches!(ch, '\u{200B}' | '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{FEFF}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

impl fmt::Debug for Name {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Name(<{} chars>)", self.0.chars().count())
    }
}

impl Serialize for Name {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Name {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Name::clean(&raw).ok_or_else(|| serde::de::Error::custom("empty name"))
    }
}

/// What went wrong with a JSON text, without any of its content: serde's own message can quote
/// the string it choked on, and that string may be a name.
pub(crate) fn json_error(error: &serde_json::Error) -> String {
    let kind = match error.classify() {
        serde_json::error::Category::Io => "read",
        serde_json::error::Category::Syntax => "syntax",
        serde_json::error::Category::Data => "data",
        serde_json::error::Category::Eof => "end of input",
    };
    format!(
        "{kind} error at line {}, column {}",
        error.line(),
        error.column()
    )
}

/// Split a trailing tag group such as `" (Host, me)"` off a name.
///
/// The group is removed only when every comma-separated tag in it is in `tags`, so a name that
/// itself ends in parentheses (`"Ana (she/her)"`) is kept whole. Returns the rest and whether a
/// tag from `self_tags` was present.
pub fn split_suffix_tags<'a>(
    text: &'a str,
    tags: &[String],
    self_tags: &[String],
) -> (&'a str, bool) {
    let trimmed = text.trim_end();
    let Some(inner) = trimmed.strip_suffix(')') else {
        return (text, false);
    };
    let Some(open) = inner.rfind(" (") else {
        return (text, false);
    };
    let group = &inner[open + 2..];
    let found: Vec<&str> = group.split(',').map(str::trim).collect();
    if found
        .iter()
        .any(|tag| !tags.iter().any(|known| known == tag))
    {
        return (text, false);
    }
    let is_self = found
        .iter()
        .any(|tag| self_tags.iter().any(|known| known == tag));
    (&inner[..open], is_self)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_makes_one_trimmed_line() {
        let name = Name::clean("  Alex\n\tExample \r\n").unwrap();
        assert_eq!(name.as_str(), "Alex Example");
        assert_eq!(
            Name::clean("Alex\u{2028}Example").unwrap().as_str(),
            "Alex Example"
        );
        assert_eq!(Name::clean("A   B").unwrap().as_str(), "A B");
    }

    #[test]
    fn clean_removes_bidi_controls_and_keeps_joiners() {
        assert_eq!(
            Name::clean("\u{202E}Alex\u{202C} Example\u{200F}")
                .unwrap()
                .as_str(),
            "Alex Example"
        );
        let family = "\u{1F469}\u{200D}\u{1F467}";
        assert_eq!(Name::clean(family).unwrap().as_str(), family);
    }

    #[test]
    fn clean_cuts_to_80_characters_without_a_trailing_space() {
        let long = "é".repeat(200);
        assert_eq!(
            Name::clean(&long).unwrap().as_str().chars().count(),
            MAX_NAME_CHARS
        );
        let words = format!("{} b", "a".repeat(79));
        assert_eq!(Name::clean(&words).unwrap().as_str(), "a".repeat(79));
        let exact = "x".repeat(80);
        assert_eq!(Name::clean(&exact).unwrap().as_str(), exact);
    }

    #[test]
    fn clean_keeps_non_latin_text() {
        assert_eq!(Name::clean(" 山田 太郎 ").unwrap().as_str(), "山田 太郎");
        assert_eq!(
            Name::clean("Zoë O'Brien-Núñez").unwrap().as_str(),
            "Zoë O'Brien-Núñez"
        );
    }

    #[test]
    fn clean_rejects_empty_text() {
        assert_eq!(Name::clean(""), None);
        assert_eq!(Name::clean(" \n\t "), None);
        assert_eq!(Name::clean("\u{200B}\u{FEFF}"), None);
    }

    #[test]
    fn debug_never_prints_the_name() {
        let name = Name::clean("Alex Example").unwrap();
        assert_eq!(format!("{name:?}"), "Name(<12 chars>)");
        assert_eq!(format!("{:?}", vec![name]), "[Name(<12 chars>)]");
    }

    #[test]
    fn serde_round_trip_cleans() {
        let name: Name = serde_json::from_str("\" Alex\\nExample \"").unwrap();
        assert_eq!(name.as_str(), "Alex Example");
        assert_eq!(serde_json::to_string(&name).unwrap(), "\"Alex Example\"");
        assert!(serde_json::from_str::<Name>("\"  \"").is_err());
    }

    #[test]
    fn suffix_tags_split_only_known_groups() {
        let tags: Vec<String> = ["Host", "Co-host", "me", "Guest"]
            .map(String::from)
            .to_vec();
        let me = vec!["me".to_owned()];
        assert_eq!(
            split_suffix_tags("Alex Example (Host, me)", &tags, &me),
            ("Alex Example", true)
        );
        assert_eq!(
            split_suffix_tags("Robin (Co-host)", &tags, &me),
            ("Robin", false)
        );
        assert_eq!(
            split_suffix_tags("Robin (Guest,me)", &tags, &me),
            ("Robin", true)
        );
        assert_eq!(
            split_suffix_tags("Ana (she/her)", &tags, &me),
            ("Ana (she/her)", false)
        );
        assert_eq!(
            split_suffix_tags("Ana (she/her) (Host, me)", &tags, &me),
            ("Ana (she/her)", true)
        );
        assert_eq!(
            split_suffix_tags("Lee, Kim (Host)", &tags, &me),
            ("Lee, Kim", false)
        );
        assert_eq!(split_suffix_tags("(Host)", &tags, &me), ("(Host)", false));
        assert_eq!(
            split_suffix_tags("Alex Example", &tags, &me),
            ("Alex Example", false)
        );
    }
}
