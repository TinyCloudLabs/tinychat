use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use anlg_audio_chunking::{AudioChunk, SpeechChunker, SpeechChunkingConfig};
use anlg_model_manager::ModelManager;
use anlg_transcribe_core::{
    BatchEventSender, ProgressTracker, batch_event_channel, batch_sse_response,
    json_error_response, overall_resolved_audio, record_progress,
};
use axum::{
    Json,
    body::Body,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use owhisper_interface::ListenParams;
use owhisper_interface::batch;
use owhisper_interface::batch_sse::BatchSseMessage;
use owhisper_interface::{InferencePhase, InferenceProgress};
use rodio::Source;
use tokio::io::AsyncWriteExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::response::{TranscriptKind, build_batch_words, build_transcript_response};
use super::{TARGET_SAMPLE_RATE, build_metadata, build_model, transcribe_chunk_with_progress};

// Exo patch: supported limits for on-device batch transcription (upstream: a
// 100 MiB upload cap, 8 channels, no bound on decoded size).
//
// The server decodes every channel into a 32-bit float, 16 kHz WAV temp file
// before transcribing, so the decoded size, not the upload, is what fills the
// disk: 8 h is 1.84 GB per channel (WAV's hard limit is 4 GiB).
/// Longest recording accepted, in seconds (8 hours).
const MAX_BATCH_DURATION_SECS: usize = 8 * 60 * 60;
const MAX_BATCH_FRAMES: usize = MAX_BATCH_DURATION_SECS * TARGET_SAMPLE_RATE as usize;
/// Exo records mic + system audio as one stereo file.
const MAX_BATCH_CHANNELS: usize = 2;
/// 8 hours of Exo's 128 kbps MP3 (16,000 B/s), plus 5% for container overhead.
const MAX_BATCH_AUDIO_BODY_BYTES: usize = MAX_BATCH_DURATION_SECS * 16_000 / 20 * 21;
/// Free space left on the temp volume after the decoded channel files.
const DECODE_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
const DECODED_BYTES_PER_FRAME_PER_CHANNEL: u64 = 4;
const WAV_HEADER_BYTES: u64 = 44;

const MAX_CONCURRENT_HTTP_BATCH_JOBS: usize = 1;
const MAX_REJECTED_BATCH_DRAIN_BYTES: usize = 64 * 1024;
const MAX_REJECTED_BATCH_DRAIN_CHUNKS: usize = 64;
const REJECTED_BATCH_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);
const CHANNEL_WINDOW_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 2 * 60;
// Exo patch: buffer the upload spool; unbuffered, every received body chunk was
// its own blocking-pool file write.
const SPOOL_WRITE_BUFFER_BYTES: usize = 4 * 1024 * 1024;
// Exo patch: the SSE clients treat a quiet stream as a stall (30 s in
// listener2-core, 60 s in tauri-plugin-transcription). Every long-running unit
// of work (receiving the upload, decoding it, scanning for speech, running
// Whisper on a chunk) reports that it advanced, at most this often. Reports
// come only from inside that work, never from a timer, so a stalled server
// still goes quiet and still times out. 5 s keeps a 6x margin under the 30 s
// bound without flooding the client, which acknowledges every event through
// an actor round trip with its own 1 s deadline.
const WORK_PROGRESS_MIN_INTERVAL: Duration = Duration::from_secs(5);
// Same values as `anlg_transcribe_core::chunk_channel_audio`
// (crates/transcribe-core/src/audio.rs @ 864ddc1).
const SPEECH_REDEMPTION_TIME: Duration = Duration::from_millis(150);
const MAX_CHUNK_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 25;

#[derive(Clone, Default)]
struct BatchCancellation {
    cancelled: Arc<AtomicBool>,
}

impl BatchCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

struct CancelBatchOnDrop(BatchCancellation);

impl Drop for CancelBatchOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub(super) fn http_batch_admission() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(MAX_CONCURRENT_HTTP_BATCH_JOBS))
}

pub(super) fn try_acquire_http_batch_permit(
    admission: Arc<Semaphore>,
) -> Option<OwnedSemaphorePermit> {
    admission.try_acquire_owned().ok()
}

pub(super) fn batch_busy_response() -> Response {
    json_error_response(
        StatusCode::TOO_MANY_REQUESTS,
        "batch_busy",
        "another local batch transcription is already running",
    )
}

fn spawn_batch_job<T>(
    permit: OwnedSemaphorePermit,
    job: impl FnOnce() -> T + Send + 'static,
) -> tokio::task::JoinHandle<T>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        job()
    })
}

/// Exo patch: reports work that does not move the resolved-audio position, so
/// the SSE stream never goes quiet while the server is busy. Callers invoke
/// [`WorkActivity::worked`] only after finishing a piece of work (bytes
/// received, a decoded block, a scanned VAD frame, a decoded Whisper token).
struct WorkActivity {
    tx: Option<BatchEventSender>,
    min_interval: Duration,
    last_sent: Instant,
}

impl WorkActivity {
    fn new(tx: Option<BatchEventSender>) -> Self {
        Self::with_min_interval(tx, WORK_PROGRESS_MIN_INTERVAL)
    }

    fn with_min_interval(tx: Option<BatchEventSender>, min_interval: Duration) -> Self {
        Self {
            tx,
            min_interval,
            last_sent: Instant::now(),
        }
    }

    fn worked(&mut self, percentage: f64, phase: InferencePhase) {
        let Some(tx) = &self.tx else {
            return;
        };
        if self.last_sent.elapsed() < self.min_interval {
            return;
        }
        self.last_sent = Instant::now();
        tx.send_progress(BatchSseMessage::Progress {
            progress: InferenceProgress {
                percentage,
                partial_text: None,
                phase,
            },
        });
    }

    fn event_sent(&mut self) {
        self.last_sent = Instant::now();
    }
}

