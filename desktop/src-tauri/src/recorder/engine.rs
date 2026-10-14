//! Capture lifecycle over anarlog's recorder. Pause/Stop report session-finalization
//! state from the listener snapshot; that does not prove macOS released the input.
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait};
use parking_lot::Mutex;
use recorder_state::{Error as RecorderError, Recorder, Request, Stall, Start, State, Step, Stop};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_settings::SettingsPluginExt;
use tauri_plugin_transcription::ListenerPluginExt;

use super::{audio_provider::Meter, files, journal};

const MIC_EVENT: &str = "exo://recorder-mic-state";
const INPUTS_EVENT: &str = "exo://recorder-inputs";
const LEVEL_EVENT: &str = "exo://recorder-level";
const AUTO_STOP_EVENT: &str = "exo://recorder-auto-stopped";
const MAX_DURATION_MS: u64 = 3 * 60 * 60 * 1000;
const MIN_DURATION_MS: u64 = 1_000;

#[derive(Default)]
pub struct Engine(pub Mutex<EngineState>);

#[derive(Default)]
pub struct EngineState {
    id: Option<String>,
    layout: journal::Layout,
    started_at: Option<u64>,
    segment_id: Option<String>,
    recorder: Recorder,
    spans: Vec<journal::MissingAudioSpan>,
    busy: bool,
    limit_ms: u64,
    auto_stop_requested: bool,
    last_stop_reason: Option<&'static str>,
    capture_source_unconfirmed: bool,
}

#[derive(Serialize, Clone, Copy)]
pub struct Level {
    level: f32,
    peak: f32,
    sources: LevelSources,
}

#[derive(Serialize, Clone, Copy)]
pub struct LevelSources {
    mic: SourceLevel,
    system: Option<SourceLevel>,
}

#[derive(Serialize, Clone, Copy)]
pub struct SourceLevel {
    level: f32,
    peak: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AutoStopped {
    id: String,
    reason: &'static str,
    max_duration_ms: u64,
    at: u64,
    elapsed_ms: u64,
    paused_ms: u64,
    channels: u8,
    spans: Vec<journal::MissingAudioSpan>,
}

pub fn install(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut next_release_check = Instant::now();
        loop {
            ticker.tick().await;
            if Instant::now() >= next_release_check {
                next_release_check = Instant::now() + Duration::from_secs(2);
                let unconfirmed = handle.state::<Engine>().0.lock().capture_source_unconfirmed;
                if unconfirmed
                    && capture_source_release_observed(true, default_input_running_somewhere())
                {
                    let status = {
                        let engine = handle.state::<Engine>();
                        let mut state = engine.0.lock();
                        state.capture_source_unconfirmed = false;
                        state.status()
                    };
                    let _ = handle.emit(MIC_EVENT, status);
                }
            }
            let (level, auto_stop) = {
                let engine = handle.state::<Engine>();
                let mut state = engine.0.lock();
                if state.segment_id.is_none() {
                    (None, None)
                } else {
                    let meter = handle.state::<Arc<StdMutex<Meter>>>();
                    let (sample_level, sample_peak, mic, system) = meter.lock().unwrap().take();
                    let level = Level {
                        level: sample_level,
                        peak: sample_peak,
                        sources: LevelSources {
                            mic: SourceLevel {
                                level: mic.0,
                                peak: mic.1,
                            },
                            system: system.map(|reading| SourceLevel {
                                level: reading.0,
                                peak: reading.1,
                            }),
                        },
                    };
                    let auto_stop = if !state.busy
                        && !state.auto_stop_requested
                        && state.recorder.is_live()
                        && state.recorder.status(mono_ms()).elapsed_ms >= state.limit_ms
                    {
                        state.auto_stop_requested = true;
                        state.id.clone()
                    } else {
                        None
                    };
                    (Some(level), auto_stop)
                }
            };
            if let Some(level) = level {
                let _ = handle.emit(LEVEL_EVENT, level);
            }
            if let Some(id) = auto_stop {
                // recorder_pause takes the busy flag before its first await,
                // so the next tick cannot launch a second stop.
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(result) = recorder_stop(app.clone()).await {
                        let _ = app.emit(
                            AUTO_STOP_EVENT,
                            AutoStopped {
                                id,
                                reason: "max_duration",
                                max_duration_ms: result.max_duration_ms,
                                at: now_ms(),
                                elapsed_ms: result.elapsed_ms,
                                paused_ms: result.paused_ms,
                                channels: result.channels,
                                spans: result.spans,
                            },
                        );
                    } else {
                        let engine = app.state::<Engine>();
                        engine.0.lock().auto_stop_requested = false;
                    }
                });
            }
        }
    });
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    state: &'static str,
    reason: Option<&'static str>,
    id: Option<String>,
    channels: u8,
    started_at: Option<u64>,
    elapsed_ms: u64,
    audio_ms: u64,
    paused_ms: u64,
    max_duration_ms: u64,
    intent: &'static str,
    availability: &'static str,
    at: u64,
    elapsed_at: u64,
    spans: Vec<journal::MissingAudioSpan>,
    capture_source_unconfirmed: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(feature = "recorder-failpoints")]
fn source_never_stops_failpoint() -> bool {
    std::env::var("EXO_FAILPOINT").is_ok_and(|value| value == "source_never_stops")
}

#[cfg(not(feature = "recorder-failpoints"))]
fn source_never_stops_failpoint() -> bool {
    false
}

/// AudioObject's system-wide running property is conservative: another app can
/// keep the default input marked running, so only `Some(false)` clears our flag.
fn capture_source_release_observed(unconfirmed: bool, input_running: Option<bool>) -> bool {
    unconfirmed && input_running == Some(false)
}

#[cfg(target_os = "macos")]
fn default_input_running_somewhere() -> Option<bool> {
    use std::ffi::c_void;

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyData(
            object_id: u32,
            address: *const AudioObjectPropertyAddress,
            qualifier_data_size: u32,
            qualifier_data: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    let default_input = AudioObjectPropertyAddress {
        selector: u32::from_be_bytes(*b"dIn "),
        scope: u32::from_be_bytes(*b"glob"),
        element: 0,
    };
    let mut device_id = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            1,
            &default_input,
            0,
            std::ptr::null(),
            &mut size,
            &mut device_id as *mut u32 as *mut c_void,
        )
    };
    if status != 0 || device_id == 0 {
        return None;
    }

    let running_somewhere = AudioObjectPropertyAddress {
        selector: u32::from_be_bytes(*b"gone"),
        scope: u32::from_be_bytes(*b"glob"),
        element: 0,
    };
    let mut running = 0u32;
    size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            &running_somewhere,
            0,
            std::ptr::null(),
            &mut size,
            &mut running as *mut u32 as *mut c_void,
        )
    };
    (status == 0).then_some(running != 0)
}

