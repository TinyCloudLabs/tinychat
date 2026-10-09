//! Capture lifecycle over anarlog's recorder. Stop closes the current segment
//! and releases the microphone; resume opens a fresh native capture.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_settings::SettingsPluginExt;
use tauri_plugin_transcription::ListenerPluginExt;

use super::{audio_provider::Meter, files, journal};

const MIC_EVENT: &str = "exo://recorder-mic-state";
const LEVEL_EVENT: &str = "exo://recorder-level";
const AUTO_STOP_EVENT: &str = "exo://recorder-auto-stopped";
const MAX_DURATION_MS: u64 = 3 * 60 * 60 * 1000;
const MIN_DURATION_MS: u64 = 1_000;

#[derive(Default)]
pub struct Engine(pub Mutex<EngineState>);

#[derive(Default)]
pub struct EngineState {
    id: Option<String>,
    started_at: Option<u64>,
    segment_id: Option<String>,
    segment_started: Option<Instant>,
    recorded_ms: u64,
    paused_ms: u64,
    pause_started: Option<Instant>,
    selected_input: Option<String>,
    busy: bool,
    limit_ms: u64,
    auto_stop_requested: bool,
    blocked_reason: Option<&'static str>,
    last_stop_reason: Option<&'static str>,
}

#[derive(Serialize, Clone, Copy)]
pub struct Level {
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
}

pub fn install(app: &tauri::App) {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let (level, auto_stop) = {
                let engine = handle.state::<Engine>();
                let mut state = engine.0.lock().unwrap();
                if state.segment_id.is_none() {
                    (None, None)
                } else {
                    let meter = handle.state::<Arc<Mutex<Meter>>>();
                    let (sample_level, sample_peak) = meter.lock().unwrap().take();
                    let level = Level {
                        level: sample_level,
                        peak: sample_peak,
                    };
                    let auto_stop = if !state.busy
                        && !state.auto_stop_requested
                        && state.status().elapsed_ms >= state.limit_ms
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
                            },
                        );
                    } else {
                        let engine = app.state::<Engine>();
                        engine.0.lock().unwrap().auto_stop_requested = false;
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
    started_at: Option<u64>,
    elapsed_ms: u64,
    audio_ms: u64,
    paused_ms: u64,
    max_duration_ms: u64,
    intent: &'static str,
    availability: &'static str,
    at: u64,
    elapsed_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl EngineState {
    fn status(&self) -> CaptureStatus {
        let at = now_ms();
        let recording = self.segment_started.is_some();
        let paused = self.id.is_some() && !recording;
        let elapsed = self.recorded_ms
            + self
                .segment_started
                .map(|at| at.elapsed().as_millis() as u64)
                .unwrap_or(0);
        CaptureStatus {
            state: if self.blocked_reason.is_some() {
                "needs_user"
            } else if recording {
                "recording"
            } else if paused {
                "paused"
            } else {
                "idle"
            },
            reason: self.blocked_reason.or(if paused {
                Some("user")
            } else {
                self.last_stop_reason
            }),
            id: self.id.clone(),
            started_at: self.started_at,
            elapsed_ms: elapsed,
            audio_ms: elapsed,
            paused_ms: self.paused_ms
                + self
                    .pause_started
                    .map(|at| at.elapsed().as_millis() as u64)
                    .unwrap_or(0),
            max_duration_ms: if self.limit_ms == 0 {
                MAX_DURATION_MS
            } else {
                self.limit_ms
            },
            intent: if recording {
                "recording"
            } else if paused {
                "paused"
            } else {
                "stopped"
            },
            availability: if self.blocked_reason.is_some() {
                "blocked"
            } else {
                "available"
            },
            at,
            elapsed_at: at,
        }
    }
}

fn emit_status(app: &tauri::AppHandle) {
    let status = app.state::<Engine>().0.lock().unwrap().status();
    let _ = app.emit(MIC_EVENT, status);
}

fn clear_busy(app: &tauri::AppHandle) {
    let engine = app.state::<Engine>();
    engine.0.lock().unwrap().busy = false;
}

fn reset_meter(app: &tauri::AppHandle) {
    let meter = app.state::<Arc<Mutex<Meter>>>();
    meter.lock().unwrap().reset();
}

fn capture_params(
    segment_id: &str,
    mic_device: Option<String>,
) -> Result<tauri_plugin_transcription::CaptureParams, String> {
    serde_json::from_value(serde_json::json!({
        "session_id": segment_id,
        "languages": ["en"],
        "onboarding": false,
        "model": "",
        "base_url": "",
        "api_key": "",
        "keywords": [],
        "mic_device": mic_device,
        "transcription_mode": "batch",
    }))
    .map_err(|e| e.to_string())
}

fn begin(state: &mut EngineState) -> Result<(String, Option<String>), String> {
    if state.busy {
        return Err("recorder_busy".into());
    }
    state.busy = true;
    Ok((
        format!("rec-{}", uuid::Uuid::new_v4()),
        state.selected_input.clone(),
    ))
}

async fn start_segment(
    app: &tauri::AppHandle,
    segment_id: &str,
    input: Option<String>,
) -> Result<(), String> {
    let params = capture_params(segment_id, input)?;
    app.listener()
        .start_capture(params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn recorder_start(
    app: tauri::AppHandle,
    id: String,
    max_duration_ms: Option<u64>,
) -> Result<CaptureStatus, String> {
    if !files::valid_recording_id(&id) {
        return Err("invalid_recording_id".into());
    }
    if journal::load(&app)?.is_some() {
        return Err("recovery_pending".into());
    }
    let (segment_id, input) = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock().unwrap();
        if state.id.is_some() {
            return Err("recording_in_progress".into());
        }
        begin(&mut state)?
    };
    let started_at = now_ms();
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
            system_audio: app.state::<Arc<AtomicBool>>().load(Ordering::SeqCst),
        },
    );
    if saved.is_err() {
        clear_busy(&app);
    }
    saved?;
    let result = start_segment(&app, &segment_id, input).await;
    let cleanup = if result.is_err() {
        journal::clear(&app)
    } else {
        Ok(())
    };
    if result.is_err() {
        let engine = app.state::<Engine>();
        let mut state = engine.0.lock().unwrap();
        state.busy = false;
        state.blocked_reason = Some("mic_unavailable");
        drop(state);
        emit_status(&app);
        cleanup?;
        return Err("mic_unavailable".into());
    }
    let status = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock().unwrap();
        state.busy = false;
        result?;
        cleanup?;
        state.id = Some(id);
        state.started_at = Some(started_at);
        state.segment_id = Some(segment_id);
        state.segment_started = Some(Instant::now());
        state.recorded_ms = 0;
        state.paused_ms = 0;
        state.limit_ms = max_duration_ms
            .unwrap_or(MAX_DURATION_MS)
            .clamp(MIN_DURATION_MS, MAX_DURATION_MS);
        state.auto_stop_requested = false;
        state.blocked_reason = None;
        state.last_stop_reason = None;
        state.status()
    };
    reset_meter(&app);
    emit_status(&app);
    Ok(status)
}