#[derive(Debug)]
pub(super) struct BatchAudioFile {
    file: tempfile::NamedTempFile,
    len: u64,
}

impl BatchAudioFile {
    fn path(&self) -> &Path {
        self.file.path()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.len == 0
    }
}

#[derive(Debug)]
enum BatchAudioWriteError {
    Body(axum::Error),
    Io(std::io::Error),
    TooLarge,
}

impl From<std::io::Error> for BatchAudioWriteError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl BatchAudioWriteError {
    fn into_parts(self) -> (StatusCode, &'static str, String) {
        match self {
            // "file too large" is also what the listener2 client maps to its
            // "recording is too large" message.
            Self::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                recording_too_long_message(),
            ),
            Self::Body(error) => (
                StatusCode::BAD_REQUEST,
                "invalid_request_body",
                error.to_string(),
            ),
            Self::Io(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed_to_store_audio",
                error.to_string(),
            ),
        }
    }
}

pub(super) async fn spool_batch_audio(
    body: Body,
    content_type: &str,
) -> Result<BatchAudioFile, Response> {
    spool_batch_audio_with_limit(body, content_type, MAX_BATCH_AUDIO_BODY_BYTES, |_| {})
        .await
        .map_err(|error| {
            let (status, code, detail) = error.into_parts();
            json_error_response(status, code, detail)
        })
}

pub(super) async fn drain_rejected_batch_audio(body: Body) -> Result<(), Response> {
    let drain = async move {
        let mut stream = body.into_data_stream();
        let mut drained = 0usize;

        for _ in 0..MAX_REJECTED_BATCH_DRAIN_CHUNKS {
            if drained >= MAX_REJECTED_BATCH_DRAIN_BYTES {
                break;
            }

            let Some(chunk) = stream.next().await else {
                break;
            };
            let chunk = chunk.map_err(|error| {
                json_error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_request_body",
                    error.to_string(),
                )
            })?;
            drained = drained.saturating_add(chunk.len());
        }

        Ok(())
    };

    match tokio::time::timeout(REJECTED_BATCH_DRAIN_TIMEOUT, drain).await {
        Ok(result) => result,
        Err(_) => Ok(()),
    }
}

async fn spool_batch_audio_with_limit(
    body: Body,
    content_type: &str,
    max_bytes: usize,
    mut on_received: impl FnMut(u64),
) -> Result<BatchAudioFile, BatchAudioWriteError> {
    let extension = anlg_audio_utils::content_type_to_extension(content_type);
    let file = tempfile::Builder::new()
        .prefix("whisper_local_batch_")
        .suffix(&format!(".{extension}"))
        .tempfile()?;
    let mut writer = tokio::io::BufWriter::with_capacity(
        SPOOL_WRITE_BUFFER_BYTES,
        tokio::fs::File::from_std(file.reopen()?),
    );
    let mut stream = body.into_data_stream();
    let mut len = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(BatchAudioWriteError::Body)?;
        len = len.saturating_add(chunk.len() as u64);
        if len > max_bytes as u64 {
            return Err(BatchAudioWriteError::TooLarge);
        }
        writer.write_all(&chunk).await?;
        on_received(len);
    }
    writer.flush().await?;

    Ok(BatchAudioFile { file, len })
}

pub(super) async fn handle_batch(
    audio_file: BatchAudioFile,
    params: &ListenParams,
    manager: &ModelManager<anlg_whisper_local::LoadedWhisper>,
    model_path: &Path,
    permit: OwnedSemaphorePermit,
) -> Response {
    let cancellation = BatchCancellation::default();
    let _cancel_on_drop = CancelBatchOnDrop(cancellation.clone());
    let model = match manager.get(None).await {
        Ok(model) => model,
        Err(error) => {
            tracing::error!(error = %error, "failed_to_load_model");
            return json_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "model_load_failed",
                error.to_string(),
            );
        }
    };

    let model = model.clone();
    let model_path = model_path.to_path_buf();
    let params = params.clone();

    match spawn_batch_job(permit, move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            transcribe_batch(
                audio_file.path(),
                &params,
                model.as_ref(),
                &model_path,
                None,
                &cancellation,
            )
        }))
    })
    .await
    {
        Ok(Ok(Ok(response))) => Json(response).into_response(),
        Ok(Ok(Err(error))) => {
            tracing::error!(error = %error, "batch_transcription_failed");
            json_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "transcription_failed",
                error.to_string(),
            )
        }
        Ok(Err(_)) | Err(_) => json_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "transcription_failed",
            "task panicked",
        ),
    }
}

/// Exo patch: the event stream opens as soon as the request arrives and the
/// upload is spooled behind it, so receiving a long recording reports progress
/// too (upstream spooled the whole body before responding, and a slow upload
/// could exhaust the client's idle timeout before the first event). Failures
/// from here on are terminal SSE `error` events instead of HTTP statuses.
pub(super) fn handle_batch_sse(
    body: Body,
    content_type: String,
    params: ListenParams,
    manager: ModelManager<anlg_whisper_local::LoadedWhisper>,
    model_path: PathBuf,
    permit: OwnedSemaphorePermit,
) -> Response {
    let (event_tx, event_rx) = batch_event_channel();
    tokio::spawn(run_batch_sse(
        body,
        content_type,
        params,
        manager,
        model_path,
        permit,
        event_tx,
    ));
    batch_sse_response(event_rx)
}

