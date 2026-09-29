//! "Private cloud" transcription engine: upload a STOPPED Local recording to
//! TinyCloud Private Transcription (PTX) through the TinyChat backend's grant.
//!
//! Trust boundaries (plan §4.5):
//! - The webview never names a file. When the transcription plugin reports a
//!   capture `stopped`, [`registry`] opens that session's audio file itself
//!   (`openat` + `O_NOFOLLOW`, inside `vault/sessions` only), keeps the
//!   descriptor, and hands the webview an opaque random handle.
//! - Hashing and upload read that same descriptor, so a file swapped or
//!   symlinked after the capture stopped is never what gets uploaded.
//! - Audio goes to exactly one place: the PTX origin compiled into this build
//!   ([`origins::PTX_UPLOAD_ORIGIN`]) joined with a relative `/uploads/trn_…`
//!   path from the backend. The backend cannot choose the host, and no request
//!   follows redirects.
//! - The user's bearer goes only to the compiled backend origin, and only for
//!   the create call; the upload capability never leaves this process.
//!
//! With no PTX origin compiled in (this build), nothing here opens a file:
//! `cloud_transcription_status` reports `configured: false` and the webview
//! hides the engine.

pub mod client;
pub mod commands;
pub mod origins;
pub mod reader;
pub mod registry;

use serde::Serialize;
use tauri::{Emitter, Listener, Manager};

/// The transcription plugin's capture lifecycle event (tauri-specta name).
pub const CAPTURE_LIFECYCLE_EVENT: &str = "plugin:transcription:capture-lifecycle-event";
/// Emitted once per stopped cloud-bound capture (`cloud-` session id) while
/// the engine is configured.
pub const CAPTURE_READY_EVENT: &str = "exo://capture-ready";
/// Upload progress for one capture handle (at most 4 per second).
pub const UPLOAD_PROGRESS_EVENT: &str = "exo://cloud-upload-progress";

/// Every failure the webview sees: a stable code (plan §4.6) plus context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
    /// The job this failure belongs to, when one was created (lets the webview
    /// resolve `upload_outcome_unknown` through status, or resume
    /// `active_transcription_exists`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_id: Option<String>,
}

impl CloudError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            correlation_id: None,
            retry_after_seconds: None,
            transcription_id: None,
        }
    }

    pub fn with_correlation(mut self, correlation_id: &str) -> Self {
        self.correlation_id
            .get_or_insert_with(|| correlation_id.to_string());
        self
    }

    pub fn with_transcription(mut self, transcription_id: &str) -> Self {
        self.transcription_id
            .get_or_insert_with(|| transcription_id.to_string());
        self
    }
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[derive(Default)]
pub struct CloudState {
    pub registry: registry::CaptureRegistry,
    http: std::sync::OnceLock<reqwest::Client>,
}

impl CloudState {
    pub fn http(&self) -> Result<reqwest::Client, CloudError> {
        if let Some(client) = self.http.get() {
            return Ok(client.clone());
        }
        let client = client::http_client()
            .map_err(|e| CloudError::new("service_unavailable", format!("HTTP client: {e}")))?;
        Ok(self.http.get_or_init(|| client).clone())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReadyError {
    pub code: String,
    pub message: String,
}

/// Payload of [`CAPTURE_READY_EVENT`]: a handle for the session's recording, or
/// why none could be issued.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReady {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<&'static str>,
    pub partial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CaptureReadyError>,
}

/// Registers the engine's state and, only when a PTX origin is compiled in,
/// the native listener that opens each stopped capture.
pub fn install(app: &tauri::App) {
    app.manage(CloudState::default());
    if origins::ptx_upload_origin().is_err() {
        return;
    }
    let handle = app.handle().clone();
    app.listen_any(CAPTURE_LIFECYCLE_EVENT, move |event| {
        let Some(stopped) = registry::parse_stopped(event.payload()) else {
            return;
        };
        let ready = register_stopped(&handle, stopped);
        if let Err(e) = handle.emit(CAPTURE_READY_EVENT, ready) {
            eprintln!("[exo cloud] emitting {CAPTURE_READY_EVENT} failed: {e}");
        }
    });
}

fn register_stopped(app: &tauri::AppHandle, stopped: registry::StoppedCapture) -> CaptureReady {
    use tauri_plugin_settings::SettingsPluginExt;

    let rejected = |code: &str, message: String| CaptureReady {
        session_id: stopped.session_id.clone(),
        capture_handle: None,
        size_bytes: None,
        format: None,
        partial: stopped.partial,
        error: Some(CaptureReadyError {
            code: code.to_string(),
            message,
        }),
    };
    let vault = match app.settings().vault_base() {
        Ok(base) => base,
        Err(e) => return rejected("capture_not_available", format!("vault directory: {e}")),
    };
    let sessions_dir = std::path::Path::new(vault.as_str()).join("sessions");
    match registry::open_capture(&sessions_dir, &stopped.session_id, &stopped.audio_path) {
        Ok(opened) => {
            let state = app.state::<CloudState>();
            let size = opened.stamp.size;
            let format = opened.format.as_str();
            let capture_handle = state.registry.insert(registry::Capture::new(opened));
            CaptureReady {
                session_id: stopped.session_id,
                capture_handle: Some(capture_handle),
                size_bytes: Some(size),
                format: Some(format),
                partial: stopped.partial,
                error: None,
            }
        }
        Err(rejection) => rejected(rejection.code, rejection.message),
    }
}
