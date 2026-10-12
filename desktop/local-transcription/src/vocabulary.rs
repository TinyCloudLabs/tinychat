use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Vocabulary {
    pub version: u32,
    pub terms: Vec<String>,
}

pub fn load() -> Result<Vocabulary, serde_json::Error> {
    serde_json::from_str(include_str!("../../transcription-vocabulary.json"))
}
