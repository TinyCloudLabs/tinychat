//! Exo-owned commands: the webview supplies identifiers, never paths or hosts.

use anlg_language::Language;
use exo_local_transcription::request::RequestSpec;
use serde::Serialize;

use tauri::AppHandle;
use tauri_plugin_local_stt::{LocalModel, LocalSttPluginExt, WhisperModel};
use tauri_plugin_transcription::{
    Listener2PluginExt, ListenerPluginExt, TranscriptionParams, TranscriptionProvider,
};

use crate::session_audio;

#[derive(Debug, Serialize)]
pub struct LocalError {
    pub code: &'static str,
    pub message: String,
}

impl LocalError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// A voice note is stored outside the vault, but only its guarded staged copy
/// in vault/sessions may be passed to the plugin. The note ID remains the
/// transcription event/cancellation ID.
#[tauri::command]
pub async fn recorder_whisper_start(
    app: AppHandle,
    id: String,
    stage_id: String,
    model: WhisperModel,
) -> Result<(), LocalError> {
    if crate::recorder::files::valid_recording_id(&id) {
        tracing::info!(target: "exo_dev::whisper", kind = "pipeline", source_id = %id, operation = "whisper", phase = "start");
    }
    let sessions = crate::recorder::files::sessions_root(&app)
        .map_err(|e| LocalError::new("recording_unavailable", e))?;
    let staged = crate::recorder::files::staged_session(&sessions, &id, &stage_id)
        .map_err(|e| LocalError::new("recording_unavailable", e))?;
    let (_recording, file_path) =
        session_audio::admit_transcription(&sessions, &staged, || async {
            let snapshot = app
                .listener()
                .get_capture_snapshot()
                .await
                .map_err(|_| ())?;
            Ok(
                snapshot.active_session_id.as_deref() == Some(staged.as_str())
                    || snapshot
                        .finalizing_session_ids
                        .iter()
                        .any(|active| active == &staged),
            )
        })
        .await
        .map_err(|e| LocalError::new(e.code, e.message))?;
    let result = start_whisper_transcription(&app, id.clone(), file_path, model).await;
    tracing::info!(target: "exo_dev::whisper", kind = "pipeline", source_id = %id, operation = "whisper",
        phase = if result.is_ok() { "submitted" } else { "failed" });
    result
}

async fn start_whisper_transcription(
    app: &AppHandle,
    session_id: String,
    file_path: String,
    model: WhisperModel,
) -> Result<(), LocalError> {
    // The extension returns its own in-process server's bound URL; native
    // validation forbids redirection to any non-loopback endpoint.
    let raw_url = app
        .local_stt()
        .start_server(LocalModel::Whisper(model.clone()))
        .await
        .map_err(|e| LocalError::new("server_unavailable", e.to_string()))?;
    let base_url = crate::local_url::trusted_whisper_url(&raw_url).ok_or_else(|| {
        LocalError::new(
            "server_unavailable",
            "The Whisper server did not bind to loopback",
        )
    })?;
    let params = whisper_transcription_params(model, session_id, file_path, base_url)?;
    app.listener2()
        .start_transcription(params)
        .await
        .map_err(|e| LocalError::new("start_failed", e.to_string()))
}

/// Build the app request from the same pure production spec used by the runner.
fn whisper_transcription_params(
    model: WhisperModel,
    session_id: String,
    file_path: String,
    base_url: String,
) -> Result<TranscriptionParams, LocalError> {
    params_from_request(
        RequestSpec::production(model.to_string()),
        session_id,
        file_path,
        base_url,
    )
}

fn params_from_request(
    request: RequestSpec,
    session_id: String,
    file_path: String,
    base_url: String,
) -> Result<TranscriptionParams, LocalError> {
    let RequestSpec {
        languages,
        model,
        keywords,
    } = request;
    let languages = languages
        .into_iter()
        .map(|language| {
            language
                .parse::<Language>()
                .map_err(|e| LocalError::new("start_failed", format!("English language: {e}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TranscriptionParams {
        session_id,
        provider: TranscriptionProvider::WhisperLocal,
        file_path,
        model: Some(model),
        base_url,
        api_key: String::new(),
        languages,
        keywords,
        num_speakers: None,
        min_speakers: None,
        max_speakers: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whisper_transcription_params_maps_production_request_exactly() {
        let model = WhisperModel::QuantizedSmall;
        let params = whisper_transcription_params(
            model,
            "note".into(),
            "/staged/audio.mp3".into(),
            "http://127.0.0.1:1234/v1".into(),
        )
        .unwrap();
        assert!(matches!(
            params.provider,
            TranscriptionProvider::WhisperLocal
        ));
        assert_eq!(params.languages, vec!["en".parse::<Language>().unwrap()]);
        assert_eq!(params.keywords, Vec::<String>::new());
        assert_eq!(params.model, Some("QuantizedSmall".into()));
        assert_eq!(params.session_id, "note");
        assert_eq!(params.file_path, "/staged/audio.mp3");
        assert_eq!(params.base_url, "http://127.0.0.1:1234/v1");
        assert!(params.api_key.is_empty());
        assert!(params.num_speakers.is_none());
        assert!(params.min_speakers.is_none());
        assert!(params.max_speakers.is_none());
    }

    #[test]
    fn whisper_transcription_params_maps_languages_and_keywords_from_shared_spec() {
        let params = params_from_request(
            RequestSpec {
                languages: vec!["fr".into(), "en".into()],
                model: "QuantizedLargeTurbo".into(),
                keywords: vec!["TinyCloud".into()],
            },
            "note".into(),
            "/staged/audio.mp3".into(),
            "http://127.0.0.1:1234/v1".into(),
        )
        .unwrap();
        assert_eq!(
            params.languages,
            vec![
                "fr".parse::<Language>().unwrap(),
                "en".parse::<Language>().unwrap()
            ]
        );
        assert_eq!(params.keywords, vec!["TinyCloud"]);
        assert_eq!(params.model, Some("QuantizedLargeTurbo".into()));
        assert!(matches!(
            params.provider,
            TranscriptionProvider::WhisperLocal
        ));
    }
}
