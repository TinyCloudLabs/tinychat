//! Debug-only native report for the anarlog transcription wiring.
//! `EXO_SMOKE=1` prints it after startup; the webview ACL assertions live in
//! `ipc_selftest` and run in both debug and CI's opt-in release build.

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_local_stt::LocalSttPluginExt;
use tauri_plugin_transcription::ListenerPluginExt;

#[derive(Serialize)]
pub struct SmokeReport {
    /// `Arc<dyn AudioProvider>` is managed — the transcription plugin's setup
    /// panics without it, so this being true also proves plugin init ran.
    audio_provider_present: bool,
    /// Real CoreAudio device enumeration via the managed provider.
    mic_devices: Result<Vec<String>, String>,
    /// `Ok` means the global RootActor answered `GetSnapshot` — i.e. the
    /// plugin spawned it and the capture FSM is reachable. `Err` names the
    /// actor/startup failure.
    root_actor: Result<String, String>,
    /// Where whisper models will be written; should live under
    /// `~/Library/Application Support/xyz.tinycloud.exo` (vendored storage),
    /// never `anarlog`/`hyprnote`.
    models_dir: String,
    /// Whether the default model is already downloaded (false is fine — it
    /// proves the downloader path resolves without doing any I/O).
    default_model_downloaded: Result<bool, String>,
}

async fn collect(app: &tauri::AppHandle) -> SmokeReport {
    let audio_provider_present = app
        .try_state::<std::sync::Arc<dyn audio_actual::AudioProvider>>()
        .is_some();

    let mic_devices = if audio_provider_present {
        let audio = app.state::<std::sync::Arc<dyn audio_actual::AudioProvider>>();
        Ok(audio.inner().list_mic_devices())
    } else {
        Err("no AudioProvider managed".to_string())
    };

    // ActorNotFound here means the plugin setup spawned nothing.
    let root_actor = app
        .listener()
        .get_capture_snapshot()
        .await
        .map(|_| "root actor alive".to_string())
        .map_err(|e| e.to_string());

    let stt = app.local_stt();
    let models_dir = stt.models_dir().display().to_string();
    let default_model_downloaded = stt
        .is_model_downloaded(&tauri_plugin_local_stt::LocalModel::Whisper(
            tauri_plugin_local_stt::WhisperModel::QuantizedTinyEn,
        ))
        .await
        .map_err(|e| e.to_string());

    SmokeReport {
        audio_provider_present,
        mic_devices,
        root_actor,
        models_dir,
        default_model_downloaded,
    }
}

/// build.rs declares the app's commands in an ACL manifest, so even this
/// debug-only command needs a grant; it is added at runtime in debug builds.
pub const SMOKE_CAPABILITY: &str = r#"{
  "identifier": "debug-smoke",
  "description": "Debug builds only: the exo_desktop_smoke diagnostic command.",
  "windows": ["main"],
  "permissions": ["allow-exo-desktop-smoke"]
}"#;

#[tauri::command]
pub async fn exo_desktop_smoke(app: tauri::AppHandle) -> Result<SmokeReport, String> {
    Ok(collect(&app).await)
}

/// Optional debug-only native wiring report. ACL assertions live in
/// `ipc_selftest`, which also runs in CI's release profile.
pub fn maybe_run(app: &tauri::App) {
    if std::env::var_os("EXO_SMOKE").is_none() {
        return;
    }

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        // Direct (Rust-side) report first — independent of the webview.
        let report = collect(&app_handle).await;
        eprintln!(
            "[EXO_SMOKE] native: {}",
            serde_json::to_string(&report).unwrap_or_else(|e| e.to_string())
        );
    });
}
