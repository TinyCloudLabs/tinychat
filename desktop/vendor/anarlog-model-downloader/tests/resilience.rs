//! Vendored (TC-771): retry, resume and host fallback, against a small local
//! HTTP/1.1 server that can cut a response mid-body, stall, or answer with an
//! error status, per request.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use model_downloader::{
    DownloadStatus, DownloadableModel, Error, ModelDownloadManager, ModelDownloaderRuntime,
    RetryPolicy,
};

// --- local HTTP server ---

#[derive(Clone, Debug)]
struct Request {
    method: String,
    /// Start offset of a `Range: bytes=<start>-...` header.
    range_start: Option<u64>,
    /// 1-based count of requests with this method, including this one.
    nth: usize,
}

enum Reply {
    Serve,
    /// 200 with the whole file, ignoring any Range header.
    Full,
    Status(u16),
    /// Headers for the full response, then only this many body bytes.
    Cut(u64),
    /// Headers, then nothing.
    Stall,
    Delayed(Duration, Box<Reply>),
}

type Behavior = dyn Fn(&Request) -> Reply + Send + Sync;

struct TestServer {
    url: String,
    log: Arc<Mutex<Vec<Request>>>,
}

impl TestServer {
    async fn start(body: Arc<Vec<u8>>, ranges: bool, behavior: Arc<Behavior>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let heads = Arc::new(AtomicUsize::new(0));
        let gets = Arc::new(AtomicUsize::new(0));

        let server_log = log.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (body, behavior, log, heads, gets) = (
                    body.clone(),
                    behavior.clone(),
                    server_log.clone(),
                    heads.clone(),
                    gets.clone(),
                );
                tokio::spawn(async move {
                    let _ = handle(stream, body, ranges, behavior, log, heads, gets).await;
                });
            }
        });

        Self { url, log }
    }

    fn requests(&self, method: &str) -> Vec<Request> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == method)
            .cloned()
            .collect()
    }
}

async fn handle(
    mut stream: TcpStream,
    body: Arc<Vec<u8>>,
    ranges: bool,
    behavior: Arc<Behavior>,
    log: Arc<Mutex<Vec<Request>>>,
    heads: Arc<AtomicUsize>,
    gets: Arc<AtomicUsize>,
) -> std::io::Result<()> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 1024];
    while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        raw.extend_from_slice(&buf[..n]);
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let method = text.split_whitespace().next().unwrap_or("").to_string();
    let range = text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.eq_ignore_ascii_case("range") {
            return None;
        }
        let spec = value.trim().strip_prefix("bytes=")?;
        let (start, end) = spec.split_once('-')?;
        Some((start.parse::<u64>().ok()?, end.parse::<u64>().ok()))
    });
    let counter = if method == "HEAD" { &heads } else { &gets };
    let request = Request {
        method: method.clone(),
        range_start: range.map(|(start, _)| start),
        nth: counter.fetch_add(1, Ordering::SeqCst) + 1,
    };
    log.lock().unwrap().push(request.clone());

    let mut reply = behavior(&request);
    while let Reply::Delayed(delay, inner) = reply {
        tokio::time::sleep(delay).await;
        reply = *inner;
    }
    if let Reply::Status(code) = reply {
        let head =
            format!("HTTP/1.1 {code} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return stream.write_all(head.as_bytes()).await;
    }

    let total = body.len() as u64;
    let accept_ranges = if ranges {
        "Accept-Ranges: bytes\r\n"
    } else {
        ""
    };
    if method == "HEAD" {
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\n{accept_ranges}Connection: close\r\n\r\n"
        );
        return stream.write_all(head.as_bytes()).await;
    }

    let range = if matches!(reply, Reply::Full) {
        None
    } else {
        range
    };
    let (status, start, end) = match range {
        Some((start, end)) => {
            let end = end.unwrap_or(total - 1).min(total - 1);
            ("206 Partial Content", start, end)
        }
        None => ("200 OK", 0, total - 1),
    };
    let slice = &body[start as usize..=end as usize];
    let content_range = if range.is_some() {
        format!("Content-Range: bytes {start}-{end}/{total}\r\n")
    } else {
        String::new()
    };
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{content_range}{accept_ranges}Connection: close\r\n\r\n",
        slice.len()
    );
    stream.write_all(head.as_bytes()).await?;

    match reply {
        Reply::Cut(after) => {
            let after = (after as usize).min(slice.len());
            stream.write_all(&slice[..after]).await?;
            stream.flush().await?;
            // Dropping the stream closes it short of Content-Length.
            Ok(())
        }
        Reply::Stall => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            Ok(())
        }
        _ => stream.write_all(slice).await,
    }
}

