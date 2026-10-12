//! PTX uploads read a sealed note through one descriptor. No file path or
//! destination supplied by the webview is trusted.
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::stream;
use reqwest::{redirect, Client, Url};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;

use crate::recorder;

const CHUNK: usize = 256 * 1024;
const IDLE: Duration = Duration::from_secs(60);
const RESPONSE: Duration = Duration::from_secs(180);
const MAX_UPLOAD: Duration = Duration::from_secs(55 * 60);
static UPLOADS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn uploads() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    UPLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sealed_audio(root: &std::path::Path, id: &str) -> Result<File, String> {
    recorder::files::open_sealed(root, id).map_err(|error| {
        if error == "audio_not_ready" {
            error
        } else if error.contains("os error 2") {
            "not_found".into()
        } else {
            "audio_read_failed".into()
        }
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    upload_id: &'a str,
    loaded: u64,
    total: u64,
}

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    status: u16,
    body: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    size: u64,
    mime_type: &'static str,
    sha256: String,
}

#[tauri::command]
pub async fn ptx_audio_metadata(
    app: tauri::AppHandle,
    id: String,
) -> Result<AudioMetadata, String> {
    tokio::task::spawn_blocking(move || audio_metadata(&app, &id))
        .await
        .map_err(|_| "audio_read_failed".to_string())?
}

fn audio_metadata(app: &tauri::AppHandle, id: &str) -> Result<AudioMetadata, String> {
    recorder::ensure(app);
    let root = recorder::files::root(app).map_err(|_| "audio_read_failed")?;
    let mut file = sealed_audio(&root, id)?;
    let size = file.metadata().map_err(|_| "audio_read_failed")?.len();
    if size == 0 {
        return Err("audio_not_ready".into());
    }
    let mut hasher = Sha256::new();
    let mut chunk = [0_u8; CHUNK];
    loop {
        let count = file.read(&mut chunk).map_err(|_| "audio_read_failed")?;
        if count == 0 {
            break;
        }
        hasher.update(&chunk[..count]);
    }
    Ok(AudioMetadata {
        size,
        mime_type: "audio/mpeg",
        sha256: hex::encode(hasher.finalize()),
    })
}

fn origin() -> Result<Url, String> {
    let raw = env!("EXO_PTX_UPLOAD_ORIGIN");
    let url = Url::parse(raw).map_err(|_| "origin_not_configured")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || raw.trim_end_matches('/') != url.origin().ascii_serialization()
    {
        return Err("origin_not_configured".into());
    }
    Ok(url)
}

fn upload_url(origin: &Url, supplied: &str) -> Result<Url, String> {
    let url = Url::parse(supplied).map_err(|_| "invalid_upload_url")?;
    let id = url
        .path()
        .strip_prefix("/uploads/trn_")
        .ok_or("invalid_upload_url")?;
    if id.len() != 26 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z'))
        || url.origin() != origin.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some() {
        return Err("invalid_upload_url".into());
    }
    Ok(url)
}

async fn send_file(
    file: File,
    url: Url,
    capability: String,
    content_type: String,
    length: u64,
    correlation_id: String,
    cancelled: Arc<AtomicBool>,
    progress: impl Fn(u64) + Send + Sync + 'static,
) -> Result<UploadResponse, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("upload_cancelled".into());
    }
    if !capability.starts_with("tcu_")
        || !capability
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || capability.len() < 20
        || capability.len() > 260
    {
        return Err("invalid_capability".into());
    }
    let client = Client::builder()
        .redirect(redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "upload_client_failed")?;
    let sent = Arc::new(AtomicU64::new(0));
    let sent_stream = sent.clone();
    let cancelled_stream = cancelled.clone();
    let progress = Arc::new(progress);
    let chunks = stream::unfold((file, 0_u64), move |(mut file, offset)| {
        let cancelled = cancelled_stream.clone();
        let sent = sent_stream.clone();
        let progress = progress.clone();
        async move {
            if offset == length {
                return None;
            }
            if cancelled.load(Ordering::SeqCst) {
                return Some((
                    Err(std::io::Error::other("upload_cancelled")),
                    (file, length),
                ));
            }
            let mut bytes = vec![0; CHUNK.min((length - offset) as usize)];
            let result = file.read_exact(&mut bytes).map(|()| bytes);
            match result {
                Ok(bytes) => {
                    let next = offset + bytes.len() as u64;
                    sent.store(next, Ordering::SeqCst);
                    progress(next);
                    Some((Ok(bytes), (file, next)))
                }
                Err(error) => Some((Err(error), (file, length))),
            }
        }
    });
    let request = client
        .put(url)
        .header("Authorization", format!("Bearer {capability}"))
        .header("Content-Type", content_type)
        .header("Content-Length", length)
        .header("X-Correlation-Id", correlation_id)
        .body(reqwest::Body::wrap_stream(chunks));
    let started = Instant::now();
    let mut last_bytes = 0;
    let mut last_progress = Instant::now();
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    let mut response = Box::pin(request.send());
    let answer = loop {
        tokio::select! {
            result = &mut response => break result.map_err(|_| "upload_outcome_unknown".to_string())?,
            _ = ticker.tick() => {
                if cancelled.load(Ordering::SeqCst) { return Err("upload_cancelled".into()); }
                let current = sent.load(Ordering::SeqCst);
                if current != last_bytes { last_bytes = current; last_progress = Instant::now(); }
                let idle_limit = if current == length { RESPONSE } else { IDLE };
                if last_progress.elapsed() > idle_limit || started.elapsed() > MAX_UPLOAD {
                    return Err("upload_idle_timeout".into());
                }
            }
        }
    };
    let status = answer.status().as_u16();
    let body = tokio::time::timeout(RESPONSE, answer.bytes())
        .await
        .map_err(|_| "upload_idle_timeout")?
        .map_err(|_| "upload_outcome_unknown")?;
    if body.len() > 64 * 1024 {
        return Err("upload_response_too_large".into());
    }
    let body = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    Ok(UploadResponse { status, body })
}

