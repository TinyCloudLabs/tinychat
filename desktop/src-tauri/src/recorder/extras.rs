//! Native persistence and model commands for DesktopCaptureExtras (D4).
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_local_stt::{LocalModel, LocalSttPluginExt, WhisperModel};
use tauri_plugin_settings::SettingsPluginExt;

const PROGRESS_EVENT: &str = "exo://recorder-model-progress";
const UPSTREAM_PROGRESS_EVENT: &str = "plugin:local-stt:download-progress-payload";
const MODEL_IDS: [&str; 7] = [
    "QuantizedTinyEn",
    "QuantizedTiny",
    "QuantizedBaseEn",
    "QuantizedBase",
    "QuantizedSmallEn",
    "QuantizedSmall",
    "QuantizedLargeTurbo",
];

#[derive(Default)]
pub struct ExtrasState {
    pub settings_lock: tokio::sync::Mutex<()>,
    pub progress: Mutex<HashMap<String, Progress>>,
    pub failures: Mutex<HashMap<String, String>>,
    pub watching: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    #[serde(default)]
    selected_model: Option<String>,
    #[serde(default)]
    system_audio: bool,
    #[serde(default)]
    auto_save_to_space: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    id: String,
    label: String,
    size_bytes: u64,
    downloaded: bool,
    selected: bool,
    downloading: bool,
    progress: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    id: String,
    fraction: f32,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn report_progress(app: &tauri::AppHandle, progress: Progress) {
    let state = app.state::<ExtrasState>();
    let mut current = state.progress.lock().unwrap();
    if !accept_progress(current.get(&progress.id), &progress) {
        return;
    }
    current.insert(progress.id.clone(), progress.clone());
    drop(current);
    let _ = app.emit(PROGRESS_EVENT, progress);
}

fn accept_progress(previous: Option<&Progress>, _next: &Progress) -> bool {
    !previous.is_some_and(|previous| previous.status != "downloading")
}

fn polled_terminal(
    downloaded: bool,
    downloading: bool,
    inactive_polls: u8,
) -> Option<&'static str> {
    if downloaded {
        Some("done")
    } else if !downloading && inactive_polls >= 1 {
        Some("error")
    } else {
        None
    }
}

fn watch_download(app: tauri::AppHandle, id: String) {
    if !app
        .state::<ExtrasState>()
        .watching
        .lock()
        .unwrap()
        .insert(id.clone())
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let model = parse_model(&id);
        let mut inactive = 0;
        // Downloads started by local transcription can outlive the recorder
        // window. Keep watching until the shared task really terminates.
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if app
                .state::<ExtrasState>()
                .progress
                .lock()
                .unwrap()
                .get(&id)
                .is_some_and(|p| p.status != "downloading")
            {
                break;
            }
            let result = match &model {
                Ok(model) => {
                    let downloaded = app.local_stt().is_model_downloaded(model).await;
                    let downloading = app.local_stt().is_model_downloading(model).await;
                    match (downloaded, downloading) {
                        (Ok(true), _) => Some(("done", None)),
                        (Ok(false), Ok(downloading)) => {
                            let terminal = polled_terminal(false, downloading, inactive);
                            inactive = if downloading { 0 } else { inactive + 1 };
                            terminal.map(|status| {
                                (status, Some("model_download_cancelled".to_string()))
                            })
                        }
                        (Err(error), _) | (_, Err(error)) => {
                            Some(("error", Some(error.to_string())))
                        }
                    }
                }
                Err(error) => Some(("error", Some(error.clone()))),
            };
            if let Some((status, error)) = result {
                let fraction = app
                    .state::<ExtrasState>()
                    .progress
                    .lock()
                    .unwrap()
                    .get(&id)
                    .map(|p| p.fraction)
                    .unwrap_or(0.0);
                report_progress(
                    &app,
                    Progress {
                        id: id.clone(),
                        fraction: if status == "done" { 1.0 } else { fraction },
                        status,
                        error,
                    },
                );
                break;
            }
        }
        app.state::<ExtrasState>()
            .watching
            .lock()
            .unwrap()
            .remove(&id);
    });
}

fn parse_model(id: &str) -> Result<LocalModel, String> {
    if !MODEL_IDS.contains(&id) {
        return Err("unsupported_model".into());
    }
    let model: WhisperModel = serde_json::from_value(serde_json::Value::String(id.into()))
        .map_err(|_| "unsupported_model".to_string())?;
    Ok(LocalModel::Whisper(model))
}