#[cfg(not(target_os = "macos"))]
fn default_input_running_somewhere() -> Option<bool> {
    None
}


/// Monotonic clock for the recorder state machine. Only differences are used.
fn mono_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn native_step(state: &EngineState, request: Request) -> Result<Step, String> {
    state
        .recorder
        .request(request)
        .map_err(|error| error.code().to_owned())
}

/// Records an unconfirmed native stop. The segment stays retryable; returns the error code
/// unless a detail string is given.
fn stall_stop(
    app: &tauri::AppHandle,
    stop_at: u64,
    stall: Stall,
    detail: Option<String>,
) -> String {
    {
        let engine = app.state::<Engine>();
        let mut state = engine.0.lock();
        state.busy = false;
        // Stalled always returns Err(Stalled(stall)); the code is returned below.
        let _ = state.recorder.stop_outcome(stop_at, Stop::Stalled(stall));
    }
    emit_status(app);
    detail.unwrap_or_else(|| RecorderError::Stalled(stall).code().to_owned())
}

/// Outcome of making the stopped source durable.
enum DurableError {
    /// The finalized session contained no usable audio.
    Empty,
    /// Listener-session finalization was not observed before the deadline.
    Stall(Stall),
    /// Finalization was observed, but its audio could not be made durable.
    Failed(String),
}

impl From<String> for DurableError {
    fn from(error: String) -> Self {
        if empty_capture(&error) {
            Self::Empty
        } else {
            Self::Failed(error)
        }
    }
}

fn stall_for(session_active: bool) -> Stall {
    if session_active {
        Stall::SourceStillRunning
    } else {
        Stall::WriterStalled
    }
}

impl EngineState {
    fn status(&self) -> CaptureStatus {
        let at = now_ms();
        let status = self.recorder.status(mono_ms());
        CaptureStatus {
            state: status.state.as_str(),
            reason: status.reason.or(self.last_stop_reason),
            id: self.id.clone(),
            channels: self.layout.channels(),
            started_at: self.started_at,
            elapsed_ms: status.elapsed_ms,
            audio_ms: status.elapsed_ms,
            paused_ms: status.paused_ms,
            max_duration_ms: if self.limit_ms == 0 {
                MAX_DURATION_MS
            } else {
                self.limit_ms
            },
            intent: if self.capture_source_unconfirmed {
                "recording"
            } else if self.recorder.is_native_open() {
                "recording"
            } else if self.id.is_some() {
                "paused"
            } else {
                "stopped"
            },
            availability: if status.state == State::NeedsUser {
                "blocked"
            } else {
                "available"
            },
            at,
            elapsed_at: at,
            spans: self.spans.clone(),
            capture_source_unconfirmed: self.capture_source_unconfirmed,
        }
    }
}

fn emit_status(app: &tauri::AppHandle) {
    let status = app.state::<Engine>().0.lock().status();
    let _ = app.emit(MIC_EVENT, status);
}

fn clear_busy(app: &tauri::AppHandle) {
    let engine = app.state::<Engine>();
    engine.0.lock().busy = false;
}

fn reset_meter(app: &tauri::AppHandle) {
    let meter = app.state::<Arc<StdMutex<Meter>>>();
    meter.lock().unwrap().reset();
}

fn capture_params(
    segment_id: &str,
    mic_device: Option<String>,
) -> Result<tauri_plugin_transcription::CaptureParams, String> {
    Ok(tauri_plugin_transcription::CaptureParams {
        session_id: segment_id.to_owned(),
        languages: vec![
            "en".parse::<anlg_language::Language>()
                .map_err(|e| e.to_string())?,
        ],
        onboarding: false,
        model: String::new(),
        base_url: String::new(),
        api_key: String::new(),
        keywords: vec![],
        mic_device,
        transcription_mode: Some(anlg_transcription_core::listener::TranscriptionMode::Batch),
        participant_human_ids: vec![],
        self_human_id: None,
    })
}

fn segment_system_audio(layout: journal::Layout, requested: bool) -> bool {
    layout == journal::Layout::Stereo && requested
}

fn begin(state: &mut EngineState, input: String) -> Result<(String, Option<String>), String> {
    if state.busy {
        return Err("recorder_busy".into());
    }
    state.busy = true;
    Ok((format!("rec-{}", uuid::Uuid::new_v4()), Some(input)))
}

async fn start_segment(
    app: &tauri::AppHandle,
    segment_id: &str,
    input: Option<String>,
) -> Result<(), String> {
    let params = capture_params(segment_id, input)?;
    let sessions = files::sessions_root(app)?;
    let mut prepared = crate::session_audio::prepare_recorder_dir(&sessions, segment_id)
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    app.listener()
        .start_capture(params)
        .await
        .map_err(|e| e.to_string())?;
    prepared.started();
    Ok(())
}

#[tauri::command]
pub async fn recorder_start(
    app: tauri::AppHandle,
    id: String,
    max_duration_ms: Option<u64>,
) -> Result<CaptureStatus, String> {
    super::ensure(&app);
    super::extras::load_system_audio(&app).await?;
    if !files::valid_recording_id(&id) {
        return Err("invalid_recording_id".into());
    }
    tracing::info!(target: "exo_dev::recorder", kind = "pipeline", source_id = %id, operation = "recorder", phase = "start");
    if journal::load(&app)?.is_some() {
        return Err("recovery_pending".into());
    }
    let input = recording_input(&app).await?;
    let (segment_id, input) = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock();
        if state.id.is_some() {
            return Err("recording_in_progress".into());
        }
        begin(&mut state, input)?
    };
    let started_at = now_ms();
    let system_audio = app.state::<Arc<AtomicBool>>().load(Ordering::SeqCst);
    let layout = if system_audio {
        journal::Layout::Stereo
    } else {
        journal::Layout::Mono
    };
    let saved = journal::save(
        &app,
        &journal::Journal {
            id: id.clone(),
            started_at,
            segment_id: Some(segment_id.clone()),
            recorded_ms: 0,
            paused_ms: 0,
            max_duration_ms: max_duration_ms
                .unwrap_or(MAX_DURATION_MS)
                .clamp(MIN_DURATION_MS, MAX_DURATION_MS),
            system_audio,
            layout,
            spans: Vec::new(),
            capture_source_unconfirmed: false,
        },
    );
    if saved.is_err() {
        clear_busy(&app);
    }
    saved?;
    app.state::<Engine>().0.lock().layout = layout;
    let result = start_segment(&app, &segment_id, input).await;
    let cleanup = if result.is_err() {
        journal::clear(&app)
    } else {
        Ok(())
    };
    if let Err(error) = &result {
        let reason = if error.starts_with("unsafe_sessions_folder:") {
            "unsafe_sessions_folder"
        } else if error.starts_with("session_exists:") {
            "session_exists"
        } else {
            "mic_unavailable"
        };
        let engine = app.state::<Engine>();
        let mut state = engine.0.lock();
        state.busy = false;
        state.layout = journal::Layout::Mono;
        let _ = state.recorder.start_outcome(mono_ms(), Start::Failed(reason));
        drop(state);
        emit_status(&app);
        cleanup?;
        return Err(reason.into());
    }
    let status = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock();
        state.busy = false;
        result?;
        state
            .recorder
            .start_outcome(mono_ms(), Start::Opened)
            .map_err(|error| error.code().to_owned())?;
        state.id = Some(id);
        state.started_at = Some(started_at);
        state.segment_id = Some(segment_id);
        state.spans.clear();
        state.limit_ms = max_duration_ms
            .unwrap_or(MAX_DURATION_MS)
            .clamp(MIN_DURATION_MS, MAX_DURATION_MS);
        state.auto_stop_requested = false;
        state.last_stop_reason = None;
        cleanup?;
        state.status()
    };
    reset_meter(&app);
    emit_status(&app);
    if let Some(id) = status.id.as_deref() {
        tracing::info!(target: "exo_dev::recorder", kind = "pipeline", source_id = %id, operation = "recorder", phase = "done");
    }
    Ok(status)
}

