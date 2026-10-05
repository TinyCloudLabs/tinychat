//! The three webview commands. Each is declared in build.rs's AppManifest and
//! granted only by `capabilities-transcription/transcription.json`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::future::{AbortHandle, Abortable};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::client::{self, CreateRequest};
use super::origins;
use super::reader::{ensure_unchanged, sha256_hex};
use super::registry::Capture;
use super::{CloudError, CloudState, UPLOAD_PROGRESS_EVENT};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    /// A PTX origin is compiled into this build.
    pub configured: bool,
}

/// Whether this build can upload at all (the webview also needs the backend's
/// capabilities before it shows the engine).
#[tauri::command]
pub fn cloud_transcription_status() -> CloudStatus {
    CloudStatus {
        configured: origins::ptx_upload_origin().is_ok(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submitted {
    pub transcription_id: String,
    /// PTX's job status after the upload (`queued` or later), when reported.
    pub status: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgress<'a> {
    capture_handle: &'a str,
    sent_bytes: u64,
    total_bytes: u64,
}

fn invalid(message: &str) -> CloudError {
    CloudError::new("invalid_argument", message)
}

fn valid_language(language: &str) -> bool {
    let b = language.as_bytes();
    match b.len() {
        2 => b.iter().all(u8::is_ascii_lowercase),
        5 => {
            b[..2].iter().all(u8::is_ascii_lowercase)
                && b[2] == b'-'
                && b[3..].iter().all(u8::is_ascii_alphabetic)
        }
        _ => false,
    }
}

/// Printable ASCII without spaces: header-safe and not a smuggled second header.
fn valid_bearer(bearer: &str) -> bool {
    !bearer.is_empty()
        && bearer.len() <= 16 * 1024
        && bearer.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Hash the recording, create the job at the backend, then upload it to PTX.
///
/// `attempt_id` is the create call's Idempotency-Key: re-submitting with the
/// same id after `upload_outcome_unknown` or a lost response re-joins the same
/// job; a new id creates a new job.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cloud_transcription_submit(
    app: AppHandle,
    state: State<'_, CloudState>,
    capture_handle: String,
    attempt_id: String,
    backend_url: String,
    bearer: String,
    language: String,
) -> Result<Submitted, CloudError> {
    let correlation_id = uuid::Uuid::new_v4().to_string();
    let tag = |e: CloudError| e.with_correlation(&correlation_id);

    let origin = origins::ptx_upload_origin().map_err(tag)?;
    let backend = origins::backend_origin().map_err(tag)?;
    origins::check_backend_url(&backend_url, &backend).map_err(tag)?;
    if uuid::Uuid::parse_str(&attempt_id).is_err() {
        return Err(tag(invalid("attempt_id must be a UUID")));
    }
    if !valid_bearer(&bearer) {
        return Err(tag(invalid("The session token is not valid")));
    }
    if !valid_language(&language) {
        return Err(tag(invalid("language must look like en or en-US")));
    }
    let capture = state.registry.get(&capture_handle).ok_or_else(|| {
        tag(CloudError::new(
            "capture_not_available",
            "This recording is no longer available to upload",
        ))
    })?;
    let http = state.http().map_err(tag)?;

    let (abort, registration) = AbortHandle::new_pair();
    if !capture.begin_upload(abort) {
        return Err(tag(CloudError::new(
            "upload_in_progress",
            "This recording is already being uploaded",
        )));
    }
    let on_progress = progress_emitter(app, capture_handle);
    let job = Submission {
        on_progress,
        http,
        origin,
        backend,
        capture: capture.clone(),
        attempt_id,
        bearer,
        language,
        correlation_id: correlation_id.clone(),
    };
    let outcome = Abortable::new(job.run(), registration).await;
    capture.end_upload();
    match outcome {
        Ok(result) => result.map_err(tag),
        Err(_aborted) => Err(tag(CloudError::new(
            "cancelled",
            "The upload was cancelled",
        ))),
    }
}

/// Abort this capture's upload, if one is running, and release its handle.
/// The recording stays on disk. Idempotent.
#[tauri::command]
pub fn cloud_transcription_cancel(
    state: State<'_, CloudState>,
    capture_handle: String,
) -> Result<(), CloudError> {
    if let Some(capture) = state.registry.remove(&capture_handle) {
        capture.abort_upload();
    }
    Ok(())
}

/// `exo://cloud-upload-progress` for this handle, at most 4 per second (plus the last).
fn progress_emitter(app: AppHandle, capture_handle: String) -> client::ProgressFn {
    let started = Instant::now();
    let last_emit_ms = AtomicU64::new(0);
    Arc::new(move |sent, total| {
        let now = started.elapsed().as_millis() as u64;
        let last = last_emit_ms.load(Ordering::Relaxed);
        if sent < total && last != 0 && now.saturating_sub(last) < 250 {
            return;
        }
        last_emit_ms.store(now.max(1), Ordering::Relaxed);
        let _ = app.emit(
            UPLOAD_PROGRESS_EVENT,
            UploadProgress {
                capture_handle: &capture_handle,
                sent_bytes: sent,
                total_bytes: total,
            },
        );
    })
}

struct Submission {
    on_progress: client::ProgressFn,
    http: reqwest::Client,
    origin: reqwest::Url,
    backend: reqwest::Url,
    capture: Arc<Capture>,
    attempt_id: String,
    bearer: String,
    language: String,
    correlation_id: String,
}

impl Submission {
    async fn run(self) -> Result<Submitted, CloudError> {
        let capture = self.capture.clone();
        let sha256 = tauri::async_runtime::spawn_blocking(move || {
            ensure_unchanged(&capture.file, &capture.stamp)?;
            let digest = sha256_hex(&capture.file, capture.stamp.size).map_err(|e| {
                CloudError::new("file_changed", format!("Reading the recording: {e}"))
            })?;
            ensure_unchanged(&capture.file, &capture.stamp)?;
            Ok::<_, CloudError>(digest)
        })
        .await
        .map_err(|e| {
            CloudError::new(
                "capture_not_available",
                format!("Hashing the recording: {e}"),
            )
        })??;

        let created = client::create_job(
            &self.http,
            &self.backend,
            &self.bearer,
            &self.attempt_id,
            &self.correlation_id,
            &CreateRequest {
                content_type: self.capture.format.content_type(),
                byte_size: self.capture.stamp.size,
                sha256,
                language: self.language.clone(),
            },
        )
        .await?;
        let id = created.id.clone();
        // A replay of an attempt whose upload PTX already took: nothing to send.
        let Some(grant) = created.upload else {
            return Ok(Submitted {
                transcription_id: id,
                status: Some(created.status),
            });
        };
        let url = origins::upload_url(&self.origin, &grant.path)
            .map_err(|e| e.with_transcription(&id))?;

        match client::upload(
            &self.http,
            url,
            &grant.capability,
            self.capture.clone(),
            &self.correlation_id,
            self.on_progress.clone(),
        )
        .await
        {
            Ok(status) => Ok(Submitted {
                transcription_id: id,
                status,
            }),
            Err(err) => {
                // A recording modified mid-upload explains the failure better.
                let err = match ensure_unchanged(&self.capture.file, &self.capture.stamp) {
                    Err(changed) => changed,
                    Ok(()) => err,
                };
                Err(err.with_transcription(&id))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argument_validation() {
        assert!(valid_language("en") && valid_language("en-US") && valid_language("pt-br"));
        assert!(
            !valid_language("EN")
                && !valid_language("english")
                && !valid_language("en_US")
                && !valid_language("")
        );
        assert!(valid_bearer("eyJhbGciOi.abc-_~+/="));
        assert!(!valid_bearer("") && !valid_bearer("a b") && !valid_bearer("a\r\nX-Evil: 1"));
        assert!(!valid_bearer(&"a".repeat(16 * 1024 + 1)));
    }

    use crate::cloud::client::tests::{Reply, Server, CAPABILITY, ID};
    use crate::cloud::registry::open_capture;
    use crate::cloud::registry::tests::{sessions_with, SESSION};

    type TempDir = crate::cloud::registry::tests::tempdir::TempDir;

    fn submission(
        backend: &Server,
        ptx: &Server,
        contents: &[u8],
    ) -> (TempDir, String, Submission) {
        let (dir, sessions) = sessions_with(contents);
        let path = sessions
            .join(SESSION)
            .join("audio.mp3")
            .to_string_lossy()
            .into_owned();
        let capture = Arc::new(Capture::new(
            open_capture(&sessions, SESSION, &path).unwrap(),
        ));
        let job = Submission {
            on_progress: Arc::new(|_, _| {}),
            http: client::http_client().unwrap(),
            origin: ptx.url.clone(),
            backend: backend.url.clone(),
            capture,
            attempt_id: "7d0b6f0e-3c1a-4b8e-9f2d-5a6b7c8d9e0f".into(),
            bearer: "session-token".into(),
            language: "en".into(),
            correlation_id: "c0ffee00-0000-4000-8000-000000000000".into(),
        };
        (dir, path, job)
    }

    fn created(path: &str) -> Reply {
        Reply::Http(
            "201 Created",
            vec![("content-type", "application/json".into())],
            format!(
                r#"{{"id":"{ID}","status":"awaiting_upload","byte_size":3,"upload":{{"path":"{path}","capability":"{CAPABILITY}","expires_at":"2026-09-29T12:00:00Z"}}}}"#
            ),
        )
    }

    #[test]
    fn hashes_creates_and_uploads_the_same_bytes_to_the_compiled_origin() {
        let backend = Server::start(vec![created(&format!("/uploads/{ID}"))]);
        let ptx = Server::start(vec![Reply::Http(
            "201 Created",
            vec![],
            r#"{"status":"queued"}"#.into(),
        )]);
        let (_d, _path, job) = submission(&backend, &ptx, b"abc");
        let done = tauri::async_runtime::block_on(job.run()).unwrap();
        assert_eq!(done.transcription_id, ID);
        assert_eq!(done.status.as_deref(), Some("queued"));

        let create = &backend.requests()[0];
        let body: serde_json::Value = serde_json::from_slice(&create.body).unwrap();
        assert_eq!(
            body["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(body["byte_size"], 3);
        assert_eq!(body["content_type"], "audio/mpeg");
        let put = &ptx.requests()[0];
        assert_eq!(put.path, format!("/uploads/{ID}"));
        assert_eq!(put.body, b"abc");
        // The bearer went to the backend only; the capability to PTX only.
        assert_eq!(
            put.header("authorization"),
            Some(format!("Bearer {CAPABILITY}").as_str())
        );
        assert_eq!(create.header("authorization"), Some("Bearer session-token"));
    }

    #[test]
    fn an_upload_failure_names_the_job_so_status_can_decide() {
        let backend = Server::start(vec![created(&format!("/uploads/{ID}"))]);
        let ptx = Server::start(vec![Reply::Drop]);
        let (_d, _path, job) = submission(&backend, &ptx, b"abc");
        let err = tauri::async_runtime::block_on(job.run()).unwrap_err();
        assert_eq!(err.code, "upload_outcome_unknown");
        assert_eq!(err.transcription_id.as_deref(), Some(ID));
    }

    #[test]
    fn a_replay_of_an_accepted_upload_sends_nothing() {
        let backend = Server::start(vec![Reply::Http(
            "200 OK",
            vec![("content-type", "application/json".into())],
            format!(r#"{{"id":"{ID}","status":"processing","byte_size":3}}"#),
        )]);
        let ptx = Server::start(vec![]);
        let (_d, _path, job) = submission(&backend, &ptx, b"abc");
        let done = tauri::async_runtime::block_on(job.run()).unwrap();
        assert_eq!(done.status.as_deref(), Some("processing"));
        assert!(ptx.requests().is_empty());
    }

    #[test]
    fn a_recording_changed_after_stop_is_never_uploaded() {
        let backend = Server::start(vec![created(&format!("/uploads/{ID}"))]);
        let ptx = Server::start(vec![]);
        let (_d, path, job) = submission(&backend, &ptx, b"abc");
        // Append to the recording through its path after the handle was issued.
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"def")
            .unwrap();
        let err = tauri::async_runtime::block_on(job.run()).unwrap_err();
        assert_eq!(err.code, "file_changed");
        assert!(backend.requests().is_empty() && ptx.requests().is_empty());
    }

    #[test]
    fn status_is_configured_in_this_build() {
        if std::env::var_os("EXO_DEBUG_PTX_ORIGIN").is_none() {
            assert!(cloud_transcription_status().configured);
        }
    }
}