// --- fixtures ---

struct TestRuntime {
    temp_dir: tempfile::TempDir,
    statuses: Mutex<Vec<DownloadStatus>>,
}

impl TestRuntime {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            temp_dir: tempfile::TempDir::new().unwrap(),
            statuses: Mutex::new(Vec::new()),
        })
    }

    fn statuses(&self) -> Vec<DownloadStatus> {
        self.statuses.lock().unwrap().clone()
    }

    fn failures(&self) -> Vec<String> {
        self.statuses()
            .into_iter()
            .filter_map(|s| match s {
                DownloadStatus::Failed(reason) => Some(reason),
                _ => None,
            })
            .collect()
    }
}

impl ModelDownloaderRuntime<TestModel> for TestRuntime {
    fn models_base(&self) -> Result<PathBuf, Error> {
        Ok(self.temp_dir.path().to_path_buf())
    }

    fn emit_progress(&self, _model: &TestModel, status: DownloadStatus) {
        self.statuses.lock().unwrap().push(status);
    }
}

#[derive(Clone)]
struct TestModel {
    url: String,
    fallbacks: Vec<String>,
    checksum: Option<u32>,
}

impl DownloadableModel for TestModel {
    fn download_key(&self) -> String {
        "model".to_string()
    }

    fn download_url(&self) -> Option<String> {
        Some(self.url.clone())
    }

    fn download_fallback_urls(&self) -> Vec<String> {
        self.fallbacks.clone()
    }

    fn download_checksum(&self) -> Option<u32> {
        self.checksum
    }

    fn download_destination(&self, models_base: &Path) -> PathBuf {
        models_base.join("model.bin")
    }

    fn is_downloaded(&self, models_base: &Path) -> Result<bool, Error> {
        Ok(self.download_destination(models_base).exists())
    }

    fn finalize_download(&self, _downloaded_path: &Path, _models_base: &Path) -> Result<(), Error> {
        Ok(())
    }

    fn delete_downloaded(&self, models_base: &Path) -> Result<(), Error> {
        std::fs::remove_file(self.download_destination(models_base)).map_err(Error::Io)
    }
}

const MIB: u64 = 1024 * 1024;

/// Larger than the `file` crate's 8 MiB threshold, so it downloads in
/// parallel ranged chunks (when the server advertises ranges).
fn test_body() -> Arc<Vec<u8>> {
    let mut state: u32 = 0x1234_5678;
    let body = (0..20 * MIB)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        })
        .collect();
    Arc::new(body)
}

fn checksum_of(body: &[u8]) -> u32 {
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), body).unwrap();
    anlg_file::calculate_file_checksum(file.path()).unwrap()
}

fn fast_policy() -> RetryPolicy {
    RetryPolicy {
        initial_backoff: Duration::from_millis(10),
        max_backoff: Duration::from_millis(40),
        stall_timeout: Duration::from_secs(5),
        ..RetryPolicy::default()
    }
}

fn manager(runtime: &Arc<TestRuntime>, policy: RetryPolicy) -> ModelDownloadManager<TestModel> {
    ModelDownloadManager::new(runtime.clone()).with_retry_policy(policy)
}

async fn wait_until_done(manager: &ModelDownloadManager<TestModel>, model: &TestModel) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while manager.is_downloading(model).await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("download did not finish within 30 s");
}

fn partial_path(runtime: &TestRuntime) -> PathBuf {
    runtime.temp_dir.path().join("model.bin.part")
}

fn installed(runtime: &TestRuntime) -> Option<Vec<u8>> {
    std::fs::read(runtime.temp_dir.path().join("model.bin")).ok()
}

// --- tests ---

