/// The request data shared by native transcription and the evaluation runner.
/// Vocabulary stays empty in production until the glossary is activated in E.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestSpec {
    pub languages: Vec<String>,
    pub model: String,
    pub keywords: Vec<String>,
}

impl RequestSpec {
    pub fn production(model: impl Into<String>) -> Self {
        Self {
            languages: vec!["en".into()],
            model: model.into(),
            keywords: Vec::new(),
        }
    }
}
