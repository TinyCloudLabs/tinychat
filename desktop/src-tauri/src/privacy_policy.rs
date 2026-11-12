use tauri_plugin_opener::OpenerExt;

/// TinyCloud's privacy policy. Fixed here, so the webview cannot choose what opens.
const PRIVACY_POLICY_URL: &str = "https://tinycloud.xyz/privacy";

/// Opens the privacy policy in the system browser, never in the webview.
#[tauri::command]
pub fn open_privacy_policy(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(PRIVACY_POLICY_URL, None::<&str>)
        .map_err(|_| "Could not open the system browser".into())
}
