//! Debug-only self-test for the anarlog transcription wiring.
//!
//! Two entry points, both debug-builds only:
//!
//! - `exo_desktop_smoke` command — a single `invoke` from the webview devtools
//!   exercises the same extension APIs the plugin commands use (AudioProvider
//!   state, the spawned RootActor, the local-stt models dir) before any
//!   recording is attempted.
//! - `EXO_SMOKE=1 cargo tauri dev --features transcription` — after startup the
//!   app additionally evals real `plugin:transcription|…` / `plugin:local-stt|…`
//!   invokes inside the webview (proving capability/ACL wiring, not just
//!   command registration) and prints the results to stderr.

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

/// Env-gated webview smoke: `EXO_SMOKE=1` runs real IPC invokes inside the live
/// webview and prints JSON to stderr. No-op otherwise; never compiled into
/// release builds (the module is `cfg(debug_assertions)`-gated).
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

        // Webview-side report: real invoke() calls through the IPC layer,
        // which is what exercises the injected capability's ACL. Results are
        // posted back over a throwaway localhost listener because
        // `webview.eval` can't return values.
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[EXO_SMOKE] listener bind failed: {e}");
                return;
            }
        };
        let port = listener.local_addr().unwrap().port();

        // The "main" window may not exist yet at setup; poll briefly.
        let webview = {
            let mut found = None;
            for _ in 0..60 {
                if let Some(w) = app_handle.get_webview_window("main") {
                    found = Some(w);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            match found {
                Some(w) => w,
                None => {
                    eprintln!("[EXO_SMOKE] main webview never appeared");
                    return;
                }
            }
        };

        // Wait for the app JS (and therefore __TAURI_INTERNALS__) to load.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let js = format!(
            r#"(async () => {{
  const i = window.__TAURI_INTERNALS__.invoke;
  const out = {{}};
  for (const [k, cmd, args] of [
    ["recorder_status", "recorder_status"],
    ["system_audio", "recorder_system_audio_get"],
    ["model_downloaded", "plugin:local-stt|is_model_downloaded", {{ model: "QuantizedTinyEn" }}],
    ["smoke_cmd", "exo_desktop_smoke"],
    ["emit_denied", "plugin:event|emit", {{ event: "plugin:transcription:capture-lifecycle-event", payload: null }}],
  ]) {{
    try {{ out[k] = await i(cmd, args); }}
    catch (e) {{ out[k] = "ERR:" + String(e); }}
  }}
  await fetch("http://127.0.0.1:{port}/report?d=" + encodeURIComponent(JSON.stringify(out)));
}})()"#
        );

        if let Err(e) = webview.eval(&js) {
            eprintln!("[EXO_SMOKE] webview eval failed: {e}");
            return;
        }

        // Block a thread on one HTTP request; the webview fetch carries the
        // JSON in the query string.
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::Read;
                let mut buf = [0u8; 16384];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let line = req.lines().next().unwrap_or("");
                eprintln!("[EXO_SMOKE] webview: {line}");
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
                    .map_err(|_| ());
            }
        });
    });
}

// write_all needs std::io::Write in scope for the thread above.
use std::io::Write;