#[tauri::command]
pub async fn ptx_upload_audio(
    app: tauri::AppHandle,
    id: String,
    upload_id: String,
    url: String,
    capability: String,
    content_type: String,
    content_length: u64,
    correlation_id: String,
) -> Result<UploadResponse, String> {
    recorder::ensure(&app);
    let origin = origin()?;
    let url = upload_url(&origin, &url)?;
    let root = recorder::files::root(&app).map_err(|_| "audio_read_failed")?;
    let file = sealed_audio(&root, &id)?;
    let length = file.metadata().map_err(|_| "audio_read_failed")?.len();
    if length == 0 || length != content_length {
        return Err("audio_size_mismatch".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = uploads().lock().map_err(|_| "upload_registry_failed")?;
        if let Some(existing) = active.get(&upload_id) {
            if existing.load(Ordering::SeqCst) {
                active.remove(&upload_id);
                return Err("upload_cancelled".into());
            }
            return Err("upload_already_active".into());
        }
        active.insert(upload_id.clone(), cancelled.clone());
    }
    let last_event = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
    let event_id = upload_id.clone();
    let result = send_file(
        file,
        url,
        capability,
        content_type,
        length,
        correlation_id,
        cancelled,
        move |loaded| {
            if let Ok(mut last) = last_event.lock() {
                if last.elapsed() >= Duration::from_millis(250) {
                    *last = Instant::now();
                    let _ = app.emit(
                        "audioUploadProgress",
                        Progress {
                            upload_id: &event_id,
                            loaded,
                            total: length,
                        },
                    );
                }
            }
        },
    )
    .await;
    uploads()
        .lock()
        .map_err(|_| "upload_registry_failed")?
        .remove(&upload_id);
    result
}

#[tauri::command]
pub fn ptx_cancel_audio_upload(upload_id: String) -> Result<(), String> {
    let mut active = uploads().lock().map_err(|_| "upload_registry_failed")?;
    active
        .entry(upload_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(true)))
        .store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    #[test]
    fn missing_sealed_audio_has_a_stable_code() {
        let root = tempfile::tempdir().unwrap();
        let id = "01234567-89ab-cdef-0123-456789abcdef";
        std::fs::write(root.path().join(format!("{id}.sealed")), []).unwrap();
        assert_eq!(sealed_audio(root.path(), id).unwrap_err(), "not_found");
    }

    #[tokio::test]
    async fn local_server_receives_exact_file_and_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap();
            assert!(header.starts_with("PUT /uploads/trn_"));
            assert!(header
                .to_ascii_lowercase()
                .contains("content-length: 6\r\n"));
            assert!(header
                .to_ascii_lowercase()
                .contains("authorization: bearer tcu_abcdefghijklmnop"));
            let mut body = [0; 6];
            stream.read_exact(&mut body).unwrap();
            assert_eq!(&body, b"abcdef");
            stream
                .write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
        });
        let mut temp = tempfile::tempfile().unwrap();
        temp.write_all(b"abcdef").unwrap();
        let mut file = temp.try_clone().unwrap();
        use std::io::Seek;
        file.rewind().unwrap();
        let progress = Arc::new(AtomicU64::new(0));
        let observed = progress.clone();
        let response = send_file(
            file,
            Url::parse(&format!(
                "http://{address}/uploads/trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
            ))
            .unwrap(),
            "tcu_abcdefghijklmnop".into(),
            "audio/mpeg".into(),
            6,
            "put-1".into(),
            Arc::new(AtomicBool::new(false)),
            move |n| {
                observed.store(n, Ordering::SeqCst);
            },
        )
        .await
        .unwrap();
        assert_eq!(response.status, 201);
        assert_eq!(progress.load(Ordering::SeqCst), 6);
        server.join().unwrap();
    }

    #[test]
    fn refuses_an_upload_path_outside_the_compiled_origin() {
        let origin = Url::parse("https://ptx.example").unwrap();
        assert!(upload_url(
            &origin,
            "https://elsewhere.example/uploads/trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
        )
        .is_err());
        assert!(upload_url(
            &origin,
            "https://ptx.example/uploads/trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3?x=1"
        )
        .is_err());
    }

    #[tokio::test]
    async fn cancelled_upload_never_opens_a_connection() {
        let file = tempfile::tempfile().unwrap();
        let error = send_file(
            file,
            Url::parse("https://ptx.example/uploads/trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3").unwrap(),
            "tcu_abcdefghijklmnop".into(),
            "audio/mpeg".into(),
            1,
            "put-2".into(),
            Arc::new(AtomicBool::new(true)),
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error, "upload_cancelled");
    }

    #[tokio::test]
    async fn redirects_are_returned_to_the_caller_without_following() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut received = Vec::new();
            while !received.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                received.push(byte[0]);
            }
            let mut body = [0];
            stream.read_exact(&mut body).unwrap();
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/\r\nContent-Length: 0\r\n\r\n").unwrap();
        });
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"a").unwrap();
        use std::io::Seek;
        file.rewind().unwrap();
        let answer = send_file(
            file,
            Url::parse(&format!(
                "http://{address}/uploads/trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
            ))
            .unwrap(),
            "tcu_abcdefghijklmnop".into(),
            "audio/mpeg".into(),
            1,
            "put-3".into(),
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(answer.status, 302);
        server.join().unwrap();
    }
}
