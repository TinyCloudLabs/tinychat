//! The two requests the engine makes: create the job at the TinyChat backend
//! (bearer), then one capped PUT of the recording to PTX (job capability).
//! Redirects are never followed.
//!
//! PTX's upload contract is status-only after acceptance: a 201 is the only
//! success, and accepting an upload deletes the job's capabilities, so a
//! replayed PUT gets 401 and changes nothing. Any other answer (or none) is a
//! failure the webview resolves by reading the job's status: `awaiting_upload`
//! means re-upload, anything later means the upload landed.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::{select, Either};
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER};
use reqwest::{redirect, Client, StatusCode, Url};
use serde_json::Value;

use super::origins::{is_transcription_id, is_upload_path};
use super::reader::{read_chunk, CHUNK_BYTES};
use super::registry::Capture;
use super::CloudError;

/// The backend's create route (plan §4.4).
pub const CREATE_PATH: &str = "/api/transcriber/private-cloud/transcriptions";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CREATE_TIMEOUT: Duration = Duration::from_secs(60);
/// No bytes taken by the connection for this long while sending: stalled.
const UPLOAD_IDLE: Duration = Duration::from_secs(60);
/// All bytes sent but no response for this long (PTX verifies hash + audio first).
const UPLOAD_RESPONSE: Duration = Duration::from_secs(180);
/// Hard cap on one PUT, under the capability's 60 min expiry.
const UPLOAD_MAX: Duration = Duration::from_secs(55 * 60);

/// Codes relayed from the backend or PTX as-is; anything else is
/// `upstream_bad_response` (or a status-class default).
const RELAYED_CODES: &[&str] = &[
    "invalid_request",
    "invalid_idempotency_key",
    "unsupported_media_type",
    "recording_too_large",
    "recording_too_long",
    "unsupported_recording",
    "invalid_audio",
    "no_speech",
    "transcription_not_found",
    "active_transcription_exists",
    "idempotency_conflict",
    "quota_exceeded",
    "service_busy",
    "service_paused",
    "service_unavailable",
    "upstream_bad_response",
    "service_misconfigured",
    "upload_expired",
    "upload_integrity_failed",
    "provider_unavailable",
    "provider_outcome_unknown",
    "processing_timeout",
    "transcription_failed",
];

pub fn http_client() -> reqwest::Result<Client> {
    Client::builder()
        .redirect(redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("Exo/", env!("CARGO_PKG_VERSION")))
        .build()
}

