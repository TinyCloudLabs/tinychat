//! A small durable pointer from a note ID to the upstream capture segment.
//! The upstream plugin keeps segment bytes on disk while capture is live.
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub id: String,
    pub started_at: u64,
    pub segment_id: Option<String>,
    pub recorded_ms: u64,
    pub paused_ms: u64,
    pub max_duration_ms: u64,
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voice-notes");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.join("recorder-session.json"))
}

pub fn load(app: &tauri::AppHandle) -> Result<Option<Journal>, String> {
    match fs::read(path(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save(app: &tauri::AppHandle, value: &Journal) -> Result<(), String> {
    let path = path(app)?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let mut file = File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(temp, &path).map_err(|e| e.to_string())?;
    File::open(path.parent().unwrap())
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
    let path = path(app)?;
    match fs::remove_file(&path) {
        Ok(()) => File::open(path.parent().unwrap())
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_shape_is_stable() {
        let journal = Journal {
            id: "id".into(),
            started_at: 1,
            segment_id: Some("segment".into()),
            recorded_ms: 200,
            paused_ms: 300,
            max_duration_ms: 1_000,
        };
        let value = serde_json::to_value(&journal).unwrap();
        assert_eq!(value["segmentId"], "segment");
        assert_eq!(
            serde_json::from_value::<Journal>(value).unwrap().paused_ms,
            300
        );
    }
}