async fn run_batch_sse(
    body: Body,
    content_type: String,
    params: ListenParams,
    manager: ModelManager<anlg_whisper_local::LoadedWhisper>,
    model_path: PathBuf,
    permit: OwnedSemaphorePermit,
    event_tx: BatchEventSender,
) {
    let fail = |error: &str, detail: String| {
        tracing::error!(error, detail = %detail, "batch_sse_request_failed");
        event_tx.send_terminal(BatchSseMessage::Error {
            error: error.to_string(),
            detail,
        });
    };

    let mut receiving = WorkActivity::new(Some(event_tx.clone()));
    let audio_file =
        match spool_batch_audio_with_limit(body, &content_type, MAX_BATCH_AUDIO_BODY_BYTES, |_| {
            receiving.worked(0.0, InferencePhase::Prefill)
        })
        .await
        {
            Ok(audio_file) => audio_file,
            Err(error) => {
                let (_, code, detail) = error.into_parts();
                return fail(code, detail);
            }
        };
    if audio_file.is_empty() {
        return fail("invalid_request_body", "request body is empty".to_string());
    }

    let model = match manager.get(None).await {
        Ok(model) => model.clone(),
        Err(error) => return fail("model_load_failed", error.to_string()),
    };
    let cancellation = BatchCancellation::default();

    spawn_batch_job(permit, move || {
        let message = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            transcribe_batch(
                audio_file.path(),
                &params,
                model.as_ref(),
                &model_path,
                Some(event_tx.clone()),
                &cancellation,
            )
        })) {
            Ok(Ok(response)) => BatchSseMessage::Result { response },
            Ok(Err(error)) => BatchSseMessage::Error {
                error: "transcription_failed".to_string(),
                detail: error.to_string(),
            },
            Err(_) => BatchSseMessage::Error {
                error: "transcription_failed".to_string(),
                detail: "task panicked".to_string(),
            },
        };

        event_tx.send_terminal(message);
    });
}

fn transcribe_batch(
    audio_path: &Path,
    params: &ListenParams,
    loaded_model: &anlg_whisper_local::LoadedWhisper,
    model_path: &Path,
    event_tx: Option<BatchEventSender>,
    cancellation: &BatchCancellation,
) -> Result<batch::Response, crate::Error> {
    let source = anlg_audio_utils::source_from_path(audio_path)?;
    preflight_decode(&source)?;
    transcribe_source(
        source,
        params,
        loaded_model,
        model_path,
        event_tx,
        cancellation,
    )
}

pub(super) fn transcribe_recorded_file(
    loaded_model: &anlg_whisper_local::LoadedWhisper,
    model_path: &Path,
    audio_path: &Path,
) -> Result<Vec<owhisper_interface::Word2>, crate::Error> {
    let source = anlg_audio_utils::source_from_path(audio_path)?;
    preflight_decode(&source)?;
    let cancellation = BatchCancellation::default();
    let response = transcribe_source(
        source,
        &ListenParams::default(),
        loaded_model,
        model_path,
        None,
        &cancellation,
    )?;
    let words = response
        .results
        .channels
        .into_iter()
        .flat_map(|channel| channel.alternatives.into_iter())
        .flat_map(|alt| alt.words.into_iter())
        .map(|word| owhisper_interface::Word2 {
            text: word.punctuated_word.unwrap_or(word.word),
            speaker: word
                .speaker
                .map(|speaker| owhisper_interface::SpeakerIdentity::Unassigned {
                    index: speaker as u8,
                }),
            confidence: Some(word.confidence as f32),
            start_ms: Some((word.start * 1000.0) as u64),
            end_ms: Some((word.end * 1000.0) as u64),
        })
        .collect();
    Ok(words)
}

/// Exo patch: reject a recording before decoding it when it exceeds the
/// supported limits or the decoded channel files would not fit on the temp
/// volume.
fn preflight_decode<S: Source>(source: &S) -> Result<(), crate::Error> {
    let channels = u16::from(source.channels()).max(1) as usize;
    let duration = source.total_duration();
    let temp_dir = std::env::temp_dir();
    let available = available_disk_bytes(&temp_dir)?;

    let required = plan_decode_storage(channels, duration, available)?;
    tracing::info!(
        channels,
        duration_secs = duration.map(|d| d.as_secs_f64()),
        required_bytes = required,
        available_bytes = available,
        temp_dir = %temp_dir.display(),
        "batch_decode_preflight_passed"
    );
    Ok(())
}

/// Bytes the decoded channel files need (plus the reserve), or the reason the
/// recording cannot be decoded. `duration` comes from the container and can
/// be an estimate (MP3 without a seek table), so it gets 5% headroom; an
/// unknown duration is planned at the supported maximum. Decoding itself stops
/// at [`MAX_BATCH_FRAMES`] regardless.
fn plan_decode_storage(
    channels: usize,
    duration: Option<Duration>,
    available_bytes: u64,
) -> Result<u64, crate::Error> {
    if channels > MAX_BATCH_CHANNELS {
        return Err(too_many_channels(channels));
    }
    if duration.is_some_and(|duration| duration.as_secs_f64() > MAX_BATCH_DURATION_SECS as f64) {
        return Err(recording_too_long());
    }

    let frames = duration
        .map(|duration| (duration.as_secs_f64() * TARGET_SAMPLE_RATE as f64 * 1.05).ceil() as u64)
        .unwrap_or(MAX_BATCH_FRAMES as u64)
        .min(MAX_BATCH_FRAMES as u64);
    let required = channels as u64
        * (frames * DECODED_BYTES_PER_FRAME_PER_CHANNEL + WAV_HEADER_BYTES)
        + DECODE_DISK_RESERVE_BYTES;

    if available_bytes < required {
        tracing::error!(
            required_bytes = required,
            available_bytes,
            "batch_decode_insufficient_disk_space"
        );
        return Err(crate::Error::protocol(format!(
            "not enough free disk space to decode this recording: it needs about {:.1} GB free in the temporary folder",
            required as f64 / 1e9
        )));
    }
    Ok(required)
}

#[cfg(unix)]
fn available_disk_bytes(dir: &Path) -> Result<u64, crate::Error> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(dir.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL-terminated and `stats` is a valid out-pointer.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: statvfs returned 0, so it initialized `stats`.
    let stats = unsafe { stats.assume_init() };
    Ok(stats.f_bavail as u64 * stats.f_frsize as u64)
}

