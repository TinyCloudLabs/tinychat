//! Debug-only JSONL sink shared by the web app and curated native tracing.
use std::io::Write;
use std::sync::{Mutex, OnceLock};

static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const LIMIT: u64 = 5 * 1024 * 1024;

fn append_line(line: &str) -> std::io::Result<()> {
    let _guard = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let home = std::env::var_os("HOME").ok_or_else(|| std::io::Error::other("HOME is unset"))?;
    let directory = std::path::PathBuf::from(home).join("Library/Logs/xyz.tinycloud.exo");
    std::fs::create_dir_all(&directory)?;
    let file = directory.join("exo-dev.log");
    if std::fs::metadata(&file).is_ok_and(|metadata| metadata.len() >= LIMIT) {
        let rotated = directory.join("exo-dev.log.1");
        let _ = std::fs::remove_file(&rotated);
        std::fs::rename(&file, rotated)?;
    }
    writeln!(std::fs::OpenOptions::new().create(true).append(true).open(file)?, "{line}")?;
    writeln!(std::io::stdout(), "{line}")
}

#[tauri::command]
pub fn debug_logging_enabled() -> bool { cfg!(debug_assertions) }

#[tauri::command]
pub fn append_dev_log(line: String) {
    if !cfg!(debug_assertions) || line.len() > 8192 { return; }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { return };
    if value.get("at").and_then(|v| v.as_str()).is_none()
        || value.get("kind").and_then(|v| v.as_str()).is_none()
        || value.get("source_id").is_none() { return; }
    let _ = append_line(&line);
}

#[derive(Default)]
struct LineWriter(Vec<u8>);
impl Write for LineWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
impl Drop for LineWriter {
    fn drop(&mut self) {
        for line in self.0.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
            if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(line) {
                if let Some(object) = value.as_object_mut() {
                    if let Some(timestamp) = object.remove("timestamp") {
                        object.insert("at".into(), timestamp);
                    }
                }
                let _ = append_line(&value.to_string());
            }
        }
    }
}

pub fn install() {
    if !cfg!(debug_assertions) { return; }
    let _ = tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_ansi(false)
        .with_env_filter("off,exo_dev=info")
        .with_writer(LineWriter::default)
        .try_init();
}