async fn end_segment(
    app: &tauri::AppHandle,
    segment_id: &str,
    elapsed_ms: u64,
) -> Result<(), Stall> {
    app.listener().stop_capture().await;
    wait_finalization(app, segment_id, elapsed_ms).await
}

async fn wait_finalization(
    app: &tauri::AppHandle,
    segment_id: &str,
    elapsed_ms: u64,
) -> Result<(), Stall> {
    if source_never_stops_failpoint() {
        return Err(Stall::SourceStillRunning);
    }
    // The upstream WAV->MP3 encode scales with segment length. A snapshot call
    // errors on actor timeout, unlike get_capture_state's false "Inactive".
    let deadline = Instant::now() + Duration::from_secs(30 + elapsed_ms / 15_000);
    // A failed snapshot keeps the last known listener-session state.
    let mut session_active = true;
    loop {
        if let Ok(snapshot) = app.listener().get_capture_snapshot().await {
            session_active = snapshot.active_session_id.as_deref() == Some(segment_id);
            if !session_active
                && !snapshot
                    .finalizing_session_ids
                    .iter()
                    .any(|id| id == segment_id)
            {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err(stall_for(session_active));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// anarlog closes the WAV writer before its length-dependent MP3 encode. Its
// capture snapshot only reports the *later* finalization boundary, so retain
// our own hard link as soon as the closed RIFF header proves the source is
// complete. The link survives anarlog deleting audio.wav after encoding.
fn retain_stopped_source(session: &std::path::Path) -> Result<bool, String> {
    let retained = session.join("audio.exo-source.wav");
    if retained.exists() {
        return Ok(true);
    }
    // The pinned upstream writer explicitly fsyncs every WAV source and this
    // directory before publishing the marker. A complete RIFF header alone
    // does not prove the separate stereo/debug writers have stopped.
    if !session.join("audio.exo-source-ready").exists() {
        return Ok(false);
    }
    let wav = session.join("audio.wav");
    if wav.exists() {
        let mut file = std::fs::File::open(&wav).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let mut header = [0u8; 12];
        if file.read_exact(&mut header).is_ok()
            && &header[..4] == b"RIFF"
            && &header[8..] == b"WAVE"
            && u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap())) + 8 == size
            && size > 44
            && hound::WavReader::open(&wav).is_ok_and(|reader| reader.duration() > 0)
        {
            match std::fs::hard_link(&wav, &retained) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(error.to_string()),
            }
            file.sync_all().map_err(|e| e.to_string())?;
            std::fs::File::open(session)
                .and_then(|dir| dir.sync_all())
                .map_err(|e| e.to_string())?;
            return Ok(true);
        }
    }
    let mp3 = session.join("audio.mp3");
    if mp3.exists() {
        // The upstream producer syncs the MP3 before removing the WAV. Only
        // accept this path after its finalizing actor has exited.
        return Ok(false);
    }
    Ok(false)
}

async fn durable_source(app: &tauri::AppHandle, segment_id: &str) -> Result<(), DurableError> {
    if source_never_stops_failpoint() {
        // Keep the normal stopped-WAV recovery path exercised in smoke builds,
        // but report the source as unconfirmed regardless of this best-effort snapshot.
        let session = files::sessions_root(app)
            .map_err(|error| DurableError::Failed(error.to_string()))?
            .join(segment_id);
        let _ = run_source_step(move || retain_stopped_source(&session)).await;
        return Err(DurableError::Stall(Stall::SourceStillRunning));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    // A failed snapshot keeps the last known source state.
    let mut source_active = true;
    loop {
        let session = files::sessions_root(app)?.join(segment_id);
        let ready = run_source_step(move || retain_stopped_source(&session)).await?;
        if ready {
            return Ok(());
        }
        if let Ok(snapshot) = app.listener().get_capture_snapshot().await {
            source_active = snapshot.active_session_id.as_deref() == Some(segment_id);
            if !source_active
                && !snapshot
                    .finalizing_session_ids
                    .iter()
                    .any(|id| id == segment_id)
            {
                let session = files::sessions_root(app)?.join(segment_id);
                let mp3 = session.join("audio.mp3");
                return run_source_step(move || {
                    let wav = session.join("audio.wav");
                    if mp3.exists() && !wav.exists() {
                        let file = std::fs::File::open(&mp3).map_err(|e| e.to_string())?;
                        if file.metadata().map_err(|e| e.to_string())?.len() == 0 {
                            return Err("capture_audio_empty".into());
                        }
                        file.sync_all().map_err(|e| e.to_string())?;
                        std::fs::File::open(&session)
                            .and_then(|dir| dir.sync_all())
                            .map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                    if !wav.exists()
                        || hound::WavReader::open(&wav)
                            .map_err(|e| e.to_string())?
                            .duration()
                            == 0
                    {
                        return Err("capture_audio_empty".into());
                    }
                    Err("capture_audio_missing".into())
                })
                .await
                .map_err(DurableError::from);
            }
        }
        if Instant::now() >= deadline {
            return Err(DurableError::Stall(stall_for(source_active)));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn run_source_step<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

async fn run_segment_import<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || super::with_import_lock(operation))
        .await
        .map_err(|error| error.to_string())?
}

fn import_finished_segment(
    app: &tauri::AppHandle,
    segment_id: &str,
    id: &str,
    system_audio: bool,
    layout: journal::Layout,
) -> Result<(), String> {
    if files::segment_imported(app, id, segment_id)? {
        files::remove_source_session(&files::sessions_root(app)?, segment_id)?;
        return journal::remove_failed_source(app, segment_id);
    }
    let vault = app.settings().vault_base().map_err(|e| e.to_string())?;
    let ordinary = std::path::Path::new(vault.as_str())
        .join("sessions")
        .join(segment_id);
    let failed = journal::failed_source(app, segment_id)?;
    let session = if ordinary.exists() { ordinary } else { failed };
    files::import_segment(
        app,
        id,
        segment_id,
        &source_mp3(&session)?,
        system_audio,
        layout,
    )?;
    journal::remove_failed_source(app, segment_id)
}

fn source_mp3(session: &std::path::Path) -> Result<std::path::PathBuf, String> {
    // anarlog fsyncs its completed MP3 before unlinking audio.wav. A still
    // present original WAV means a same-named MP3 may be a partial encode.
    let mp3 = session.join("audio.mp3");
    if mp3.exists() && !session.join("audio.wav").exists() {
        if std::fs::metadata(&mp3).map_err(|e| e.to_string())?.len() == 0 {
            return Err("capture_audio_empty".into());
        }
        std::fs::File::open(&mp3)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::File::open(session)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        return Ok(mp3);
    }
    // Only an interrupted upstream encode uses the retained durable WAV.
    let retained = session.join("audio.exo-source.wav");
    if retained.exists() {
        let recovered = session.join("audio.exo-recovered.mp3");
        if !recovered.exists() {
            let temp = session.join(format!(
                "audio.exo-recovered.{}.mp3.tmp",
                uuid::Uuid::new_v4()
            ));
            anlg_mp3::encode_wav(&retained, &temp)
                .map_err(|e| format!("recovery_encode_failed: {e}"))?;
            std::fs::File::open(&temp)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
            std::fs::rename(&temp, &recovered).map_err(|e| e.to_string())?;
            std::fs::File::open(session)
                .and_then(|dir| dir.sync_all())
                .map_err(|e| e.to_string())?;
        }
        return Ok(recovered);
    }
    if !mp3.exists() {
        let wav = session.join("audio.wav");
        if wav.exists() {
            if hound::WavReader::open(&wav)
                .map_err(|e| format!("recovery_wav_failed: {e}"))?
                .duration()
                == 0
            {
                return Err("capture_audio_empty".into());
            }
            let temp = session.join(format!("audio.{}.mp3.tmp", uuid::Uuid::new_v4()));
            anlg_mp3::encode_wav(&wav, &temp)
                .map_err(|e| format!("recovery_encode_failed: {e}"))?;
            std::fs::File::open(&temp)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
            std::fs::rename(&temp, &mp3).map_err(|e| e.to_string())?;
            std::fs::File::open(session)
                .and_then(|dir| dir.sync_all())
                .map_err(|e| e.to_string())?;
        } else if session.join("audio.ogg").exists() {
            return Err("unsupported_capture_format".into());
        } else {
            return Err("capture_audio_missing".into());
        }
    }
    if std::fs::metadata(&mp3).map_err(|e| e.to_string())?.len() == 0 {
        return Err("capture_audio_empty".into());
    }
    Ok(mp3)
}

fn empty_capture(error: &str) -> bool {
    matches!(error, "capture_audio_missing" | "capture_audio_empty")
}

fn recorded_after_segment(recorded_before: u64, elapsed: u64, empty: bool) -> u64 {
    recorded_before.saturating_add(if empty { 0 } else { elapsed })
}

fn empty_segment_span(closed_at: u64, elapsed: u64, at_audio_ms: u64) -> journal::MissingAudioSpan {
    journal::MissingAudioSpan {
        kind: "omitted".into(),
        reason: "stalled".into(),
        started_at: closed_at.saturating_sub(elapsed),
        ended_at: Some(closed_at),
        at_audio_ms,
        audio_ms: 0,
    }
}

#[tauri::command]
pub async fn recorder_pause(app: tauri::AppHandle) -> Result<CaptureStatus, String> {
    super::ensure(&app);
    let (id, segment_id, stop_at, elapsed, recorded_before, closed_at) = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock();
        if state.busy {
            return Err("recorder_busy".into());
        }
        let id = state.id.clone().ok_or("no_recording")?;
        native_step(&state, Request::Pause)?;
        let segment_id = state.segment_id.clone().ok_or("already_paused")?;
        state.busy = true;
        let stop_at = mono_ms();
        (
            id,
            segment_id,
            stop_at,
            state.recorder.segment_ms(stop_at),
            state.recorder.recorded_ms(),
            now_ms(),
        )
    };
    if let Err(stall) = end_segment(&app, &segment_id, elapsed).await {
        return Err(stall_stop(&app, stop_at, stall, None));
    }
    let handle = app.clone();
    let import_id = id.clone();
    let import_segment_id = segment_id.clone();
    let completion = run_segment_import(move || {
        let current = journal::load(&handle)?.ok_or("capture_journal_missing")?;
        let mut skipped_empty = false;
        let result = match import_finished_segment(
            &handle,
            &import_segment_id,
            &import_id,
            current.system_audio,
            current.layout,
        ) {
            Err(error) if empty_capture(&error) => {
                skipped_empty = true;
                files::remove_source_session(
                    &files::sessions_root(&handle)?,
                    &import_segment_id,
                )
            }
            result => result,
        };
        if let Err(error) = result {
            journal::save_failed(
                &handle,
                &journal::FailedSegment {
                    id: import_id,
                    segment_id: import_segment_id,
                    reason: "write_failed".into(),
                    error,
                    journal: current.clone(),
                    quarantined_journal: None,
                },
            )?;
        }
        let recorded_ms = recorded_after_segment(recorded_before, elapsed, skipped_empty);
        let mut spans = current.spans.clone();
        if skipped_empty && elapsed > 0 {
            spans.push(empty_segment_span(closed_at, elapsed, recorded_before));
        }
        journal::save(
            &handle,
            &journal::Journal {
                segment_id: None,
                recorded_ms,
                spans: spans.clone(),
                ..current
            },
        )?;
        Ok((skipped_empty, spans))
    })
    .await;
    let (skipped_empty, spans) = match completion {
        Ok(saved) => saved,
        Err(error) => {
            clear_busy(&app);
            return Err(error);
        }
    };
    let outcome = if skipped_empty {
        Stop::Empty
    } else {
        Stop::SessionFinalized
    };
    let status = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock();
        state.busy = false;
        // Confirmed and Empty always close an open segment.
        let _ = state.recorder.stop_outcome(stop_at, outcome);
        state.spans = spans;
        state.segment_id = None;
        state.status()
    };
    reset_meter(&app);
    emit_status(&app);
    Ok(status)
}

#[tauri::command]
pub async fn recorder_resume(app: tauri::AppHandle) -> Result<CaptureStatus, String> {
    super::ensure(&app);
    super::extras::load_system_audio(&app).await?;
    let stop_first = {
        let engine = app.state::<Engine>();
        let state = engine.0.lock();
        if state.id.is_none() {
            return Err("no_recording".into());
        }
        native_step(&state, Request::Resume)? == Step::StopSource
    };
    if stop_first {
        recorder_pause(app.clone()).await?;
    }
    let input = recording_input(&app).await?;
    let (segment_id, input) = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock();
        if state.id.is_none() {
            return Err("no_recording".into());
        }
        // A failed earlier segment cannot be appended after a later segment.
        // Keep the mic released until recovery or discard resolves the failure.
        if journal::list_failed(&app)?
            .iter()
            .any(|failed| Some(&failed.id) == state.id.as_ref())
        {
            return Err("recovery_pending".into());
        }
        if native_step(&state, Request::Resume)? != Step::StartSource {
            return Err("already_recording".into());
        }
        begin(&mut state, input)?
    };
    let previous_result =
        journal::load(&app).and_then(|journal| journal.ok_or("capture_journal_missing".into()));
    if previous_result.is_err() {
        clear_busy(&app);
    }
    let previous = previous_result?;
    app.state::<Engine>().0.lock().layout = previous.layout;
    let segment_enabled = segment_system_audio(
        previous.layout,
        app.state::<Arc<AtomicBool>>().load(Ordering::SeqCst),
    );
    app.state::<Arc<AtomicBool>>()
        .store(segment_enabled, Ordering::SeqCst);
    let saved = journal::save(
        &app,
        &journal::Journal {
            segment_id: Some(segment_id.clone()),
            system_audio: segment_enabled,
            ..previous.clone()
        },
    );
    if saved.is_err() {
        clear_busy(&app);
    }
    saved?;
    let result = start_segment(&app, &segment_id, input).await;
    let cleanup = if result.is_err() {
        journal::save(&app, &previous)
    } else {
        Ok(())
    };
    if let Err(error) = &result {
        let reason = if error.starts_with("unsafe_sessions_folder:") {
            "unsafe_sessions_folder"
        } else if error.starts_with("session_exists:") {
            "session_exists"
        } else {
            "mic_unavailable"
        };
        let engine = app.state::<Engine>();
        let mut state = engine.0.lock();
        state.busy = false;
        let _ = state.recorder.start_outcome(mono_ms(), Start::Failed(reason));
        drop(state);
        emit_status(&app);
        cleanup?;
        return Err(reason.into());
    }
    let status = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock();
        state.busy = false;
        result?;
        state
            .recorder
            .start_outcome(mono_ms(), Start::Opened)
            .map_err(|error| error.code().to_owned())?;
        state.segment_id = Some(segment_id);
        cleanup?;
        state.status()
    };
    reset_meter(&app);
    emit_status(&app);
    Ok(status)
}