#[cfg(not(unix))]
fn available_disk_bytes(_dir: &Path) -> Result<u64, crate::Error> {
    Err(crate::Error::protocol(
        "free disk space check is not implemented on this platform",
    ))
}

fn too_many_channels(channel_count: usize) -> crate::Error {
    crate::Error::protocol(format!(
        "whisper-local batch transcription supports at most {MAX_BATCH_CHANNELS} audio channels; the recording declares {channel_count}"
    ))
}

fn recording_too_long_message() -> String {
    format!(
        "file too large for on-device transcription: recordings are limited to {} hours",
        MAX_BATCH_DURATION_SECS / 3600
    )
}

fn recording_too_long() -> crate::Error {
    crate::Error::protocol(recording_too_long_message())
}

fn transcribe_source<S>(
    source: S,
    params: &ListenParams,
    loaded_model: &anlg_whisper_local::LoadedWhisper,
    model_path: &Path,
    event_tx: Option<BatchEventSender>,
    cancellation: &BatchCancellation,
) -> Result<batch::Response, crate::Error>
where
    S: Source<Item = f32>,
{
    let mut activity = WorkActivity::new(event_tx.clone());
    let channel_files = resample_to_channel_files(
        source,
        event_tx.as_ref(),
        &mut activity,
        cancellation,
        MAX_BATCH_FRAMES,
    )?;
    let channel_count = channel_files.len();
    let channel_durations = channel_files
        .iter()
        .map(|channel| channel.sample_count as f64 / TARGET_SAMPLE_RATE as f64)
        .collect::<Vec<_>>();
    let total_duration = channel_durations.iter().copied().fold(0.0_f64, f64::max);

    let metadata = build_metadata(model_path);
    let mut model = build_model(loaded_model, params)?;
    let mut response_channels = Vec::with_capacity(channel_count);
    let mut progress = BatchProgress::new(channel_count, total_duration, event_tx, activity);
    ensure_batch_active(&progress.tracker, cancellation)?;
    progress.emit(None);

    for (channel_idx, channel) in channel_files.into_iter().enumerate() {
        ensure_batch_active(&progress.tracker, cancellation)?;
        let channel_index = [channel_idx as i32, channel_count as i32];
        let channel_duration = channel_durations[channel_idx];
        let chunks = ChannelChunkIterator::new(channel)?;
        let mut work = BatchWorkContext {
            progress: &mut progress,
            cancellation,
        };

        let (words, transcript, avg_confidence) = transcribe_channel_chunks(
            channel_idx,
            chunks,
            channel_duration,
            &mut model,
            &mut work,
            &metadata,
            &channel_index,
        )?;

        response_channels.push(batch::Channel {
            alternatives: vec![batch::Alternatives {
                transcript,
                confidence: avg_confidence,
                words,
            }],
        });
    }

    let mut metadata_json = serde_json::to_value(&metadata).unwrap_or_default();
    if let Some(obj) = metadata_json.as_object_mut() {
        obj.insert("duration".to_string(), serde_json::json!(total_duration));
        obj.insert(
            "channels".to_string(),
            serde_json::json!(response_channels.len()),
        );
    }

    Ok(batch::Response {
        metadata: metadata_json,
        results: batch::Results {
            channels: response_channels,
        },
    })
}

/// Exo patch: upstream `ProgressTracker`, plus the percentage it last reported
/// so work inside a chunk can be reported at that same percentage.
struct BatchProgress {
    tracker: ProgressTracker,
    resolved_until: Vec<f64>,
    total_duration: f64,
    percentage: f64,
    activity: WorkActivity,
}

impl BatchProgress {
    fn new(
        channel_count: usize,
        total_duration: f64,
        event_tx: Option<BatchEventSender>,
        activity: WorkActivity,
    ) -> Self {
        Self {
            tracker: ProgressTracker::new(vec![0.0; channel_count], total_duration, event_tx),
            resolved_until: vec![0.0; channel_count],
            total_duration,
            percentage: 0.0,
            activity,
        }
    }

    fn update_channel(&mut self, channel_idx: usize, resolved: f64) {
        self.tracker.update_channel(channel_idx, resolved);
        self.resolved_until[channel_idx] = resolved;
    }

    fn emit(&mut self, partial_text: Option<String>) {
        let previous = self.percentage;
        self.tracker.emit(partial_text);
        // Same computation as `ProgressTracker::emit`, which only sends when
        // the percentage grows.
        let percentage = record_progress(
            overall_resolved_audio(&self.resolved_until),
            self.total_duration,
            &mut self.percentage,
        );
        if self.tracker.has_tx() && percentage > previous {
            self.activity.event_sent();
        }
    }

    fn worked(&mut self, phase: InferencePhase) {
        self.activity.worked(self.percentage, phase);
    }

    fn event_tx(&self) -> Option<&BatchEventSender> {
        self.tracker.event_tx()
    }
}

#[derive(Debug)]
struct ResampledChannelFile {
    file: tempfile::NamedTempFile,
    sample_count: usize,
}