async fn preferences(app: &tauri::AppHandle) -> Result<Preferences, String> {
    let value = app.settings().load().await.map_err(|e| e.to_string())?;
    serde_json::from_value(
        value
            .get("exo_recorder")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .map_err(|e| e.to_string())
}

async fn save_preferences(
    app: &tauri::AppHandle,
    change: impl FnOnce(&mut Preferences),
) -> Result<Preferences, String> {
    let state = app.state::<ExtrasState>();
    let _guard = state.settings_lock.lock().await;
    let mut prefs = preferences(app).await?;
    change(&mut prefs);
    app.settings()
        .save(serde_json::json!({ "exo_recorder": prefs }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(prefs)
}

pub async fn load_system_audio(app: &tauri::AppHandle) -> Result<(), String> {
    let enabled = preferences(app).await?.system_audio;
    app.state::<Arc<AtomicBool>>()
        .store(enabled, Ordering::SeqCst);
    Ok(())
}

pub fn install(app: &tauri::App) {
    let handle = app.handle().clone();
    app.listen_any(UPSTREAM_PROGRESS_EVENT, move |event| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        let Some(id) = value["model"].as_str() else {
            return;
        };
        if !MODEL_IDS.contains(&id) {
            return;
        }
        if value["status"] == "completed" {
            watch_download(handle.clone(), id.to_string());
            return;
        }
        let fraction = value["status"]
            .get("downloading")
            .and_then(serde_json::Value::as_f64)
            .map(|percent| (percent / 100.0).clamp(0.0, 1.0) as f32);
        if let Some(fraction) = fraction {
            // A shared local-transcription download may start without calling
            // recorder_models_download. Its first event can already be > 0%.
            if !handle
                .state::<ExtrasState>()
                .watching
                .lock()
                .unwrap()
                .contains(id)
            {
                let state = handle.state::<ExtrasState>();
                let mut current = state.progress.lock().unwrap();
                if current.get(id).is_some_and(|p| p.status != "downloading") {
                    current.remove(id);
                }
            }
            report_progress(
                &handle,
                Progress {
                    id: id.into(),
                    fraction,
                    status: "downloading",
                    error: None,
                },
            );
            watch_download(handle.clone(), id.to_string());
        } else if let Some(error) = value["status"]
            .get("failed")
            .and_then(serde_json::Value::as_str)
        {
            handle
                .state::<ExtrasState>()
                .failures
                .lock()
                .unwrap()
                .insert(id.into(), error.into());
            let fraction = handle
                .state::<ExtrasState>()
                .progress
                .lock()
                .unwrap()
                .get(id)
                .map(|p| p.fraction)
                .unwrap_or(0.0);
            report_progress(
                &handle,
                Progress {
                    id: id.into(),
                    fraction,
                    status: "error",
                    error: Some(error.into()),
                },
            );
        }
    });
}

#[tauri::command]
pub async fn recorder_models_list(app: tauri::AppHandle) -> Result<Vec<ModelRow>, String> {
    let selected = preferences(&app).await?.selected_model;
    let mut rows = Vec::new();
    for id in MODEL_IDS {
        let model = parse_model(id)?;
        let info = tauri_plugin_local_stt::stt_model_info(&model);
        let downloaded = app
            .local_stt()
            .is_model_downloaded(&model)
            .await
            .map_err(|e| e.to_string())?;
        let downloading = !downloaded
            && app
                .local_stt()
                .is_model_downloading(&model)
                .await
                .map_err(|e| e.to_string())?;
        let progress = if downloading {
            app.state::<ExtrasState>()
                .progress
                .lock()
                .unwrap()
                .get(id)
                .filter(|p| p.status == "downloading")
                .map(|p| p.fraction)
        } else {
            None
        };
        rows.push(ModelRow {
            id: id.into(),
            label: info.display_name,
            size_bytes: info.size_bytes.unwrap_or(0),
            downloaded,
            selected: selected.as_deref() == Some(id),
            downloading,
            progress,
        });
    }
    Ok(rows)
}

#[tauri::command]
pub async fn recorder_models_get(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(preferences(&app).await?.selected_model)
}

#[tauri::command]
pub async fn recorder_models_select(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let model = parse_model(&id)?;
    if !app
        .local_stt()
        .is_model_downloaded(&model)
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("model_not_downloaded".into());
    }
    save_preferences(&app, |prefs| prefs.selected_model = Some(id)).await?;
    Ok(())
}

#[tauri::command]
pub fn recorder_models_progress(app: tauri::AppHandle) -> Vec<Progress> {
    app.state::<ExtrasState>()
        .progress
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

#[tauri::command]
pub async fn recorder_models_download(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let model = parse_model(&id)?;
    let result = download_model_until_done(app.clone(), id.clone(), model).await;
    if let Err(error) = &result {
        let fraction = app
            .state::<ExtrasState>()
            .progress
            .lock()
            .unwrap()
            .get(&id)
            .map(|p| p.fraction)
            .unwrap_or(0.0);
        report_progress(
            &app,
            Progress {
                id,
                fraction,
                status: "error",
                error: Some(error.clone()),
            },
        );
    }
    result
}

async fn download_model_until_done(
    app: tauri::AppHandle,
    id: String,
    model: LocalModel,
) -> Result<(), String> {
    if app
        .local_stt()
        .is_model_downloaded(&model)
        .await
        .map_err(|e| e.to_string())?
    {
        app.state::<ExtrasState>()
            .progress
            .lock()
            .unwrap()
            .remove(&id);
        report_progress(
            &app,
            Progress {
                id,
                fraction: 1.0,
                status: "done",
                error: None,
            },
        );
        return Ok(());
    }
    app.state::<ExtrasState>()
        .failures
        .lock()
        .unwrap()
        .remove(&id);
    let downloading = app
        .local_stt()
        .is_model_downloading(&model)
        .await
        .map_err(|e| e.to_string())?;
    if downloading {
        let state = app.state::<ExtrasState>();
        let mut progress = state.progress.lock().unwrap();
        if progress.get(&id).is_some_and(|p| p.status != "downloading") {
            progress.remove(&id);
        }
        if !progress.contains_key(&id) {
            drop(progress);
            report_progress(
                &app,
                Progress {
                    id: id.clone(),
                    fraction: 0.0,
                    status: "downloading",
                    error: None,
                },
            );
        }
    }
    if !downloading {
        app.state::<ExtrasState>()
            .progress
            .lock()
            .unwrap()
            .remove(&id);
        report_progress(
            &app,
            Progress {
                id: id.clone(),
                fraction: 0.0,
                status: "downloading",
                error: None,
            },
        );
        if let Err(error) = app.local_stt().download_model(model.clone()).await {
            let error = error.to_string();
            report_progress(
                &app,
                Progress {
                    id,
                    fraction: 0.0,
                    status: "error",
                    error: Some(error.clone()),
                },
            );
            return Err(error);
        }
    }
    let mut inactive_polls = 0;
    loop {
        if app
            .local_stt()
            .is_model_downloaded(&model)
            .await
            .map_err(|e| e.to_string())?
        {
            report_progress(
                &app,
                Progress {
                    id,
                    fraction: 1.0,
                    status: "done",
                    error: None,
                },
            );
            return Ok(());
        }
        if let Some(error) = app
            .state::<ExtrasState>()
            .failures
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
        {
            return Err(error);
        }
        if app
            .local_stt()
            .is_model_downloading(&model)
            .await
            .map_err(|e| e.to_string())?
        {
            inactive_polls = 0;
        } else {
            // Cancellation normally emits `failed`, but also catch a task that
            // exits without an upstream terminal event. Give the event loop a
            // second poll to deliver a more specific failure first.
            inactive_polls += 1;
            if inactive_polls >= 2 {
                return Err("model_download_cancelled".into());
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[tauri::command]
pub async fn recorder_system_audio_get(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(preferences(&app).await?.system_audio)
}

#[tauri::command]
pub async fn recorder_system_audio_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    // The live stream cannot change source mid-capture; this applies on next start/resume.
    save_preferences(&app, |prefs| prefs.system_audio = enabled).await?;
    app.state::<Arc<AtomicBool>>()
        .store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn recorder_auto_save_to_space_get(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(preferences(&app).await?.auto_save_to_space)
}

#[tauri::command]
pub async fn recorder_auto_save_to_space_set(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    save_preferences(&app, |prefs| prefs.auto_save_to_space = enabled).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_whisper_models_are_accepted() {
        assert!(MODEL_IDS.iter().all(|id| parse_model(id).is_ok()));
        assert!(parse_model("soniqo-parakeet-batch").is_err());
    }

    #[test]
    fn a_download_has_one_terminal_event() {
        let done = Progress {
            id: "QuantizedTinyEn".into(),
            fraction: 1.0,
            status: "done",
            error: None,
        };
        let error = Progress {
            id: done.id.clone(),
            fraction: 0.5,
            status: "error",
            error: Some("offline".into()),
        };
        assert!(accept_progress(None, &done));
        assert!(!accept_progress(Some(&done), &done));
        assert!(!accept_progress(Some(&done), &error));
    }

    #[test]
    fn shared_download_watcher_finishes_external_downloads_and_cancellations() {
        assert_eq!(polled_terminal(false, true, 0), None);
        assert_eq!(polled_terminal(false, false, 0), None);
        assert_eq!(polled_terminal(false, false, 1), Some("error"));
        assert_eq!(polled_terminal(true, false, 0), Some("done"));
        let downloading = Progress {
            id: "QuantizedTinyEn".into(),
            fraction: 0.4,
            status: "downloading",
            error: None,
        };
        let done = Progress {
            fraction: 1.0,
            status: "done",
            ..downloading.clone()
        };
        assert!(accept_progress(Some(&downloading), &done));
        assert!(!accept_progress(Some(&done), &done));
    }
}