#[tauri::command]
pub async fn recorder_stop(app: tauri::AppHandle) -> Result<CaptureStatus, String> {
    super::ensure(&app);
    let step = {
        let engine = app.state::<Engine>();
        let state = engine.0.lock();
        if state.id.is_none() {
            return Err("no_recording".into());
        }
        native_step(&state, Request::Stop)?
    };
    if let Some(id) = app.state::<Engine>().0.lock().id.as_deref() {
        tracing::info!(target: "exo_dev::recorder", kind = "pipeline", source_id = %id, operation = "recorder", phase = "stop");
    }
    if step == Step::StopSource {
        recorder_pause(app.clone()).await?;
    }
    // JS acknowledges the journal only after its durable metadata commit.
    let status = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock();
        if state.id.is_none() {
            return Err("no_recording".into());
        }
        let mut status = state.status();
        status.state = "idle";
        status.intent = "stopped";
        status.reason = if state.auto_stop_requested {
            Some("max_duration")
        } else {
            None
        };
        state
            .recorder
            .finish()
            .map_err(|error| error.code().to_owned())?;
        state.id = None;
        state.layout = journal::Layout::Mono;
        state.started_at = None;
        state.spans.clear();
        state.last_stop_reason = status.reason;
        status
    };
    emit_status(&app);
    Ok(status)
}