pub struct CreateRequest {
    pub content_type: &'static str,
    pub byte_size: u64,
    pub sha256: String,
    pub language: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct UploadGrant {
    pub path: String,
    pub capability: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Created {
    pub id: String,
    pub status: String,
    /// Present only while the job awaits its upload.
    pub upload: Option<UploadGrant>,
}

#[derive(Default)]
struct ErrorBody {
    code: Option<String>,
    message: Option<String>,
    correlation_id: Option<String>,
    retry_after_seconds: Option<u64>,
    id: Option<String>,
    status: Option<String>,
    /// PTX `upload_rejected`: the terminal job error the upload caused.
    job_error_code: Option<String>,
}

/// Reads `{error:{code,message,correlation_id,retry_after_seconds,id}}` (backend)
/// or `{error:{type,code,message,correlation_id,status,job_error}}` (PTX);
/// tolerant of anything else.
fn parse_error_body(bytes: &[u8]) -> ErrorBody {
    let Ok(v) = serde_json::from_slice::<Value>(bytes) else {
        return ErrorBody::default();
    };
    let err = v
        .get("error")
        .filter(|e| e.is_object())
        .unwrap_or(&Value::Null);
    let text =
        |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    ErrorBody {
        code: text(err, "code").or_else(|| text(&v, "code")),
        message: text(err, "message"),
        correlation_id: text(err, "correlation_id"),
        retry_after_seconds: err.get("retry_after_seconds").and_then(Value::as_u64),
        id: text(err, "id").or_else(|| text(&v, "id")),
        status: text(&v, "status").or_else(|| text(err, "status")),
        job_error_code: err
            .get("job_error")
            .and_then(|j| j.get("code"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn retry_after_header(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers.get(RETRY_AFTER)?.to_str().ok()?.trim().parse().ok()
}

fn relayed(code: Option<String>) -> Option<String> {
    code.filter(|c| RELAYED_CODES.contains(&c.as_str()))
}

fn valid_capability(capability: &str) -> bool {
    capability.strip_prefix("tcu_").is_some_and(|rest| {
        (16..=256).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// The create response, strictly: an off-contract body is `upstream_bad_response`.
pub fn parse_created(bytes: &[u8]) -> Result<Created, CloudError> {
    let bad = |why: &str| {
        CloudError::new(
            "upstream_bad_response",
            format!("Unexpected create response: {why}"),
        )
    };
    let v: Value = serde_json::from_slice(bytes).map_err(|_| bad("not JSON"))?;
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_transcription_id(id))
        .ok_or_else(|| bad("id"))?;
    let status = v
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad("status"))?;
    let upload = match v.get("upload") {
        None | Some(Value::Null) => None,
        Some(upload) => {
            let path = upload
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !is_upload_path(path) || path != format!("/uploads/{id}") {
                return Err(bad("upload path"));
            }
            let capability = upload
                .get("capability")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !valid_capability(capability) {
                return Err(bad("upload capability"));
            }
            Some(UploadGrant {
                path: path.to_string(),
                capability: capability.to_string(),
            })
        }
    };
    if (status == "awaiting_upload") != upload.is_some() {
        return Err(bad("upload grant does not match status"));
    }
    Ok(Created {
        id: id.to_string(),
        status: status.to_string(),
        upload,
    })
}

/// A non-2xx create response as a stable public error.
fn create_error(status: StatusCode, retry_after: Option<u64>, bytes: &[u8]) -> CloudError {
    if status.is_redirection() {
        return CloudError::new(
            "service_misconfigured",
            "The backend answered with a redirect; it was not followed",
        );
    }
    if status == StatusCode::NOT_FOUND {
        return CloudError::new(
            "feature_unavailable",
            "Private cloud transcription is not available for this account",
        );
    }
    if status == StatusCode::UNAUTHORIZED {
        return CloudError::new("unauthenticated", "Your session expired. Sign in again.");
    }
    let body = parse_error_body(bytes);
    let code = relayed(body.code).unwrap_or_else(|| {
        match status.as_u16() {
            429 => "service_busy",
            500..=599 => "service_unavailable",
            _ => "upstream_bad_response",
        }
        .to_string()
    });
    CloudError {
        message: body
            .message
            .unwrap_or_else(|| format!("The backend answered {status}")),
        code,
        correlation_id: body.correlation_id,
        retry_after_seconds: body.retry_after_seconds.or(retry_after),
        transcription_id: body.id.filter(|id| is_transcription_id(id)),
    }
}

/// POST the job to the backend. Idempotent per `attempt_id`: a replay after a
/// lost response returns the same job (with a fresh capability while it still
/// awaits its upload).
pub async fn create_job(
    client: &Client,
    backend: &Url,
    bearer: &str,
    attempt_id: &str,
    correlation_id: &str,
    request: &CreateRequest,
) -> Result<Created, CloudError> {
    let url = backend
        .join(CREATE_PATH)
        .map_err(|e| CloudError::new("backend_origin_mismatch", format!("backend URL: {e}")))?;
    let body = serde_json::json!({
        "content_type": request.content_type,
        "byte_size": request.byte_size,
        "sha256": request.sha256,
        "language": request.language,
        "channel_mode": "separate",
        "channel_labels": ["Speaker 1", "Speaker 2"],
    });
    let response = client
        .post(url)
        .bearer_auth(bearer)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Idempotency-Key", attempt_id)
        .header("X-Correlation-Id", correlation_id)
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .timeout(CREATE_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            CloudError::new(
                "service_unavailable",
                format!("Could not reach the backend: {e}"),
            )
        })?;
    let status = response.status();
    let retry_after = retry_after_header(response.headers());
    let bytes = response.bytes().await.map_err(|e| {
        CloudError::new(
            "service_unavailable",
            format!("Reading the backend response: {e}"),
        )
    })?;
    if status == StatusCode::CREATED || status == StatusCode::OK {
        return parse_created(&bytes);
    }
    Err(create_error(status, retry_after, &bytes))
}

/// Upload progress shared by the body stream and the watchdog.
struct Progress {
    started: Instant,
    /// Milliseconds since `started` at the last chunk handed to the connection.
    last_ms: AtomicU64,
    sent: AtomicU64,
    read_failed: AtomicBool,
}

impl Progress {
    fn touch(&self) {
        self.last_ms
            .store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
    fn idle(&self) -> Duration {
        self.started
            .elapsed()
            .saturating_sub(Duration::from_millis(self.last_ms.load(Ordering::Relaxed)))
    }
}

pub type ProgressFn = Arc<dyn Fn(u64, u64) + Send + Sync>;

async fn watchdog(progress: Arc<Progress>, size: u64) -> CloudError {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let body_done = progress.sent.load(Ordering::Relaxed) >= size;
        let limit = if body_done {
            UPLOAD_RESPONSE
        } else {
            UPLOAD_IDLE
        };
        if progress.idle() > limit || progress.started.elapsed() > UPLOAD_MAX {
            return CloudError::new(
                "upload_outcome_unknown",
                if body_done {
                    "PTX did not answer the upload in time"
                } else {
                    "The upload stalled"
                },
            );
        }
    }
}

/// A PUT response: 201 is the only success. Everything else is a stable code
/// for a failure whose outcome the job's status decides.
fn upload_result(
    status: StatusCode,
    retry_after: Option<u64>,
    bytes: &[u8],
) -> Result<Option<String>, CloudError> {
    let body = parse_error_body(bytes);
    let err = |code: &str, message: &str| {
        let mut e = CloudError::new(code, message.to_string());
        e.correlation_id = body.correlation_id.clone();
        e.retry_after_seconds = body.retry_after_seconds.or(retry_after);
        Err(e)
    };
    match status.as_u16() {
        201 => Ok(body.status.or_else(|| Some("queued".into()))),
        300..=399 => err(
            "service_misconfigured",
            "PTX answered with a redirect; it was not followed",
        ),
        // The job no longer takes an upload with this capability: it may be the
        // replay of an upload PTX already accepted (capabilities die on acceptance).
        401 => err(
            "upload_outcome_unknown",
            "PTX no longer accepts this upload; its status decides",
        ),
        // Another PUT of this job holds the upload lease.
        409 if body.code.as_deref() == Some("upload_in_progress") => err(
            "upload_outcome_unknown",
            "Another upload of this recording is in progress",
        ),
        // Rejected before any byte counted (length mismatch) or cut off: re-upload.
        400 | 408 => err(
            "upload_interrupted",
            "PTX did not receive the whole recording",
        ),
        410 => err("upload_capability_expired", "The upload permission expired"),
        413 => err(
            "recording_too_large",
            "The recording is larger than the private cloud limit",
        ),
        415 => err(
            "unsupported_recording",
            "This recording format is not supported",
        ),
        // upload_rejected: the upload failed the job; job_error says why.
        422 => match relayed(body.job_error_code.clone()) {
            Some(code) => err(&code, "PTX rejected the recording"),
            None => err("upstream_bad_response", "PTX rejected the recording"),
        },
        429 | 503 => match relayed(body.code.clone()) {
            Some(code) => err(&code, "PTX cannot take the upload right now"),
            None => err(
                "upload_outcome_unknown",
                "PTX's answer to the upload was unclear",
            ),
        },
        // 5xx, gateway errors, anything unexpected: the bytes may or may not
        // have been accepted. Never "failed" — the webview asks status.
        _ => err(
            "upload_outcome_unknown",
            "PTX's answer to the upload was unclear",
        ),
    }
}

/// One PUT of the whole recording from the capture's descriptor, with an exact
/// `Content-Length`. Returns the job status PTX reported.
pub async fn upload(
    client: &Client,
    url: Url,
    capability: &str,
    capture: Arc<Capture>,
    correlation_id: &str,
    on_progress: ProgressFn,
) -> Result<Option<String>, CloudError> {
    let size = capture.stamp.size;
    let progress = Arc::new(Progress {
        started: Instant::now(),
        last_ms: AtomicU64::new(0),
        sent: AtomicU64::new(0),
        read_failed: AtomicBool::new(false),
    });

    let stream_progress = progress.clone();
    let stream_capture = capture.clone();
    let chunks = futures_util::stream::try_unfold(0u64, move |offset| {
        let capture = stream_capture.clone();
        let progress = stream_progress.clone();
        let on_progress = on_progress.clone();
        async move {
            if offset >= size {
                return Ok::<_, std::io::Error>(None);
            }
            let len = CHUNK_BYTES.min((size - offset) as usize);
            let read = tauri::async_runtime::spawn_blocking(move || {
                read_chunk(&capture.file, offset, len)
            })
            .await
            .map_err(std::io::Error::other)
            .and_then(|r| r);
            let chunk =
                read.inspect_err(|_| progress.read_failed.store(true, Ordering::Relaxed))?;
            let sent = offset + len as u64;
            progress.sent.store(sent, Ordering::Relaxed);
            progress.touch();
            on_progress(sent, size);
            Ok(Some((chunk, sent)))
        }
    });

    let request = client
        .put(url)
        .bearer_auth(capability)
        .header(CONTENT_LENGTH, size)
        .header(CONTENT_TYPE, capture.format.content_type())
        .header("X-Correlation-Id", correlation_id)
        .body(reqwest::Body::wrap_stream(chunks))
        .send();

    let response = match select(
        Box::pin(request),
        Box::pin(watchdog(progress.clone(), size)),
    )
    .await
    {
        Either::Left((Ok(response), _)) => response,
        Either::Left((Err(e), _)) => {
            if progress.read_failed.load(Ordering::Relaxed) {
                return Err(CloudError::new(
                    "file_changed",
                    "The recording could not be read to the end",
                ));
            }
            if e.is_connect() {
                return Err(CloudError::new(
                    "upload_interrupted",
                    format!("Could not reach PTX: {e}"),
                ));
            }
            return Err(CloudError::new(
                "upload_outcome_unknown",
                format!("The upload connection failed: {e}"),
            ));
        }
        Either::Right((stalled, _)) => return Err(stalled),
    };
    let status = response.status();
    let retry_after = retry_after_header(response.headers());
    // A 201 is decisive even if its body is lost.
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(_) if status == StatusCode::CREATED => return Ok(Some("queued".into())),
        Err(e) => {
            return Err(CloudError::new(
                "upload_outcome_unknown",
                format!("Reading PTX's answer: {e}"),
            ));
        }
    };
    upload_result(status, retry_after, &bytes)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cloud::registry::tests::{sessions_with, SESSION};
    use crate::cloud::registry::{open_capture, Capture};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Mutex;

    pub const ID: &str = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
    pub const CAPABILITY: &str = "tcu_abcdefghijklmnop0123456789";

    #[derive(Debug, Clone)]
    pub struct Received {
        pub method: String,
        pub path: String,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Received {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    pub enum Reply {
        /// Status line + headers + body.
        Http(&'static str, Vec<(&'static str, String)>, String),
        /// Read the request, then close without answering.
        Drop,
    }

    /// A one-shot-per-connection HTTP/1.1 server on 127.0.0.1 answering each
    /// accepted connection with the next reply.
    pub struct Server {
        pub url: Url,
        pub received: Arc<Mutex<Vec<Received>>>,
    }

    fn read_request(stream: &mut TcpStream) -> Option<Received> {
        let mut reader = BufReader::new(stream.try_clone().ok()?);
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let mut parts = line.split_whitespace();
        let method = parts.next()?.to_string();
        let path = parts.next()?.to_string();
        let mut headers = Vec::new();
        loop {
            let mut h = String::new();
            reader.read_line(&mut h).ok()?;
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            let (k, v) = h.split_once(':')?;
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
        let len = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body).ok()?;
        Some(Received {
            method,
            path,
            headers,
            body,
        })
    }

    impl Server {
        pub fn start(replies: Vec<Reply>) -> Server {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let received = Arc::new(Mutex::new(Vec::new()));
            let log = received.clone();
            std::thread::spawn(move || {
                for reply in replies {
                    let Ok((mut stream, _)) = listener.accept() else {
                        return;
                    };
                    if let Some(req) = read_request(&mut stream) {
                        log.lock().unwrap().push(req);
                    }
                    if let Reply::Http(status, headers, body) = reply {
                        let mut out = format!(
                            "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n",
                            body.len()
                        );
                        for (k, v) in headers {
                            out.push_str(&format!("{k}: {v}\r\n"));
                        }
                        out.push_str("\r\n");
                        out.push_str(&body);
                        let _ = stream.write_all(out.as_bytes());
                    }
                }
            });
            Server { url, received }
        }

        pub fn requests(&self) -> Vec<Received> {
            self.received.lock().unwrap().clone()
        }
    }

    fn json(status: &'static str, body: &str) -> Reply {
        Reply::Http(
            status,
            vec![("content-type", "application/json".into())],
            body.to_string(),
        )
    }

    fn request() -> CreateRequest {
        CreateRequest {
            content_type: "audio/mpeg",
            byte_size: 3,
            sha256: "ab".repeat(32),
            language: "en".into(),
        }
    }

    fn created_body(path: &str) -> String {
        format!(
            r#"{{"id":"{ID}","status":"awaiting_upload","byte_size":3,"upload":{{"path":"{path}","capability":"{CAPABILITY}","expires_at":"2026-09-29T12:00:00Z"}}}}"#
        )
    }

    fn create(server: &Server) -> Result<Created, CloudError> {
        let client = http_client().unwrap();
        tauri::async_runtime::block_on(create_job(
            &client,
            &server.url,
            "session-token",
            "7d0b6f0e-3c1a-4b8e-9f2d-5a6b7c8d9e0f",
            "c0ffee00-0000-4000-8000-000000000000",
            &request(),
        ))
    }

    #[test]
    fn create_sends_metadata_only_with_bearer_csrf_and_idempotency() {
        let server = Server::start(vec![json(
            "201 Created",
            &created_body(&format!("/uploads/{ID}")),
        )]);
        let created = create(&server).unwrap();
        assert_eq!(created.id, ID);
        assert_eq!(created.upload.unwrap().capability, CAPABILITY);
        let req = &server.requests()[0];
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, CREATE_PATH);
        assert_eq!(req.header("authorization"), Some("Bearer session-token"));
        assert_eq!(req.header("x-requested-with"), Some("XMLHttpRequest"));
        assert_eq!(
            req.header("idempotency-key"),
            Some("7d0b6f0e-3c1a-4b8e-9f2d-5a6b7c8d9e0f")
        );
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["byte_size"], 3);
        assert_eq!(body["sha256"], "ab".repeat(32));
        assert!(body.get("path").is_none() && body.get("audio_path").is_none());
    }

    #[test]
    fn create_rejects_an_upload_destination_the_backend_invents() {
        for path in [
            "https://evil.example/uploads/x".to_string(),
            format!("//evil.example/uploads/{ID}"),
            "/uploads/trn_01J8Z3K4M5N6P7Q8R9S0T1V2W4".to_string(), // another job
        ] {
            let server = Server::start(vec![json("201 Created", &created_body(&path))]);
            assert_eq!(
                create(&server).unwrap_err().code,
                "upstream_bad_response",
                "{path}"
            );
        }
        let bad_capability =
            created_body(&format!("/uploads/{ID}")).replace(CAPABILITY, "Bearer x");
        let server = Server::start(vec![json("201 Created", &bad_capability)]);
        assert_eq!(create(&server).unwrap_err().code, "upstream_bad_response");
    }

    #[test]
    fn create_replay_after_upload_has_no_grant() {
        let server = Server::start(vec![json(
            "200 OK",
            &format!(r#"{{"id":"{ID}","status":"queued","byte_size":3}}"#),
        )]);
        let created = create(&server).unwrap();
        assert_eq!(created.status, "queued");
        assert!(created.upload.is_none());
    }

    #[test]
    fn create_never_follows_a_redirect() {
        let target = Server::start(vec![json(
            "201 Created",
            &created_body(&format!("/uploads/{ID}")),
        )]);
        let server = Server::start(vec![Reply::Http(
            "302 Found",
            vec![("location", format!("{}api/elsewhere", target.url))],
            String::new(),
        )]);
        assert_eq!(create(&server).unwrap_err().code, "service_misconfigured");
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            target.requests().is_empty(),
            "the redirect target was contacted"
        );
    }

    #[test]
    fn create_errors_are_stable_codes() {
        let server = Server::start(vec![Reply::Http(
            "404 Not Found",
            vec![],
            "Not Found".into(),
        )]);
        assert_eq!(create(&server).unwrap_err().code, "feature_unavailable");

        let server = Server::start(vec![json(
            "409 Conflict",
            &format!(
                r#"{{"error":{{"code":"active_transcription_exists","message":"A transcription is already in progress.","correlation_id":"c1","id":"{ID}"}}}}"#
            ),
        )]);
        let err = create(&server).unwrap_err();
        assert_eq!(err.code, "active_transcription_exists");
        assert_eq!(err.transcription_id.as_deref(), Some(ID));
        assert_eq!(err.correlation_id.as_deref(), Some("c1"));

        let server = Server::start(vec![Reply::Http(
            "429 Too Many Requests",
            vec![("retry-after", "30".into())],
            r#"{"error":{"code":"quota_exceeded","message":"Daily private cloud limit reached."}}"#
                .into(),
        )]);
        let err = create(&server).unwrap_err();
        assert_eq!(
            (err.code.as_str(), err.retry_after_seconds),
            ("quota_exceeded", Some(30))
        );

        let server = Server::start(vec![json(
            "503 Service Unavailable",
            r#"{"error":{"code":"made_up_code"}}"#,
        )]);
        assert_eq!(create(&server).unwrap_err().code, "service_unavailable");

        let server = Server::start(vec![Reply::Drop]);
        assert_eq!(create(&server).unwrap_err().code, "service_unavailable");
    }

    fn capture_of(
        contents: &[u8],
    ) -> (
        crate::cloud::registry::tests::tempdir::TempDir,
        Arc<Capture>,
    ) {
        let (d, sessions) = sessions_with(contents);
        let path = sessions
            .join(SESSION)
            .join("audio.mp3")
            .to_string_lossy()
            .into_owned();
        let opened = open_capture(&sessions, SESSION, &path).unwrap();
        (d, Arc::new(Capture::new(opened)))
    }

    fn put(server: &Server, capture: Arc<Capture>) -> Result<Option<String>, CloudError> {
        let client = http_client().unwrap();
        let url = server.url.join(&format!("/uploads/{ID}")).unwrap();
        let seen = Arc::new(AtomicU64::new(0));
        let seen2 = seen.clone();
        let result = tauri::async_runtime::block_on(upload(
            &client,
            url,
            CAPABILITY,
            capture,
            "c0ffee00-0000-4000-8000-000000000000",
            Arc::new(move |sent, _| seen2.store(sent, Ordering::Relaxed)),
        ));
        if result.is_ok() {
            assert!(seen.load(Ordering::Relaxed) > 0, "progress reported");
        }
        result
    }

    #[test]
    fn upload_streams_the_descriptor_with_exact_length_and_capability() {
        let contents: Vec<u8> = (0..(CHUNK_BYTES * 2 + 17))
            .map(|i| (i % 251) as u8)
            .collect();
        let (_d, capture) = capture_of(&contents);
        let server = Server::start(vec![json("201 Created", r#"{"status":"queued"}"#)]);
        assert_eq!(put(&server, capture).unwrap().as_deref(), Some("queued"));
        let req = &server.requests()[0];
        assert_eq!(req.method, "PUT");
        assert_eq!(req.path, format!("/uploads/{ID}"));
        assert_eq!(
            req.header("authorization"),
            Some(format!("Bearer {CAPABILITY}").as_str())
        );
        assert_eq!(
            req.header("content-length"),
            Some(contents.len().to_string().as_str())
        );
        assert_eq!(req.header("content-type"), Some("audio/mpeg"));
        assert!(req.header("transfer-encoding").is_none());
        assert_eq!(req.body, contents);
    }

    #[test]
    fn a_replayed_put_after_acceptance_is_outcome_unknown_never_success() {
        // PTX deletes a job's capabilities when it accepts the upload, so the
        // replay of a PUT whose 201 was lost gets 401; only status can tell.
        let (_d, capture) = capture_of(b"abc");
        let server = Server::start(vec![json(
            "401 Unauthorized",
            r#"{"error":{"type":"authentication_error","code":"upload_capability_invalid","message":"Invalid upload capability","correlation_id":"c-7"}}"#,
        )]);
        let err = put(&server, capture).unwrap_err();
        assert_eq!(err.code, "upload_outcome_unknown");
        assert_eq!(err.correlation_id.as_deref(), Some("c-7"));
    }

    #[test]
    fn upload_never_follows_a_redirect() {
        let (_d, capture) = capture_of(b"abc");
        let target = Server::start(vec![json("201 Created", r#"{"status":"queued"}"#)]);
        let server = Server::start(vec![Reply::Http(
            "307 Temporary Redirect",
            vec![("location", format!("{}uploads/{ID}", target.url))],
            String::new(),
        )]);
        assert_eq!(
            put(&server, capture).unwrap_err().code,
            "service_misconfigured"
        );
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            target.requests().is_empty(),
            "the redirect target received the recording"
        );
    }

    #[test]
    fn a_lost_answer_is_outcome_unknown_never_failed() {
        let (_d, capture) = capture_of(b"abc");
        let server = Server::start(vec![Reply::Drop]);
        assert_eq!(
            put(&server, capture.clone()).unwrap_err().code,
            "upload_outcome_unknown"
        );

        let server = Server::start(vec![json("502 Bad Gateway", "")]);
        assert_eq!(
            put(&server, capture).unwrap_err().code,
            "upload_outcome_unknown"
        );
    }

    #[test]
    fn unreachable_ptx_is_interrupted() {
        let (_d, capture) = capture_of(b"abc");
        // Bind then drop: nothing listens on this port.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let server = Server {
            url: Url::parse(&format!("http://127.0.0.1:{port}")).unwrap(),
            received: Default::default(),
        };
        assert_eq!(
            put(&server, capture).unwrap_err().code,
            "upload_interrupted"
        );
    }

    #[test]
    fn definite_rejections_map_to_their_codes() {
        let rejected = |job_code: &str| {
            format!(
                r#"{{"error":{{"type":"upload_error","code":"upload_rejected","message":"x","status":"failed","job_error":{{"type":"audio_error","code":"{job_code}","message":"y"}}}}}}"#
            )
        };
        let cases: [(&str, String, &str); 8] = [
            (
                "422 Unprocessable Entity",
                rejected("invalid_audio"),
                "invalid_audio",
            ),
            (
                "422 Unprocessable Entity",
                rejected("upload_integrity_failed"),
                "upload_integrity_failed",
            ),
            (
                "422 Unprocessable Entity",
                rejected("something_new"),
                "upstream_bad_response",
            ),
            (
                "410 Gone",
                r#"{"error":{"code":"upload_capability_expired"}}"#.into(),
                "upload_capability_expired",
            ),
            (
                "400 Bad Request",
                r#"{"error":{"code":"upload_length_mismatch"}}"#.into(),
                "upload_interrupted",
            ),
            (
                "408 Request Timeout",
                r#"{"error":{"code":"upload_interrupted"}}"#.into(),
                "upload_interrupted",
            ),
            (
                "409 Conflict",
                r#"{"error":{"code":"upload_in_progress"}}"#.into(),
                "upload_outcome_unknown",
            ),
            (
                "429 Too Many Requests",
                r#"{"error":{"code":"service_busy","retry_after_seconds":30}}"#.into(),
                "service_busy",
            ),
        ];
        for (status, body, code) in cases {
            let (_d, capture) = capture_of(b"abc");
            let server = Server::start(vec![json(status, &body)]);
            assert_eq!(
                put(&server, capture).unwrap_err().code,
                code,
                "{status} {body}"
            );
        }
    }
}
