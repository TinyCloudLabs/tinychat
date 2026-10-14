use tauri_plugin_opener::OpenerExt;

/// The TinyCloud billing page. Fixed here, so the webview cannot choose what opens.
const MANAGE_STORAGE_URL: &str = "https://account.tinycloud.xyz/billing";

/// Opens the storage page in the system browser, never in the webview.
#[tauri::command]
pub fn open_manage_storage(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(MANAGE_STORAGE_URL, None::<&str>)
        .map_err(|_| "Could not open the system browser".into())
}