/// Stop at the durable source boundary. Encoding and import are owned by
/// recorder_finish, while the source pointer remains in the stop journal.
#[tauri::command]
pub async fn recorder_stop_durable(app: tauri::AppHandle) -> Result<CaptureStatus, String> {
    super::ensure(&app);
    let (id, segment_id, stop_at, elapsed, recorded_before) = {
        let engine = app.state::<Engine>();
        let mut state = engine.0.lock();
        if state.busy {
            return Err("recorder_busy".into());
        }
        let id = state.id.clone().ok_or("no_recording")?;
        if native_step(&state, Request::Stop)? == Step::Done {
            return Err("already_paused".into());
        }
        let segment_id = state.segment_id.clone().ok_or("already_paused")?;
        state.busy = true;
        let stop_at = mono_ms();
        (
            id,
            segment_id,
            stop_at,
            state.recorder.segment_ms(stop_at),
            state.recorder.recorded_ms(),
        )
    };
    app.listener().stop_capture().await;
    let (empty, source_unconfirmed) = match durable_source(&app, &segment_id).await {
        Ok(()) => (false, false),
        Err(DurableError::Empty) => (true, false),
        Err(error) => {
            let (stall, detail) = match error {
                DurableError::Stall(stall) => (stall, None),
                DurableError::Failed(error) => (Stall::SourceUnusable, Some(error)),
                DurableError::Empty => unreachable!("empty outcome handled above"),
            };
            let exhausted = {
                let engine = app.state::<Engine>();
                let mut state = engine.0.lock();
                let _ = state
                    .recorder
                    .stop_outcome(stop_at, Stop::Stalled(stall));
                let exhausted = state.recorder.can_finish_unconfirmed();
                if exhausted {
                    state.capture_source_unconfirmed = true;
                } else {
                    state.busy = false;
                }
                exhausted
            };
            if exhausted {
                // Preserve the source session: bytes may be recoverable even
                // though listener finalization was not observed.
                (false, true)
            } else {
                emit_status(&app);
                return Err(detail.unwrap_or_else(|| RecorderError::Stalled(stall).code().to_owned()));
            }
        }
    };

    let handle = app.clone();
    let stop_id = id.clone();
    let stop_segment = segment_id.clone();
    let pointer = run_source_step(move || {
        let mut pointer = journal::load(&handle)?.ok_or("capture_journal_missing")?;
        if pointer.id != stop_id || pointer.segment_id.as_deref() != Some(&stop_segment) {
            return Err("capture_journal_mismatch".into());
        }
        pointer.recorded_ms = recorded_after_segment(recorded_before, elapsed, empty);
        pointer.capture_source_unconfirmed = source_unconfirmed;
        if empty {
            pointer.segment_id = None;
            if elapsed > 0 {
                pointer
                    .spans
                    .push(empty_segment_span(now_ms(), elapsed, recorded_before));
            }
            files::remove_source_session(&files::sessions_root(&handle)?, &stop_segment)?;
        }
        journal::save_stopped(&handle, &pointer)?;
        super::refresh_finishing_quit(&handle)?;
        journal::clear(&handle)?;
        Ok(pointer)
    })
    .await;
    let pointer = match pointer {
        Ok(pointer) => pointer,
        Err(error) => {
            clear_busy(&app);
            return Err(error);
        }
    };
    let outcome = if empty { Stop::Empty } else { Stop::SessionFinalized };
    let status = {
        let engine = app.state::<Engine>();
        let mut state = engine.0.lock();
        state.busy = false;
        // Unconfirmed source stays represented as potentially recording.
        if source_unconfirmed {
            let _ = state.recorder.finish_unconfirmed(stop_at);
        } else {
            let _ = state.recorder.stop_outcome(stop_at, outcome);
        }
        let mut status = state.status();
        status.state = "idle";
        status.intent = if source_unconfirmed { "recording" } else { "stopped" };
        status.reason = if source_unconfirmed {
            None
        } else if state.auto_stop_requested {
            Some("max_duration")
        } else {
            None
        };
        status.audio_ms = pointer.recorded_ms;
        status.elapsed_ms = pointer.recorded_ms;
        let _ = state.recorder.finish();
        state.id = None;
        state.layout = journal::Layout::Mono;
        state.started_at = None;
        state.segment_id = None;
        state.spans.clear();
        state.last_stop_reason = status.reason;
        status
    };
    tracing::info!(target: "exo_dev::recorder", kind = "pipeline", source_id = %id,
        operation = "recorder", phase = "source_durable");
    emit_status(&app);
    Ok(status)
}