fn resample_to_channel_files<S>(
    source: S,
    event_tx: Option<&BatchEventSender>,
    activity: &mut WorkActivity,
    cancellation: &BatchCancellation,
    max_frames: usize,
) -> Result<Vec<ResampledChannelFile>, crate::Error>
where
    S: Source<Item = f32>,
{
    let channel_count = u16::from(source.channels()).max(1) as usize;
    if channel_count > MAX_BATCH_CHANNELS {
        return Err(too_many_channels(channel_count));
    }

    let files = (0..channel_count)
        .map(|_| {
            tempfile::Builder::new()
                .prefix("whisper_local_channel_")
                .suffix(".wav")
                .tempfile()
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writers = files
        .iter()
        .map(|file| {
            let writer = BufWriter::new(file.reopen()?);
            hound::WavWriter::new(writer, spec).map_err(crate::Error::from)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut decoded_frames = 0usize;
    let info = anlg_audio_utils::for_each_resampled_channel_block::<_, crate::Error>(
        source,
        TARGET_SAMPLE_RATE,
        |channels| {
            if cancellation.is_cancelled() {
                return Err(batch_request_cancelled());
            }
            if event_tx.is_some_and(BatchEventSender::is_closed) {
                return Err(batch_receiver_unavailable());
            }
            decoded_frames += channels.first().map_or(0, |channel| channel.len());
            if decoded_frames > max_frames {
                return Err(recording_too_long());
            }
            for (writer, channel) in writers.iter_mut().zip(channels) {
                for sample in *channel {
                    writer.write_sample(*sample)?;
                }
            }
            // Transcription has not started yet: 0% in the `prefill` phase.
            activity.worked(0.0, InferencePhase::Prefill);
            Ok(())
        },
    )?;

    for writer in writers {
        writer.finalize()?;
    }

    Ok(files
        .into_iter()
        .map(|file| ResampledChannelFile {
            file,
            sample_count: info.frame_count,
        })
        .collect())
}

/// `anlg_transcribe_core::chunk_channel_audio` with the vendored
/// audio-chunking's per-VAD-frame hook; the chunks are identical.
fn chunk_channel_audio_with_progress(
    samples: &[f32],
    on_scanned: &mut dyn FnMut(usize),
) -> Result<Vec<AudioChunk>, crate::Error> {
    let mut chunker = SpeechChunker::new(SpeechChunkingConfig::speech(SPEECH_REDEMPTION_TIME))?;
    let chunks = chunker.chunk_with_progress(samples, TARGET_SAMPLE_RATE, on_scanned)?;
    let mut normalized = Vec::new();

    for chunk in chunks {
        if chunk.samples.len() <= MAX_CHUNK_SAMPLES {
            normalized.push(chunk);
            continue;
        }

        for (index, window) in chunk.samples.chunks(MAX_CHUNK_SAMPLES).enumerate() {
            let sample_start = chunk.sample_start + index * MAX_CHUNK_SAMPLES;
            let sample_end = sample_start + window.len();
            normalized.push(AudioChunk {
                samples: window.to_vec(),
                sample_start,
                sample_end,
            });
        }
    }

    tracing::info!(
        chunk_count = normalized.len(),
        chunk_durations_ms = ?normalized
            .iter()
            .map(|chunk| (chunk.sample_end - chunk.sample_start) * 1000 / TARGET_SAMPLE_RATE as usize)
            .collect::<Vec<_>>(),
        "audio_chunking_complete"
    );

    Ok(normalized)
}

enum ChannelWork {
    Chunk(AudioChunk),
    /// Every sample before `sample_end` has been scanned for speech, and any
    /// speech found in it has already been yielded as a chunk. Also yielded for
    /// windows that contain no speech at all.
    Scanned {
        sample_end: usize,
    },
}

struct ChannelChunkIterator {
    reader: hound::WavReader<BufReader<File>>,
    _file: tempfile::NamedTempFile,
    pending: std::vec::IntoIter<AudioChunk>,
    scanned_until: Option<usize>,
    next_window_start: usize,
    max_window_samples: usize,
    finished: bool,
}

impl ChannelChunkIterator {
    fn new(channel: ResampledChannelFile) -> Result<Self, crate::Error> {
        Self::new_with_window_samples(channel, CHANNEL_WINDOW_SAMPLES)
    }

    fn new_with_window_samples(
        channel: ResampledChannelFile,
        max_window_samples: usize,
    ) -> Result<Self, crate::Error> {
        let reader = hound::WavReader::open(channel.file.path())?;
        Ok(Self {
            reader,
            _file: channel.file,
            pending: Vec::new().into_iter(),
            scanned_until: None,
            next_window_start: 0,
            max_window_samples: max_window_samples.max(1),
            finished: false,
        })
    }

    fn read_next_window(&mut self) -> Result<Option<Vec<f32>>, crate::Error> {
        let samples = self
            .reader
            .samples::<f32>()
            .take(self.max_window_samples)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((!samples.is_empty()).then_some(samples))
    }

    /// Next unit of work; `on_scanned` runs after every VAD frame of a window.
    fn next_work(
        &mut self,
        on_scanned: &mut dyn FnMut(usize),
    ) -> Option<Result<ChannelWork, crate::Error>> {
        loop {
            if let Some(chunk) = self.pending.next() {
                return Some(Ok(ChannelWork::Chunk(chunk)));
            }
            if let Some(sample_end) = self.scanned_until.take() {
                return Some(Ok(ChannelWork::Scanned { sample_end }));
            }
            if self.finished {
                return None;
            }

            let samples = match self.read_next_window() {
                Ok(Some(samples)) => samples,
                Ok(None) => {
                    self.finished = true;
                    return None;
                }
                Err(error) => {
                    self.finished = true;
                    return Some(Err(error));
                }
            };

            let window_start = self.next_window_start;
            self.next_window_start += samples.len();
            let mut chunks = match chunk_channel_audio_with_progress(&samples, on_scanned) {
                Ok(chunks) => chunks,
                Err(error) => {
                    self.finished = true;
                    return Some(Err(error));
                }
            };
            for chunk in &mut chunks {
                chunk.sample_start += window_start;
                chunk.sample_end += window_start;
            }
            self.pending = chunks.into_iter();
            self.scanned_until = Some(self.next_window_start);
        }
    }
}

impl Iterator for ChannelChunkIterator {
    type Item = Result<ChannelWork, crate::Error>;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_work(&mut |_| {})
    }
}

struct BatchWorkContext<'a> {
    progress: &'a mut BatchProgress,
    cancellation: &'a BatchCancellation,
}

fn transcribe_channel_chunks(
    channel_idx: usize,
    mut chunks: ChannelChunkIterator,
    channel_duration: f64,
    model: &mut anlg_whisper_local::Whisper,
    work: &mut BatchWorkContext<'_>,
    metadata: &owhisper_interface::stream::Metadata,
    channel_index: &[i32],
) -> Result<(Vec<batch::Word>, String, f64), crate::Error> {
    let mut all_words = Vec::new();
    let mut transcript = String::new();
    let mut cumulative_confidence = 0.0;
    let mut segment_count = 0usize;

    while let Some(item) =
        chunks.next_work(&mut |_| work.progress.worked(InferencePhase::Transcribing))
    {
        ensure_batch_active(&work.progress.tracker, work.cancellation)?;
        let chunk = match item? {
            ChannelWork::Chunk(chunk) => chunk,
            ChannelWork::Scanned { sample_end } => {
                work.progress
                    .update_channel(channel_idx, sample_end as f64 / TARGET_SAMPLE_RATE as f64);
                work.progress.emit(Some(transcript.clone()));
                continue;
            }
        };
        let chunk_start_sec = chunk.sample_start as f64 / TARGET_SAMPLE_RATE as f64;
        work.progress.update_channel(channel_idx, chunk_start_sec);

        let segments =
            transcribe_chunk_with_progress(model, &chunk.samples, chunk_start_sec, &mut || {
                work.progress.worked(InferencePhase::Decoding)
            })?;
        ensure_batch_active(&work.progress.tracker, work.cancellation)?;
        for segment in segments {
            cumulative_confidence += segment.confidence;
            segment_count += 1;
            all_words.extend(build_batch_words(&segment, channel_idx as i32));

            if let Some(tx) = work.progress.event_tx()
                && !tx.send_blocking(BatchSseMessage::Segment {
                    response: build_transcript_response(
                        &segment,
                        TranscriptKind::Confirmed,
                        metadata,
                        channel_index,
                    ),
                })
            {
                return Err(batch_receiver_unavailable());
            }

            append_transcript(&mut transcript, &segment.text);
        }

        work.progress.update_channel(
            channel_idx,
            chunk.sample_end as f64 / TARGET_SAMPLE_RATE as f64,
        );
        work.progress.emit(Some(transcript.clone()));
        ensure_batch_active(&work.progress.tracker, work.cancellation)?;
    }
    work.progress.update_channel(channel_idx, channel_duration);
    work.progress.emit(Some(transcript.clone()));

    let avg_confidence = if segment_count == 0 {
        0.0
    } else {
        cumulative_confidence / segment_count as f64
    };

    Ok((all_words, transcript, avg_confidence))
}

fn append_transcript(transcript: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    if !transcript.is_empty() {
        transcript.push(' ');
    }
    transcript.push_str(text);
}

fn ensure_batch_active(
    progress: &ProgressTracker,
    cancellation: &BatchCancellation,
) -> Result<(), crate::Error> {
    if cancellation.is_cancelled() {
        return Err(batch_request_cancelled());
    }
    if progress.is_cancelled() {
        return Err(batch_receiver_unavailable());
    }
    Ok(())
}

fn batch_receiver_unavailable() -> crate::Error {
    crate::Error::protocol("batch event receiver unavailable")
}

fn batch_request_cancelled() -> crate::Error {
    crate::Error::protocol("batch request cancelled")
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::{Duration, Instant};

    use anlg_transcribe_core::{ProgressTracker, batch_event_channel};
    use axum::body::{Body, Bytes};
    use axum::http::StatusCode;
    use owhisper_interface::InferencePhase;
    use owhisper_interface::batch_sse::BatchSseMessage;
    use tokio::sync::Semaphore;

    use super::{
        BatchAudioWriteError, BatchCancellation, CancelBatchOnDrop, ChannelChunkIterator,
        ChannelWork, DECODE_DISK_RESERVE_BYTES, MAX_BATCH_AUDIO_BODY_BYTES, MAX_BATCH_FRAMES,
        MAX_REJECTED_BATCH_DRAIN_BYTES, ResampledChannelFile, WorkActivity, batch_busy_response,
        chunk_channel_audio_with_progress, drain_rejected_batch_audio, ensure_batch_active,
        plan_decode_storage, resample_to_channel_files, spawn_batch_job,
        spool_batch_audio_with_limit, try_acquire_http_batch_permit,
    };

    const GB: u64 = 1_000_000_000;

    fn no_activity() -> WorkActivity {
        WorkActivity::new(None)
    }

    #[test]
    fn disconnected_sse_receiver_cancels_batch_work() {
        let (tx, rx) = batch_event_channel();
        drop(rx);
        let progress = ProgressTracker::new(vec![0.0], 1.0, Some(tx));
        let cancellation = BatchCancellation::default();

        assert!(ensure_batch_active(&progress, &cancellation).is_err());
    }

    #[test]
    fn dropping_request_guard_cancels_batch_work() {
        let progress = ProgressTracker::new(vec![0.0], 1.0, None);
        let cancellation = BatchCancellation::default();
        let guard = CancelBatchOnDrop(cancellation.clone());

        assert!(ensure_batch_active(&progress, &cancellation).is_ok());
        drop(guard);
        let error = ensure_batch_active(&progress, &cancellation).unwrap_err();
        assert!(error.to_string().contains("batch request cancelled"));
    }

    #[test]
    fn batch_admission_rejects_work_instead_of_queueing_it() {
        let admission = Arc::new(Semaphore::new(1));
        let permit = try_acquire_http_batch_permit(Arc::clone(&admission)).unwrap();

        assert!(try_acquire_http_batch_permit(Arc::clone(&admission)).is_none());
        assert_eq!(
            batch_busy_response().status(),
            StatusCode::TOO_MANY_REQUESTS
        );

        drop(permit);
        assert!(try_acquire_http_batch_permit(admission).is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detached_blocking_job_keeps_its_admission_permit() {
        let admission = Arc::new(Semaphore::new(1));
        let permit = try_acquire_http_batch_permit(Arc::clone(&admission)).unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();

        let job = spawn_batch_job(permit, move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(job);

        assert!(try_acquire_http_batch_permit(Arc::clone(&admission)).is_none());

        release_tx.send(()).unwrap();
        let permit = tokio::time::timeout(Duration::from_secs(1), admission.acquire_owned())
            .await
            .unwrap()
            .unwrap();
        drop(permit);
    }

    #[tokio::test]
    async fn batch_request_body_is_spooled_to_disk() {
        let mut received = Vec::new();
        let audio = spool_batch_audio_with_limit(Body::from("audio"), "audio/wav", 16, |len| {
            received.push(len)
        })
        .await
        .unwrap();

        assert_eq!(audio.len, 5);
        assert_eq!(std::fs::read(audio.path()).unwrap(), b"audio");
        assert_eq!(received, vec![5]);
    }

    #[tokio::test]
    async fn small_rejected_batch_body_is_drained() {
        drain_rejected_batch_audio(Body::from("audio"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rejected_batch_body_drain_stops_at_its_byte_bound() {
        const CHUNK_BYTES: usize = 8 * 1_024;

        let chunks_read = Arc::new(AtomicUsize::new(0));
        let observed_chunks = Arc::clone(&chunks_read);
        let stream = futures_util::stream::iter((0..1_000).map(move |_| {
            observed_chunks.fetch_add(1, Ordering::SeqCst);
            Ok::<_, Infallible>(Bytes::from(vec![0; CHUNK_BYTES]))
        }));

        drain_rejected_batch_audio(Body::from_stream(stream))
            .await
            .unwrap();

        assert_eq!(
            chunks_read.load(Ordering::SeqCst),
            MAX_REJECTED_BATCH_DRAIN_BYTES.div_ceil(CHUNK_BYTES)
        );
    }

    #[tokio::test]
    async fn rejected_batch_body_drain_times_out_on_a_slow_client() {
        let body =
            Body::from_stream(futures_util::stream::pending::<Result<Bytes, std::io::Error>>());
        let started = Instant::now();

        drain_rejected_batch_audio(body).await.unwrap();

        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn oversized_batch_request_is_rejected_while_spooling() {
        let error = spool_batch_audio_with_limit(Body::from("12345"), "audio/wav", 4, |_| {})
            .await
            .unwrap_err();

        assert!(matches!(error, BatchAudioWriteError::TooLarge));
        let (status, _, detail) = error.into_parts();
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(detail.contains("limited to 8 hours"), "{detail}");
    }

    #[test]
    fn upload_cap_matches_eight_hours_of_128_kbps_audio() {
        let eight_hours_at_128_kbps = 8 * 60 * 60 * 128_000 / 8;
        assert!(MAX_BATCH_AUDIO_BODY_BYTES > eight_hours_at_128_kbps);
        assert!(MAX_BATCH_AUDIO_BODY_BYTES < eight_hours_at_128_kbps * 11 / 10);
    }

    #[test]
    fn decoded_limit_fits_in_a_wav_file() {
        assert!((MAX_BATCH_FRAMES as u64) * 4 + 44 < u32::MAX as u64);
    }

    #[test]
    fn unsupported_channel_count_is_rejected_before_resampling() {
        let source = rodio::buffer::SamplesBuffer::new(
            std::num::NonZeroU16::new(3).unwrap(),
            std::num::NonZeroU32::new(16_000).unwrap(),
            Vec::new(),
        );

        let cancellation = BatchCancellation::default();
        let error = resample_to_channel_files(
            source,
            None,
            &mut no_activity(),
            &cancellation,
            MAX_BATCH_FRAMES,
        )
        .unwrap_err();

        assert!(error.to_string().contains("at most 2 audio channels"));
        assert!(error.to_string().contains("declares 3"));
    }

    #[test]
    fn preflight_rejects_more_channels_than_supported() {
        let error = plan_decode_storage(3, Some(Duration::from_secs(60)), 100 * GB).unwrap_err();
        assert!(error.to_string().contains("at most 2 audio channels"));
    }

    #[test]
    fn preflight_rejects_recordings_over_eight_hours() {
        let error =
            plan_decode_storage(2, Some(Duration::from_secs(8 * 3600 + 1)), 100 * GB).unwrap_err();
        assert!(error.to_string().contains("file too large"), "{error}");
        assert!(error.to_string().contains("8 hours"), "{error}");

        assert!(plan_decode_storage(2, Some(Duration::from_secs(8 * 3600)), 100 * GB).is_ok());
    }

    #[test]
    fn preflight_rejects_when_decoded_audio_would_not_fit() {
        // 1 h stereo: 2 x 3600 s x 16 kHz x 4 B = 460.8 MB, +5%, + reserve.
        let required = plan_decode_storage(2, Some(Duration::from_secs(3600)), 100 * GB).unwrap();
        assert!(required > 483_840_000 + DECODE_DISK_RESERVE_BYTES);
        assert!(required < 484_000_000 + DECODE_DISK_RESERVE_BYTES);

        let error =
            plan_decode_storage(2, Some(Duration::from_secs(3600)), required - 1).unwrap_err();
        assert!(
            error.to_string().contains("not enough free disk space"),
            "{error}"
        );
        assert!(error.to_string().contains("1.0 GB"), "{error}");
        assert!(plan_decode_storage(2, Some(Duration::from_secs(3600)), required).is_ok());
    }

    #[test]
    fn preflight_plans_an_unknown_duration_at_the_supported_maximum() {
        let required = plan_decode_storage(2, None, 100 * GB).unwrap();
        assert_eq!(
            required,
            2 * (MAX_BATCH_FRAMES as u64 * 4 + 44) + DECODE_DISK_RESERVE_BYTES
        );
    }

    #[test]
    fn decoding_stops_at_the_frame_limit() {
        let source = rodio::buffer::SamplesBuffer::new(
            std::num::NonZeroU16::new(2).unwrap(),
            std::num::NonZeroU32::new(16_000).unwrap(),
            vec![0.0f32; 16_000 * 2 * 3],
        );

        let error = resample_to_channel_files(
            source,
            None,
            &mut no_activity(),
            &BatchCancellation::default(),
            16_000 * 2,
        )
        .unwrap_err();

        assert!(error.to_string().contains("file too large"), "{error}");
    }

    #[test]
    fn channel_audio_is_read_in_bounded_windows() {
        let file = tempfile::Builder::new().suffix(".wav").tempfile().unwrap();
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(file.path(), spec).unwrap();
        for sample in 0..10 {
            writer.write_sample(sample as f32).unwrap();
        }
        writer.finalize().unwrap();
        let channel = ResampledChannelFile {
            file,
            sample_count: 10,
        };
        let mut reader = ChannelChunkIterator::new_with_window_samples(channel, 4).unwrap();

        assert_eq!(reader.read_next_window().unwrap().unwrap().len(), 4);
        assert_eq!(reader.read_next_window().unwrap().unwrap().len(), 4);
        assert_eq!(reader.read_next_window().unwrap().unwrap().len(), 2);
        assert!(reader.read_next_window().unwrap().is_none());
    }

    fn silent_channel(sample_count: usize) -> ResampledChannelFile {
        let file = tempfile::Builder::new().suffix(".wav").tempfile().unwrap();
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(file.path(), spec).unwrap();
        for _ in 0..sample_count {
            writer.write_sample(0.0f32).unwrap();
        }
        writer.finalize().unwrap();
        ResampledChannelFile { file, sample_count }
    }

    #[test]
    fn speech_free_windows_still_report_scan_progress() {
        let mut iterator =
            ChannelChunkIterator::new_with_window_samples(silent_channel(56_000), 16_000).unwrap();

        let mut frames_scanned = 0;
        let mut scanned = Vec::new();
        while let Some(item) = iterator.next_work(&mut |_| frames_scanned += 1) {
            match item.unwrap() {
                ChannelWork::Scanned { sample_end } => scanned.push(sample_end),
                ChannelWork::Chunk(chunk) => panic!("silence produced a speech chunk: {chunk:?}"),
            }
        }

        assert_eq!(scanned, vec![16_000, 32_000, 48_000, 56_000]);
        // Silero frames are 512 samples: 31 per full 1 s window, 15 in the 0.5 s tail.
        assert_eq!(frames_scanned, 31 * 3 + 15);
    }

    fn english_speech() -> Vec<f32> {
        anlg_data::english_1::AUDIO
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
            .collect()
    }

    #[test]
    fn progress_chunking_matches_upstream_chunking() {
        let samples = english_speech();

        let upstream = anlg_transcribe_core::chunk_channel_audio::<crate::Error>(&samples).unwrap();
        let mut scanned = Vec::new();
        let patched =
            chunk_channel_audio_with_progress(&samples, &mut |end| scanned.push(end)).unwrap();

        assert!(!upstream.is_empty());
        assert_eq!(upstream.len(), patched.len());
        for (a, b) in upstream.iter().zip(&patched) {
            assert_eq!(
                (a.sample_start, a.sample_end),
                (b.sample_start, b.sample_end)
            );
            assert_eq!(a.samples, b.samples);
        }
        assert_eq!(scanned.len(), samples.len() / 512);
        assert!(scanned.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[tokio::test]
    async fn decoding_reports_prefill_progress_while_it_works() {
        let (tx, mut rx) = batch_event_channel();
        let frames = 16_000 * 5;
        let source = rodio::buffer::SamplesBuffer::new(
            std::num::NonZeroU16::new(2).unwrap(),
            std::num::NonZeroU32::new(16_000).unwrap(),
            vec![0.0f32; frames * 2],
        );

        let mut activity = WorkActivity::with_min_interval(Some(tx.clone()), Duration::ZERO);
        let files = resample_to_channel_files(
            source,
            Some(&tx),
            &mut activity,
            &BatchCancellation::default(),
            MAX_BATCH_FRAMES,
        )
        .unwrap();
        drop(activity);
        drop(tx);

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].sample_count, frames);
        let mut prefill = 0;
        while let Some(message) = rx.recv().await {
            match message {
                BatchSseMessage::Progress { progress } => {
                    assert_eq!(progress.percentage, 0.0);
                    assert!(matches!(progress.phase, InferencePhase::Prefill));
                    prefill += 1;
                }
                _ => panic!("decoding emitted a non-progress event"),
            }
        }
        assert!(prefill > 0);
    }

    #[tokio::test]
    async fn work_reports_are_rate_limited() {
        // Constructed "just now": however much work is done, nothing is sent
        // until the interval has passed.
        let (tx, mut rx) = batch_event_channel();
        let mut activity = WorkActivity::with_min_interval(Some(tx), Duration::from_secs(3600));
        for _ in 0..1_000 {
            activity.worked(0.5, InferencePhase::Decoding);
        }
        drop(activity);
        assert!(rx.recv().await.is_none());

        let (tx, mut rx) = batch_event_channel();
        let mut activity = WorkActivity::with_min_interval(Some(tx), Duration::ZERO);
        activity.worked(0.25, InferencePhase::Decoding);
        drop(activity);
        match rx.recv().await {
            Some(BatchSseMessage::Progress { progress }) => {
                assert_eq!(progress.percentage, 0.25);
                assert!(matches!(progress.phase, InferencePhase::Decoding));
            }
            _ => panic!("expected one progress report"),
        }
        assert!(rx.recv().await.is_none());
    }
}