async fn end_segment(
    app: &tauri::AppHandle,
    segment_id: &str,
    elapsed_ms: u64,
) -> Result<(), String> {
    app.listener().stop_capture().await;
    // The upstream WAV->MP3 encode scales with segment length. A snapshot call
    // errors on actor timeout, unlike get_capture_state's false "Inactive".
    let deadline = Instant::now() + Duration::from_secs(30 + elapsed_ms / 15_000);
    loop {
        match app.listener().get_capture_snapshot().await {
            Ok(snapshot)
                if snapshot.active_session_id.as_deref() != Some(segment_id)
                    && !snapshot
                        .finalizing_session_ids
                        .iter()
                        .any(|id| id == segment_id) =>
            {
                break
            }
            _ => (),
        }
        if Instant::now() >= deadline {
            return Err("capture_stop_timeout".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

fn import_finished_segment(
    app: &tauri::AppHandle,
    segment_id: &str,
    id: &str,
    system_audio: bool,
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
    files::import_segment(app, id, segment_id, &source_mp3(&session)?, system_audio)?;
    journal::remove_failed_source(app, segment_id)
}

fn source_mp3(session: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let mp3 = session.join("audio.mp3");
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
            anlg_mp3::encode_wav(&wav, &mp3).map_err(|e| format!("recovery_encode_failed: {e}"))?;
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

#[tauri::command]
pub async fn recorder_pause(app: tauri::AppHandle) -> Result<CaptureStatus, String> {
    let (id, segment_id) = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock().unwrap();
        if state.busy {
            return Err("recorder_busy".into());
        }
        let id = state.id.clone().ok_or("no_recording")?;
        let segment_id = state.segment_id.clone().ok_or("already_paused")?;
        state.busy = true;
        (id, segment_id)
    };
    let (elapsed, total_recorded) = {
        let state = app.state::<Engine>();
        let state = state.0.lock().unwrap();
        let elapsed = state
            .segment_started
            .map(|at| at.elapsed().as_millis() as u64)
            .unwrap_or(0);
        (elapsed, state.recorded_ms + elapsed)
    };
    let stopped = end_segment(&app, &segment_id, elapsed).await;
    let current = match journal::load(&app) {
        Ok(Some(current)) => current,
        Ok(None) => {
            clear_busy(&app);
            return Err("capture_journal_missing".into());
        }
        Err(error) => {
            clear_busy(&app);
            return Err(error);
        }
    };
    let result = stopped.and_then(|_| {
        match import_finished_segment(&app, &segment_id, &id, current.system_audio) {
            Err(error) if empty_capture(&error) && elapsed < 1_000 => {
                files::remove_source_session(&files::sessions_root(&app)?, &segment_id)
            }
            result => result,
        }
    });
    if result
        .as_ref()
        .err()
        .is_some_and(|error| error == "capture_stop_timeout")
    {
        let engine = app.state::<Engine>();
        let mut state = engine.0.lock().unwrap();
        state.busy = false;
        state.blocked_reason = Some("writer_stalled");
        drop(state);
        emit_status(&app);
        return Err("capture_stop_timeout".into());
    }
    if let Err(error) = result {
        let failed = journal::FailedSegment {
            id: id.clone(),
            segment_id: segment_id.clone(),
            reason: "write_failed".into(),
            error,
            journal: current.clone(),
        };
        if let Err(error) = journal::save_failed(&app, &failed) {
            clear_busy(&app);
            return Err(error);
        }
    }
    let saved = journal::save(
        &app,
        &journal::Journal {
            segment_id: None,
            recorded_ms: total_recorded,
            ..current
        },
    );
    if saved.is_err() {
        clear_busy(&app);
    }
    saved?;
    let status = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock().unwrap();
        state.busy = false;
        state.recorded_ms += elapsed;
        state.segment_id = None;
        state.segment_started = None;
        state.paused_ms += state
            .pause_started
            .take()
            .map(|at| at.elapsed().as_millis() as u64)
            .unwrap_or(0);
        state.pause_started = Some(Instant::now());
        state.blocked_reason = None;
        state.status()
    };
    reset_meter(&app);
    emit_status(&app);
    Ok(status)
}

#[tauri::command]
pub async fn recorder_resume(app: tauri::AppHandle) -> Result<CaptureStatus, String> {
    let incomplete_pause = {
        let engine = app.state::<Engine>();
        let state = engine.0.lock().unwrap();
        state.segment_id.is_some() && state.segment_started.is_none()
    };
    if incomplete_pause {
        recorder_pause(app.clone()).await?;
    }
    let (segment_id, input) = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock().unwrap();
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
        if state.segment_id.is_some() {
            return Err("already_recording".into());
        }
        begin(&mut state)?
    };
    let previous_result =
        journal::load(&app).and_then(|journal| journal.ok_or("capture_journal_missing".into()));
    if previous_result.is_err() {
        clear_busy(&app);
    }
    let previous = previous_result?;
    let saved = journal::save(
        &app,
        &journal::Journal {
            segment_id: Some(segment_id.clone()),
            system_audio: app.state::<Arc<AtomicBool>>().load(Ordering::SeqCst),
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
    if result.is_err() {
        let engine = app.state::<Engine>();
        let mut state = engine.0.lock().unwrap();
        state.busy = false;
        state.blocked_reason = Some("mic_unavailable");
        drop(state);
        emit_status(&app);
        cleanup?;
        return Err("mic_unavailable".into());
    }
    let status = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock().unwrap();
        state.busy = false;
        result.map_err(|_| "mic_unavailable")?;
        cleanup?;
        state.paused_ms += state
            .pause_started
            .take()
            .map(|at| at.elapsed().as_millis() as u64)
            .unwrap_or(0);
        state.segment_id = Some(segment_id);
        state.segment_started = Some(Instant::now());
        state.blocked_reason = None;
        state.status()
    };
    reset_meter(&app);
    emit_status(&app);
    Ok(status)
}

#[tauri::command]
pub async fn recorder_stop(app: tauri::AppHandle) -> Result<CaptureStatus, String> {
    if app.state::<Engine>().0.lock().unwrap().id.is_none() {
        return Err("no_recording".into());
    }
    let active = app.state::<Engine>().0.lock().unwrap().segment_id.is_some();
    if active {
        recorder_pause(app.clone()).await?;
    }
    // JS acknowledges the journal only after its durable metadata commit.
    let status = {
        let state = app.state::<Engine>();
        let mut state = state.0.lock().unwrap();
        if state.id.is_none() {
            return Err("no_recording".into());
        }
        state.paused_ms += state
            .pause_started
            .take()
            .map(|at| at.elapsed().as_millis() as u64)
            .unwrap_or(0);
        let mut status = state.status();
        status.state = "idle";
        status.intent = "stopped";
        status.reason = if state.auto_stop_requested {
            Some("max_duration")
        } else {
            None
        };
        state.id = None;
        state.started_at = None;
        state.recorded_ms = 0;
        state.blocked_reason = None;
        state.last_stop_reason = if state.auto_stop_requested {
            Some("max_duration")
        } else {
            None
        };
        status
    };
    emit_status(&app);
    Ok(status)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    journal: Option<journal::Journal>,
    quarantined: Vec<journal::FailedSegment>,
}

#[tauri::command]
pub fn recorder_recover(app: tauri::AppHandle) -> Result<RecoveryReport, String> {
    if app.state::<Engine>().0.lock().unwrap().id.is_some() {
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
                match import_finished_segment(&app, &segment_id, &current.id, current.system_audio)
                {
                    Err(error) if empty_capture(&error) => {
                        files::remove_source_session(&files::sessions_root(&app)?, &segment_id)?;
                    }
                    Err(error) => journal::save_failed(
                        &app,
                        &journal::FailedSegment {
                            id: current.id.clone(),
                            segment_id: segment_id.clone(),
                            reason: "write_failed".into(),
                            error,
                            journal: current.clone(),
                        },
                    )?,
                    Ok(()) => (),
                }
            }
            current.segment_id = None;
            journal::save(&app, current)?;
        }
    }
    Ok(RecoveryReport {
        journal: pending,
        quarantined: journal::list_failed(&app)?,
    })
}

#[tauri::command]
pub fn recorder_acknowledge(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if app.state::<Engine>().0.lock().unwrap().id.is_some() {
        return Err("recording_in_progress".into());
    }
    let Some(pending) = journal::load(&app)? else {
        return Ok(());
    };
    if pending.id != id || pending.segment_id.is_some() {
        return Err("journal_not_ready".into());
    }
    journal::clear(&app)
}

#[tauri::command]
pub fn recorder_failed_list(app: tauri::AppHandle) -> Result<Vec<journal::FailedSegment>, String> {
    journal::list_failed(&app)
}

#[tauri::command]
pub fn recorder_failed_retry(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<journal::FailedSegment>, String> {
    for failed in journal::list_failed(&app)?
        .into_iter()
        .filter(|item| item.id == id)
    {
        match import_finished_segment(&app, &failed.segment_id, &id, failed.journal.system_audio) {
            Ok(()) => journal::remove_failed(&app, &failed.segment_id)?,
            Err(error) if empty_capture(&error) => {
                files::remove_source_session(&files::sessions_root(&app)?, &failed.segment_id)?;
                journal::remove_failed_source(&app, &failed.segment_id)?;
                journal::remove_failed(&app, &failed.segment_id)?;
            }
            Err(error) => journal::save_failed(&app, &journal::FailedSegment { error, ..failed })?,
        }
    }
    Ok(journal::list_failed(&app)?
        .into_iter()
        .filter(|item| item.id == id)
        .collect())
}

#[tauri::command]
pub fn recorder_failed_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    journal::delete_failed_for_note(&app, &id)
}

#[tauri::command]
pub fn recorder_status(app: tauri::AppHandle) -> CaptureStatus {
    app.state::<Engine>().0.lock().unwrap().status()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inputs {
    inputs: Vec<Input>,
    selected_id: Option<String>,
    active_id: Option<String>,
}
#[derive(Serialize)]
pub struct Input {
    id: String,
    name: String,
    kind: &'static str,
}

#[tauri::command]
pub async fn recorder_list_inputs(app: tauri::AppHandle) -> Result<Inputs, String> {
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
    let state = app.state::<Engine>();
    let state = state.0.lock().unwrap();
    Ok(Inputs {
        inputs: devices
            .into_iter()
            .map(|name| Input {
                id: name.clone(),
                kind: input_kind(&name),
                name,
            })
            .collect(),
        selected_id: state.selected_input.clone(),
        active_id: if state.segment_id.is_some() {
            active
        } else {
            None
        },
    })
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
    let was_recording = app.state::<Engine>().0.lock().unwrap().segment_id.is_some();
    if was_recording {
        recorder_pause(app.clone()).await?;
    }
    {
        let state = app.state::<Engine>();
        state.0.lock().unwrap().selected_input = id;
    }
    if was_recording {
        recorder_resume(app).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elapsed_excludes_pause() {
        let mut state = EngineState::default();
        state.id = Some("note".into());
        state.recorded_ms = 1_250;
        state.pause_started = Some(Instant::now() - Duration::from_secs(2));
        let status = state.status();
        assert_eq!(status.elapsed_ms, 1_250);
        assert!(status.paused_ms >= 2_000);
        assert_eq!(status.state, "paused");
        assert_eq!(status.reason, Some("user"));
    }

    #[test]
    fn retained_wav_is_encoded_without_deleting_the_source() {
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

        let mp3 = source_mp3(&dir).unwrap();
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
}
