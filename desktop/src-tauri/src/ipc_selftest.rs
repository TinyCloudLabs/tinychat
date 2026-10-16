//! Assert real webview IPC permissions in debug or CI's opt-in release build.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_transcription::ListenerPluginExt;

const DENIED: &[&str] = &[
    "plugin:transcription|start_transcription",
    "plugin:transcription|start_capture",
    "plugin:transcription|list_microphone_devices",
    "plugin:transcription|stop_capture",
    "plugin:transcription|get_capture_state",
    "plugin:transcription|run_denoise",
    "plugin:transcription|parse_subtitle",
    "plugin:transcription|export_to_vtt",
    "plugin:transcription|extract_voiceprint_candidates",
    "plugin:transcription|set_mic_muted",
    "plugin:local-stt|delete_model",
    "plugin:local-stt|is_model_downloaded",
    "plugin:local-stt|download_model",
    "plugin:settings|set_vault_base",
    "plugin:settings|move_vault",
    "plugin:settings|copy_vault",
    "plugin:settings|save",
    "plugin:image|from_path",
    "plugin:menu|new",
    "plugin:tray|new",
    "plugin:event|emit",
    "plugin:event|emit_to",
    "local_capture_start",
    "local_transcription_start",
];

const SCRIPT: &str = r#"(async () => {
  const probes = [
    ["plugin:transcription|start_transcription", {}],
    ["plugin:transcription|start_capture", {}],
    ["plugin:transcription|list_microphone_devices", {}],
    ["plugin:transcription|stop_capture", {}],
    ["plugin:transcription|get_capture_state", {}],
    ["plugin:transcription|run_denoise", {}],
    ["plugin:transcription|parse_subtitle", {}],
    ["plugin:transcription|export_to_vtt", {}],
    ["plugin:transcription|extract_voiceprint_candidates", {}],
    ["plugin:transcription|set_mic_muted", {}],
    ["plugin:local-stt|delete_model", {}],
    ["plugin:local-stt|is_model_downloaded", {}],
    ["plugin:local-stt|download_model", {}],
    ["plugin:settings|set_vault_base", {}],
    ["plugin:settings|move_vault", {}],
    ["plugin:settings|copy_vault", {}],
    ["plugin:settings|save", {}],
    ["plugin:image|from_path", {}],
    ["plugin:menu|new", {}],
    ["plugin:tray|new", {}],
    ["plugin:event|emit", {}],
    ["plugin:event|emit_to", {}],
    ["local_capture_start", {}],
    ["local_transcription_start", {}],
    ["recorder_whisper_start:traversal", { id: "../x", stageId: "whisper-bad", model: "QuantizedTinyEn" }],
    ["recorder_whisper_start:missing", { id: crypto.randomUUID(), stageId: "whisper-bad", model: "QuantizedTinyEn" }],
    ["recorder_status", {}],
  ];
  for (let n = 0; n < 300 && !window.__TAURI_INTERNALS__?.invoke; n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!window.__TAURI_INTERNALS__?.invoke) {
    window.__exoIpcSelftest = { fatal: "webview IPC did not become ready" }; return;
  }
  const results = {};
  for (const [label, args] of probes) {
    const cmd = label.startsWith("recorder_whisper_start:") ? label.split(":")[0] : label;
    try {
      results[label] = { ok: true, value: await window.__TAURI_INTERNALS__.invoke(cmd, args) };
    } catch (error) {
      results[label] = { ok: false, error: String(error), code: error?.code ?? null };
    }
  }
  for (let n = 0; n < 300 && !window.__exoTinyCloudHostSelftest; n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  results.tinycloud_host_policy = window.__exoTinyCloudHostSelftest ?? { ok: false, error: "host policy did not become ready" };
  window.__exoIpcSelftest = results;
})()"#;

fn acl_denied(command: &str, error: &str) -> bool {
    if error == format!("Command {command} not allowed by ACL") {
        return true;
    }
    let name = command
        .strip_prefix("plugin:")
        .unwrap_or(command)
        .replace('|', ".");
    // Debug authority names the plugin and command. Missing plugins or bad
    // arguments do not pass just because they also reject an invoke.
    error.contains(&name)
        && (error.contains("not allowed. Permissions associated with this command:")
            || error.contains("explicitly denied"))
}

fn denied_probe(command: &str, error: &str) -> bool {
    if matches!(command, "local_capture_start" | "local_transcription_start") {
        error == format!("Command {command} not found")
            || error == format!("{command} not allowed. Command not found")
            || acl_denied(command, error)
    } else {
        acl_denied(command, error)
    }
}