#[tauri::command]
pub async fn recorder_finish(app: tauri::AppHandle, id: String) -> Result<u64, String> {
    super::ensure(&app);
    let handle = app.clone();
    let lookup_id = id.clone();
    let pointer = run_source_step(move || {
        journal::load_stopped(&handle, &lookup_id)?.ok_or("capture_journal_missing".into())
    })
    .await?;
    if pointer.id != id {
        return Err("capture_journal_mismatch".into());
    }
    let Some(segment_id) = pointer.segment_id.clone() else {
        return files::audio_file_size(app, id).await;
    };
    if pointer.capture_source_unconfirmed {
        // Import only a separately retained, complete WAV snapshot. The live
        // writer must not be read while its source-release state is unknown.
        let retained = files::sessions_root(&app)?.join(&segment_id).join("audio.exo-source.wav");
        if !retained.exists() {
            return Err(recorder_state::UNCONFIRMED_STOP_REASON.into());
        }
    } else {
        wait_finalization(&app, &segment_id, pointer.recorded_ms)
            .await
            .map_err(|stall| RecorderError::Stalled(stall).code().to_owned())?;
    }
    let handle = app.clone();
    let import_id = id.clone();
    let import_segment = segment_id.clone();
    let system_audio = pointer.system_audio;
    let layout = pointer.layout;
    run_segment_import(move || {
        if journal::load_stopped(&handle, &import_id)?.is_none() {
            return Err("capture_discarded".into());
        }
        let result =
            import_finished_segment(&handle, &import_segment, &import_id, system_audio, layout);
        if let Err(error) = &result {
            if empty_capture(error) {
                files::remove_source_session(&files::sessions_root(&handle)?, &import_segment)?;
                let mut ready = pointer;
                ready.segment_id = None;
                journal::save_stopped(&handle, &ready)?;
                return Ok(());
            }
            journal::save_failed(
                &handle,
                &journal::FailedSegment {
                    id: import_id,
                    segment_id: import_segment,
                    reason: "write_failed".into(),
                    error: error.clone(),
                    journal: pointer,
                    quarantined_journal: None,
                },
            )?;
        }
        result
    })
    .await?;
    tracing::info!(target: "exo_dev::recorder", kind = "pipeline", source_id = %id,
        operation = "recorder", phase = "audio_ready");
    files::audio_file_size(app, id).await
}

#[cfg(test)]
mod durable_stop_tests {
    use super::{
        capture_source_release_observed, empty_segment_span, recorded_after_segment,
        retain_stopped_source, source_mp3,
    };
    use std::io::Write;
    use std::time::{Duration, Instant};