#[tokio::test]
async fn a_cut_chunk_is_retried_from_where_it_stopped() {
    let body = test_body();
    // The first three ranged GETs are cut 100 000 bytes in.
    let server = TestServer::start(
        body.clone(),
        true,
        Arc::new(|r: &Request| {
            if r.method == "GET" && r.nth <= 3 {
                Reply::Cut(100_000)
            } else {
                Reply::Serve
            }
        }),
    )
    .await;

    let runtime = TestRuntime::new();
    let manager = manager(&runtime, fast_policy());
    let model = TestModel {
        url: server.url.clone(),
        fallbacks: vec![],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(installed(&runtime).as_deref(), Some(body.as_slice()));
    assert!(runtime.statuses().contains(&DownloadStatus::Completed));
    assert!(runtime.failures().is_empty(), "{:?}", runtime.failures());
    assert_eq!(
        server.requests("HEAD").len(),
        1,
        "retried within the attempt"
    );
    let gets = server.requests("GET");
    let first_three: Vec<u64> = gets[..3].iter().map(|r| r.range_start.unwrap()).collect();
    for start in first_three {
        assert!(
            gets.iter().any(|r| r.range_start == Some(start + 100_000)),
            "the chunk at {start} resumes at {}: {gets:?}",
            start + 100_000
        );
    }
}

#[tokio::test]
async fn a_full_200_answer_to_a_range_request_is_retried() {
    // Cloudflare in front of models.anarlog.so answers the first range request
    // after a HEAD on a connection with 200 and the whole file.
    let body = test_body();
    let server = TestServer::start(
        body.clone(),
        true,
        Arc::new(|r: &Request| {
            if r.method == "GET" && r.nth == 1 {
                Reply::Full
            } else {
                Reply::Serve
            }
        }),
    )
    .await;

    let runtime = TestRuntime::new();
    let manager = manager(&runtime, fast_policy());
    let model = TestModel {
        url: server.url.clone(),
        fallbacks: vec![],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(installed(&runtime).as_deref(), Some(body.as_slice()));
    assert_eq!(server.requests("HEAD").len(), 1);
}

#[tokio::test]
async fn a_failed_attempt_is_retried_with_backoff_and_completes() {
    let body = test_body();
    let server = TestServer::start(
        body.clone(),
        true,
        Arc::new(|r: &Request| {
            if r.method == "HEAD" && r.nth <= 2 {
                Reply::Status(503)
            } else {
                Reply::Serve
            }
        }),
    )
    .await;

    let runtime = TestRuntime::new();
    let manager = manager(&runtime, fast_policy());
    let model = TestModel {
        url: server.url.clone(),
        fallbacks: vec![],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(installed(&runtime).as_deref(), Some(body.as_slice()));
    assert_eq!(server.requests("HEAD").len(), 3);
    let zero_progress = runtime
        .statuses()
        .iter()
        .filter(|s| **s == DownloadStatus::Downloading(0))
        .count();
    assert!(zero_progress <= 1, "retries must not reset progress to 0");
}

#[tokio::test]
async fn a_stalled_response_is_abandoned_and_retried() {
    let body = test_body();
    let server = TestServer::start(
        body.clone(),
        false,
        Arc::new(|r: &Request| {
            if r.method == "GET" && r.nth == 1 {
                Reply::Stall
            } else {
                Reply::Serve
            }
        }),
    )
    .await;

    let runtime = TestRuntime::new();
    let manager = manager(
        &runtime,
        RetryPolicy {
            stall_timeout: Duration::from_millis(300),
            ..fast_policy()
        },
    );
    let model = TestModel {
        url: server.url.clone(),
        fallbacks: vec![],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(installed(&runtime).as_deref(), Some(body.as_slice()));
    assert_eq!(server.requests("GET").len(), 2);
}

#[tokio::test]
async fn a_failed_download_keeps_its_partial_file_and_the_next_attempt_resumes() {
    let body = test_body();
    let healthy = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let server_healthy = healthy.clone();
    // No Accept-Ranges: the `file` crate streams one GET and resumes with
    // `Range: bytes=<partial size>-`, so the resume offset is exact.
    let server = TestServer::start(
        body.clone(),
        false,
        Arc::new(move |r: &Request| {
            if r.method == "GET" && !server_healthy.load(Ordering::SeqCst) {
                if r.range_start.is_none() {
                    Reply::Cut(5 * MIB)
                } else {
                    Reply::Status(503)
                }
            } else {
                Reply::Serve
            }
        }),
    )
    .await;

    let runtime = TestRuntime::new();
    let manager = manager(
        &runtime,
        RetryPolicy {
            max_attempts_per_host: 3,
            ..fast_policy()
        },
    );
    let model = TestModel {
        url: server.url.clone(),
        fallbacks: vec![],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(runtime.failures().len(), 1, "{:?}", runtime.statuses());
    assert!(installed(&runtime).is_none());
    let partial = std::fs::metadata(partial_path(&runtime)).unwrap().len();
    assert!(partial >= MIB, "partial file kept: {partial} bytes");
    assert_eq!(
        std::fs::read(partial_path(&runtime)).unwrap(),
        body[..partial as usize],
        "the partial file is a prefix of the model"
    );

    healthy.store(true, Ordering::SeqCst);
    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(installed(&runtime).as_deref(), Some(body.as_slice()));
    assert!(!partial_path(&runtime).exists());
    let last_get = server.requests("GET").last().cloned().unwrap();
    assert_eq!(
        last_get.range_start,
        Some(partial),
        "the second attempt resumes"
    );
}

#[tokio::test]
async fn a_forbidden_primary_falls_back_without_retrying_it() {
    let body = test_body();
    let primary = TestServer::start(
        body.clone(),
        true,
        Arc::new(|_: &Request| Reply::Status(403)),
    )
    .await;
    let fallback =
        TestServer::start(body.clone(), true, Arc::new(|_: &Request| Reply::Serve)).await;

    let runtime = TestRuntime::new();
    let manager = manager(&runtime, fast_policy());
    let model = TestModel {
        url: primary.url.clone(),
        fallbacks: vec![fallback.url.clone()],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(installed(&runtime).as_deref(), Some(body.as_slice()));
    assert_eq!(primary.requests("HEAD").len(), 1, "a 403 is not retried");
    assert!(primary.requests("GET").is_empty());
    assert!(!fallback.requests("GET").is_empty());
}

#[tokio::test]
async fn a_download_resumes_across_hosts() {
    let body = test_body();
    let primary = TestServer::start(
        body.clone(),
        false,
        Arc::new(|r: &Request| match (r.method.as_str(), r.nth) {
            ("GET", 1) => Reply::Cut(7 * MIB),
            ("GET", _) => Reply::Status(502),
            _ => Reply::Serve,
        }),
    )
    .await;
    let fallback =
        TestServer::start(body.clone(), false, Arc::new(|_: &Request| Reply::Serve)).await;

    let runtime = TestRuntime::new();
    let manager = manager(
        &runtime,
        RetryPolicy {
            max_attempts_per_host: 2,
            ..fast_policy()
        },
    );
    let model = TestModel {
        url: primary.url.clone(),
        fallbacks: vec![fallback.url.clone()],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(installed(&runtime).as_deref(), Some(body.as_slice()));
    let fallback_gets = fallback.requests("GET");
    assert_eq!(fallback_gets.len(), 1);
    assert_eq!(fallback_gets[0].range_start, Some(7 * MIB));
}

#[tokio::test]
async fn a_corrupt_partial_file_fails_the_checksum_and_is_deleted() {
    let body = test_body();
    let server = TestServer::start(body.clone(), true, Arc::new(|_: &Request| Reply::Serve)).await;

    let runtime = TestRuntime::new();
    std::fs::write(partial_path(&runtime), vec![0u8; 3 * MIB as usize]).unwrap();
    let manager = manager(&runtime, fast_policy());
    let model = TestModel {
        url: server.url.clone(),
        fallbacks: vec![],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert!(installed(&runtime).is_none());
    assert!(!partial_path(&runtime).exists());
    let failures = runtime.failures();
    assert_eq!(failures.len(), 1);
    assert!(failures[0].contains("checksum"), "{failures:?}");
}

#[tokio::test]
async fn without_a_checksum_there_is_no_fallback_and_no_kept_partial() {
    let body = test_body();
    let primary = TestServer::start(
        body.clone(),
        false,
        Arc::new(|r: &Request| match r.method.as_str() {
            "GET" if r.range_start.is_none() => Reply::Cut(5 * MIB),
            "GET" => Reply::Status(404),
            _ => Reply::Serve,
        }),
    )
    .await;
    let fallback =
        TestServer::start(body.clone(), false, Arc::new(|_: &Request| Reply::Serve)).await;

    let runtime = TestRuntime::new();
    let manager = manager(&runtime, fast_policy());
    let model = TestModel {
        url: primary.url.clone(),
        fallbacks: vec![fallback.url.clone()],
        checksum: None,
    };

    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(runtime.failures().len(), 1);
    assert!(fallback.log.lock().unwrap().is_empty());
    assert!(!partial_path(&runtime).exists());
}

#[tokio::test]
async fn downloading_again_while_running_joins_the_running_download() {
    let body = test_body();
    let server = TestServer::start(
        body.clone(),
        false,
        Arc::new(|r: &Request| {
            if r.method == "GET" {
                Reply::Delayed(Duration::from_millis(300), Box::new(Reply::Serve))
            } else {
                Reply::Serve
            }
        }),
    )
    .await;

    let runtime = TestRuntime::new();
    let manager = manager(&runtime, fast_policy());
    let model = TestModel {
        url: server.url.clone(),
        fallbacks: vec![],
        checksum: Some(checksum_of(&body)),
    };

    manager.download(&model).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    manager.download(&model).await.unwrap();
    wait_until_done(&manager, &model).await;

    assert_eq!(installed(&runtime).as_deref(), Some(body.as_slice()));
    assert_eq!(server.requests("GET").len(), 1, "not restarted");
    assert!(runtime.failures().is_empty(), "{:?}", runtime.failures());
}