fn assert_results(value: &serde_json::Value) -> bool {
    if let Some(fatal) = value.get("fatal") {
        eprintln!("[EXO_IPC_SELFTEST] FAIL: {fatal}");
        return false;
    }
    let mut all_pass = true;
    for &command in DENIED {
        let error = value
            .get(command)
            .and_then(|v| v.get("error"))
            .and_then(|v| v.as_str());
        let passed = error.is_some_and(|error| denied_probe(command, error));
        eprintln!(
            "[EXO_IPC_SELFTEST] {} {command}: {}",
            if passed { "PASS" } else { "FAIL" },
            error.unwrap_or("no ACL rejection")
        );
        all_pass &= passed;
    }
    for (label, code) in [
        ("recorder_whisper_start:traversal", "recording_unavailable"),
        ("recorder_whisper_start:missing", "recording_unavailable"),
    ] {
        let actual = value
            .get(label)
            .and_then(|v| v.get("code"))
            .and_then(|v| v.as_str());
        let passed = actual == Some(code);
        eprintln!(
            "[EXO_IPC_SELFTEST] {} {label}: {:?}",
            if passed { "PASS" } else { "FAIL" },
            actual
        );
        all_pass &= passed;
    }
    for label in ["recorder_status"] {
        let passed =
            value.get(label).and_then(|v| v.get("ok")) == Some(&serde_json::Value::Bool(true));
        eprintln!(
            "[EXO_IPC_SELFTEST] {} {label}",
            if passed { "PASS" } else { "FAIL" }
        );
        all_pass &= passed;
    }
    let host_policy = value.get("tinycloud_host_policy");
    let host_passed = host_policy.is_some_and(|policy| {
        let Some([host]) = policy
            .get("hosts")
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
        else {
            return false;
        };
        let Some([probe]) = policy
            .get("probes")
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
        else {
            return false;
        };
        policy.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
            && policy.get("platform").and_then(serde_json::Value::as_str) == Some("tauri")
            && policy.get("flow").and_then(serde_json::Value::as_str) == Some("widget")
            && host.as_str() == Some("https://node.tinycloud.xyz")
            && probe.get("url").and_then(serde_json::Value::as_str)
                == Some("https://node.tinycloud.xyz/info")
            && probe.get("method").and_then(serde_json::Value::as_str) == Some("GET")
            && probe.get("credentials").and_then(serde_json::Value::as_str) == Some("omit")
            && probe.get("hasBody").and_then(serde_json::Value::as_bool) == Some(false)
            && probe
                .get("hasAuthorization")
                .and_then(serde_json::Value::as_bool)
                == Some(false)
    });
    eprintln!(
        "[EXO_IPC_SELFTEST] {} tinycloud_host_policy: {:?}",
        if host_passed { "PASS" } else { "FAIL" },
        host_policy
    );
    all_pass &= host_passed;
    all_pass
}

pub fn maybe_run(app: &tauri::App) {
    if std::env::var("EXO_IPC_SELFTEST").as_deref() != Ok("1") {
        return;
    }
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if app.listener().get_capture_snapshot().await.is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                eprintln!("[EXO_IPC_SELFTEST] TIMEOUT: root actor unavailable");
                std::process::exit(2);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let window = loop {
            if let Some(window) = app.get_webview_window("main") {
                break window;
            }
            if Instant::now() >= deadline {
                eprintln!("[EXO_IPC_SELFTEST] TIMEOUT: main webview unavailable");
                std::process::exit(2);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        if let Err(error) = window.eval(SCRIPT) {
            eprintln!("[EXO_IPC_SELFTEST] FAIL: eval: {error}");
            std::process::exit(1);
        }
        while Instant::now() < deadline {
            let response = Arc::new(Mutex::new(None::<String>));
            let output = response.clone();
            if let Err(error) =
                window.eval_with_callback("window.__exoIpcSelftest ?? null", move |result| {
                    *output.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
                })
            {
                eprintln!("[EXO_IPC_SELFTEST] FAIL: callback: {error}");
                std::process::exit(1);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            let result = response.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(Ok(value)) =
                result.map(|raw| serde_json::from_str::<serde_json::Value>(&raw))
            {
                if !value.is_null() {
                    if assert_results(&value) {
                        eprintln!("[EXO_IPC_SELFTEST] ALL PASSED");
                        std::process::exit(0);
                    }
                    std::process::exit(1);
                }
            }
        }
        eprintln!("[EXO_IPC_SELFTEST] TIMEOUT: webview IPC did not finish");
        std::process::exit(2);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_exist_in_the_generated_pinned_manifests() {
        let manifests = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/gen/schemas/acl-manifests.json"
        ))
        .expect("tauri-build must generate pinned ACL manifests before tests");
        for command in DENIED
            .iter()
            .filter(|command| command.starts_with("plugin:"))
        {
            let name = command.split('|').nth(1).unwrap();
            assert!(
                manifests.contains(&format!("\"{name}\"")),
                "probe {command} missing from pinned manifests"
            );
        }
        for command in ["local_capture_start", "local_transcription_start"] {
            assert!(!manifests.contains(&format!("\"{command}\"")));
        }
    }

    #[test]
    fn denial_must_be_an_acl_rejection_not_a_missing_command() {
        assert!(acl_denied(
            "plugin:transcription|start_capture",
            "Command plugin:transcription|start_capture not allowed by ACL"
        ));
        assert!(!acl_denied(
            "plugin:transcription|start_capture",
            "Command not found"
        ));
        assert!(!acl_denied(
            "plugin:transcription|start_capture",
            "invalid args"
        ));
        for command in ["local_capture_start", "local_transcription_start"] {
            assert!(denied_probe(
                command,
                &format!("{command} not allowed. Command not found")
            ));
            assert!(denied_probe(
                command,
                &format!("Command {command} not found")
            ));
        }
        assert!(!denied_probe(
            "plugin:transcription|start_capture",
            "transcription.start_capture not allowed. Command not found"
        ));
    }
}