    #[test]
    fn release_poller_clears_only_on_a_false_system_running_signal() {
        assert!(!capture_source_release_observed(false, Some(false)));
        assert!(!capture_source_release_observed(true, None));
        assert!(!capture_source_release_observed(true, Some(true)));
        assert!(capture_source_release_observed(true, Some(false)));
    }
    fn sparse_wav(path: &std::path::Path, minutes: u64, finalized: bool) {
        let data_bytes = minutes * 60 * 48_000 * 8;
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(
            &(if finalized {
                (data_bytes + 36) as u32
            } else {
                36
            })
            .to_le_bytes(),
        )
        .unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&3u16.to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&48_000u32.to_le_bytes()).unwrap();
        file.write_all(&384_000u32.to_le_bytes()).unwrap();
        file.write_all(&8u16.to_le_bytes()).unwrap();
        file.write_all(&32u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&(data_bytes as u32).to_le_bytes()).unwrap();
        file.set_len(data_bytes + 44).unwrap();
    }

    #[test]
    fn source_receipt_waits_for_closed_header_and_retains_audio_after_upstream_unlink() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        sparse_wav(&wav, 1, false);
        assert!(!retain_stopped_source(dir.path()).unwrap());
        sparse_wav(&wav, 1, true);
        assert!(!retain_stopped_source(dir.path()).unwrap());
        std::fs::write(dir.path().join("audio.exo-source-ready"), b"durable\n").unwrap();
        assert!(retain_stopped_source(dir.path()).unwrap());
        std::fs::remove_file(wav).unwrap();
        assert_eq!(
            std::fs::metadata(dir.path().join("audio.exo-source.wav"))
                .unwrap()
                .len(),
            60 * 48_000 * 8 + 44
        );
    }

    #[test]
    fn final_empty_segment_does_not_extend_a_previously_recorded_note() {
        assert_eq!(recorded_after_segment(60_000, 800, true), 60_000);
        let span = empty_segment_span(100_800, 800, 60_000);
        assert_eq!(span.at_audio_ms, 60_000);
        assert_eq!(span.audio_ms, 0);
    }

    #[test]
    fn completed_upstream_mp3_is_used_without_reencoding_retained_wav() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("audio.exo-source.wav"), b"retained").unwrap();
        let mp3 = dir.path().join("audio.mp3");
        std::fs::write(&mp3, b"completed upstream mp3").unwrap();
        assert_eq!(source_mp3(dir.path()).unwrap(), mp3);
        assert!(!dir.path().join("audio.exo-recovered.mp3").exists());
    }

    #[test]
    fn sparse_duration_fixtures_measure_local_source_boundary() {
        for minutes in [1, 30, 180] {
            let dir = tempfile::tempdir().unwrap();
            sparse_wav(&dir.path().join("audio.wav"), minutes, true);
            std::fs::write(dir.path().join("audio.exo-source-ready"), b"durable\n").unwrap();
            let started = Instant::now();
            assert!(retain_stopped_source(dir.path()).unwrap());
            let elapsed = started.elapsed();
            eprintln!(
                "durable_source_boundary duration={minutes}m elapsed_ms={}",
                elapsed.as_millis()
            );
            assert!(
                elapsed <= Duration::from_secs(1),
                "{minutes}m source boundary took {elapsed:?}"
            );
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    journal: Option<journal::Journal>,
    stopped: Vec<journal::Journal>,
    quarantined: Vec<journal::FailedSegment>,
}

#[tauri::command]
pub async fn recorder_stopped_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    run_source_step(move || {
        Ok(journal::list_stopped(&app)?
            .into_iter()
            .map(|entry| entry.id)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn recorder_recover(app: tauri::AppHandle) -> Result<RecoveryReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        super::with_import_lock(|| {
            if app.state::<Engine>().0.lock().id.is_some() {
                return Err("recording_in_progress".into());
            }
            let mut pending = journal::load(&app)?;
            if let Some(ref mut current) = pending {
                if !files::valid_recording_id(&current.id) {
                    return Err("invalid_recording_id".into());
                }
                if let Some(segment_id) = current.segment_id.clone() {
                    if !files::valid_recording_id(&segment_id) {
                        return Err("invalid_segment_id".into());
                    }
                    if !journal::list_failed(&app)?
                        .iter()
                        .any(|failed| failed.segment_id == segment_id)
                    {
                        match import_finished_segment(
                            &app,
                            &segment_id,
                            &current.id,
                            current.system_audio,
                            current.layout,
                        ) {
                            Err(error) if empty_capture(&error) => {
                                files::remove_source_session(
                                    &files::sessions_root(&app)?,
                                    &segment_id,
                                )?;
                            }
                            Err(error) => journal::save_failed(
                                &app,
                                &journal::FailedSegment {
                                    id: current.id.clone(),
                                    segment_id: segment_id.clone(),
                                    reason: "write_failed".into(),
                                    error,
                                    journal: current.clone(),
                                    quarantined_journal: None,
                                },
                            )?,
                            Ok(()) => (),
                        }
                    }
                    current.segment_id = None;
                    journal::save(&app, current)?;
                }
            }
            let stopped = journal::list_stopped(&app)?;
            for current in &stopped {
                recover_stopped_segment(&app, current)?;
            }
            Ok(RecoveryReport {
                journal: pending,
                stopped,
                quarantined: journal::list_failed(&app)?,
            })
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn recorder_acknowledge(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        super::with_import_lock(|| {
            if let Some(stopped) = journal::load_stopped(&app, &id)? {
                if let Some(segment_id) = stopped.segment_id {
                    if !files::segment_imported(&app, &id, &segment_id)? {
                        return Err("journal_not_ready".into());
                    }
                }
                // A kill can land after save_stopped but before the active
                // journal is cleared. Its matching pointer must not block Start.
                journal::clear_active_if_matches(&app, &id)?;
                journal::clear_stopped(&app, &id)?;
                super::refresh_finishing_quit(&app)?;
                return Ok(());
            }
            if app.state::<Engine>().0.lock().id.is_some() {
                return Err("recording_in_progress".into());
            }
            let Some(pending) = journal::load(&app)? else {
                return Ok(());
            };
            if pending.id != id || pending.segment_id.is_some() {
                return Err("journal_not_ready".into());
            }
            journal::clear(&app)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn recorder_failed_list(
    app: tauri::AppHandle,
) -> Result<Vec<journal::FailedSegment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        super::with_import_lock(|| journal::list_failed(&app))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn recorder_failed_retry(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<journal::FailedSegment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        super::with_import_lock(|| {
            for failed in journal::list_failed(&app)?
                .into_iter()
                .filter(|item| item.id == id)
            {
                if failed.quarantined_journal.is_some() {
                    match journal::retry_quarantined(&app, &failed, |current| {
                        recover_stopped_segment(&app, current)
                    }) {
                        Ok(()) => (),
                        Err(error) => {
                            journal::save_failed(&app, &journal::FailedSegment { error, ..failed })?
                        }
                    }
                    continue;
                }
                match import_finished_segment(
                    &app,
                    &failed.segment_id,
                    &id,
                    failed.journal.system_audio,
                    failed.journal.layout,
                ) {
                    Ok(()) => journal::remove_failed(&app, &failed.segment_id)?,
                    Err(error) if empty_capture(&error) => {
                        files::remove_source_session(
                            &files::sessions_root(&app)?,
                            &failed.segment_id,
                        )?;
                        journal::remove_failed_source(&app, &failed.segment_id)?;
                        journal::remove_failed(&app, &failed.segment_id)?;
                    }
                    Err(error) => {
                        journal::save_failed(&app, &journal::FailedSegment { error, ..failed })?
                    }
                }
            }
            Ok(journal::list_failed(&app)?
                .into_iter()
                .filter(|item| item.id == id)
                .collect())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn recover_stopped_segment(
    app: &tauri::AppHandle,
    current: &journal::Journal,
) -> Result<(), String> {
    let Some(segment_id) = current.segment_id.as_deref() else {
        return Ok(());
    };
    if journal::list_failed(app)?
        .iter()
        .any(|failed| failed.segment_id == segment_id)
    {
        return Ok(());
    }
    if let Err(error) = import_finished_segment(
        app,
        segment_id,
        &current.id,
        current.system_audio,
        current.layout,
    ) {
        if empty_capture(&error) {
            files::remove_source_session(&files::sessions_root(app)?, segment_id)?;
            let mut ready = current.clone();
            ready.segment_id = None;
            journal::save_stopped(app, &ready)?;
        } else {
            journal::save_failed(
                app,
                &journal::FailedSegment {
                    id: current.id.clone(),
                    segment_id: segment_id.into(),
                    reason: "write_failed".into(),
                    error,
                    journal: current.clone(),
                    quarantined_journal: None,
                },
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn recorder_failed_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        super::with_import_lock(|| journal::delete_failed_for_note(&app, &id))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn recorder_status(app: tauri::AppHandle) -> CaptureStatus {
    super::ensure(&app);
    app.state::<Engine>().0.lock().status()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inputs {
    inputs: Vec<Input>,
    selected_id: Option<String>,
    active_id: Option<String>,
    selected_missing: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct Input {
    id: String,
    name: String,
    kind: &'static str,
}

#[tauri::command]
pub async fn recorder_list_inputs(app: tauri::AppHandle) -> Result<Inputs, String> {
    super::ensure(&app);
    let devices = app
        .listener()
        .list_microphone_devices()
        .await
        .map_err(|e| e.to_string())?;
    let active = app
        .listener()
        .get_current_microphone_device()
        .await
        .ok()
        .flatten();
    let selected = super::extras::microphone(&app).await?;
    let recording = app.state::<Engine>().0.lock().segment_id.is_some();
    let resolved = resolve_input(
        &devices,
        selected.as_deref(),
        default_input_name().as_deref(),
    );
    Ok(Inputs {
        inputs: devices
            .into_iter()
            .map(|name| Input {
                id: name.clone(),
                kind: input_kind(&name),
                name,
            })
            .collect(),
        selected_id: selected,
        active_id: if recording { active } else { None }
            .or_else(|| resolved.as_ref().ok().map(|(name, _)| name.clone())),
        selected_missing: resolved.ok().and_then(|(_, missing)| missing),
    })
}

fn default_input_name() -> Option<String> {
    cpal::default_host()
        .default_input_device()
        .and_then(|device| {
            device
                .description()
                .ok()
                .map(|description| description.name().to_string())
        })
}

fn resolve_input(
    devices: &[String],
    selected: Option<&str>,
    default: Option<&str>,
) -> Result<(String, Option<String>), String> {
    if devices.is_empty() {
        return Err("mic_unavailable".into());
    }
    if let Some(name) = selected {
        if devices.iter().any(|device| device == name) {
            return Ok((name.into(), None));
        }
    }
    let fallback = default
        .filter(|name| devices.iter().any(|device| device == name))
        .unwrap_or(&devices[0]);
    Ok((fallback.into(), selected.map(str::to_owned)))
}

async fn recording_input(app: &tauri::AppHandle) -> Result<String, String> {
    let devices = app
        .listener()
        .list_microphone_devices()
        .await
        .map_err(|e| e.to_string())?;
    let selected = super::extras::microphone(app).await?;
    resolve_input(
        &devices,
        selected.as_deref(),
        default_input_name().as_deref(),
    )
    .map(|(name, _)| name)
}

fn input_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("bluetooth") || lower.contains("airpods") {
        "bluetooth"
    } else if lower.contains("usb") {
        "usb"
    } else if lower.contains("built-in") || lower.contains("macbook") {
        "built_in"
    } else if lower.contains("headset") || lower.contains("headphone") {
        "wired"
    } else {
        "other"
    }
}

#[tauri::command]
pub async fn recorder_select_input(
    app: tauri::AppHandle,
    id: Option<String>,
) -> Result<(), String> {
    super::ensure(&app);
    if let Some(ref id) = id {
        let devices = app
            .listener()
            .list_microphone_devices()
            .await
            .map_err(|e| e.to_string())?;
        if !devices.contains(id) {
            return Err("input_unavailable".into());
        }
    }
    let was_recording = app.state::<Engine>().0.lock().segment_id.is_some();
    if was_recording {
        recorder_pause(app.clone()).await?;
    }
    super::extras::set_microphone(&app, id).await?;
    if was_recording {
        recorder_resume(app.clone()).await?;
    }
    let _ = app.emit(INPUTS_EVENT, recorder_list_inputs(app.clone()).await?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layout_stays_fixed_across_both_system_audio_toggle_directions() {
        assert!(!segment_system_audio(journal::Layout::Stereo, false));
        assert!(segment_system_audio(journal::Layout::Stereo, true));
        assert!(!segment_system_audio(journal::Layout::Mono, true));
        assert!(!segment_system_audio(journal::Layout::Mono, false));
    }
    #[test]
    fn selected_input_and_missing_fallback_use_fake_devices() {
        let devices = vec!["MacBook Pro Microphone".into(), "BlackHole 2ch".into()];
        let (selected, missing) = resolve_input(
            &devices,
            Some("BlackHole 2ch"),
            Some("MacBook Pro Microphone"),
        )
        .unwrap();
        assert_eq!(missing, None);
        let (_, routed) = begin(&mut EngineState::default(), selected).unwrap();
        assert_eq!(
            capture_params("segment", routed)
                .unwrap()
                .mic_device
                .as_deref(),
            Some("BlackHole 2ch")
        );
        assert_eq!(
            resolve_input(&devices, Some("Bose"), Some("MacBook Pro Microphone")),
            Ok(("MacBook Pro Microphone".into(), Some("Bose".into())))
        );
        assert_eq!(
            resolve_input(&[], Some("Bose"), None),
            Err("mic_unavailable".into())
        );
    }

    #[tokio::test]
    async fn retained_wav_is_encoded_off_the_calling_thread_without_deleting_the_source() {
        let dir = std::env::temp_dir().join(format!("exo-wav-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("audio.wav");
        let samples = [0_u8; 3_200]; // 100 ms of 16 kHz, 16-bit mono silence.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36_u32 + samples.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&16_000_u32.to_le_bytes());
        bytes.extend_from_slice(&32_000_u32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&samples);
        std::fs::write(&wav, bytes).unwrap();

        let caller = std::thread::current().id();
        let session = dir.clone();
        let (worker, encoded) =
            run_segment_import(move || Ok((std::thread::current().id(), source_mp3(&session))))
                .await
                .unwrap();
        assert_ne!(worker, caller);
        let mp3 = encoded.unwrap();
        assert!(std::fs::metadata(mp3).unwrap().len() > 0);
        assert!(wav.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn empty_resume_segment_is_skipped_without_touching_earlier_audio() {
        let dir = std::env::temp_dir().join(format!("exo-empty-resume-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let note = dir.join("note.mp3");
        std::fs::write(&note, b"earlier durable segment").unwrap();
        // The listener may never write a file before a crash immediately after Resume.
        assert!(empty_capture(
            &source_mp3(&dir.join("rec-empty")).unwrap_err()
        ));
        let resumed = dir.join("rec-empty-wav");
        std::fs::create_dir_all(&resumed).unwrap();
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        hound::WavWriter::create(resumed.join("audio.wav"), spec)
            .unwrap()
            .finalize()
            .unwrap();
        assert!(empty_capture(&source_mp3(&resumed).unwrap_err()));
        assert_eq!(std::fs::read(&note).unwrap(), b"earlier durable segment");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn empty_live_interval_keeps_recorded_time_and_marks_omission_position() {
        let prior_audio_ms = 1_500;
        let empty_interval_ms = 120_000;
        assert_eq!(
            recorded_after_segment(prior_audio_ms, empty_interval_ms, true),
            prior_audio_ms
        );
        assert_eq!(recorded_after_segment(prior_audio_ms, 500, false), 2_000);
        let ended_at = 500_000_u64;
        let span = empty_segment_span(ended_at, empty_interval_ms, prior_audio_ms);
        assert_eq!(span.kind, "omitted");
        assert_eq!(span.reason, "stalled");
        assert_eq!(span.ended_at.unwrap() - span.started_at, empty_interval_ms);
        assert_eq!(serde_json::to_value(&span).unwrap()["atAudioMs"], 1_500);
        assert_eq!(
            span.at_audio_ms,
            recorded_after_segment(prior_audio_ms, empty_interval_ms, true)
        );
    }
}
