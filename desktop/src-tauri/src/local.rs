//! Exo-owned commands: the webview supplies identifiers, never paths or hosts.

use anlg_language::Language;
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
    let language = "en"
        .parse::<Language>()
        .map_err(|e| LocalError::new("start_failed", format!("English language: {e}")))?;
    start_whisper_transcription(&app, id, file_path, model, language).await
}

async fn start_whisper_transcription(
    app: &AppHandle,
    session_id: String,
    file_path: String,
    model: WhisperModel,
    language: Language,
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
    app.listener2()
        .start_transcription(TranscriptionParams {
            session_id,
            provider: TranscriptionProvider::WhisperLocal,
            file_path,
            model: Some(model.to_string()),
            base_url,
            api_key: String::new(),
            languages: vec![language],
            keywords: vec![],
            num_speakers: None,
            min_speakers: None,
            max_speakers: None,
        })
        .await
        .map_err(|e| LocalError::new("start_failed", e.to_string()))
}
