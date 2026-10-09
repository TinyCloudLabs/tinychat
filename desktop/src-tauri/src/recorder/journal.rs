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
    #[serde(default)]
    pub system_audio: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedSegment {
    pub id: String,
    pub segment_id: String,
    pub reason: String,
    pub error: String,
    pub journal: Journal,
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

fn failed_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = path(app)?.parent().unwrap().join("recorder-failed");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

pub fn save_failed(app: &tauri::AppHandle, failed: &FailedSegment) -> Result<(), String> {
    // A vault may live on another filesystem, where renaming into app data
    // cannot work. The manifest still makes the source recoverable by its
    // original session path and must not leave Stop retrying the import.
    let mut reported = failed.clone();
    if let Err(error) = quarantine_source(app, &failed.segment_id) {
        // Keep the source in its original vault location for retry, but expose
        // the failed move to the renderer instead of silently discarding it.
        reported.error = format!("{}; quarantine_move_failed: {error}", reported.error);
    }
    save_failed_at(&failed_root(app)?, &reported)
}

pub fn failed_source(app: &tauri::AppHandle, segment_id: &str) -> Result<PathBuf, String> {
    if !super::files::valid_recording_id(segment_id) || !segment_id.starts_with("rec-") {
        return Err("invalid_segment_id".into());
    }
    Ok(failed_root(app)?.join("sources").join(segment_id))
}

fn quarantine_source(app: &tauri::AppHandle, segment_id: &str) -> Result<(), String> {
    let source_root = super::files::sessions_root(app)?;
    let source = source_root.join(segment_id);
    let target = failed_source(app, segment_id)?;
    if target.exists() || !source.exists() {
        return Ok(());
    }
    let target_root = target.parent().ok_or("invalid_segment_id")?;
    fs::create_dir_all(target_root).map_err(|e| e.to_string())?;
    fs::rename(&source, &target).map_err(|e| e.to_string())?;
    File::open(&source_root)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    File::open(target_root)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

pub fn remove_failed_source(app: &tauri::AppHandle, segment_id: &str) -> Result<(), String> {
    let root = failed_root(app)?.join("sources");
    if root.exists() {
        super::files::remove_source_session(&root, segment_id)?;
    }
    Ok(())
}

fn save_failed_at(root: &std::path::Path, failed: &FailedSegment) -> Result<(), String> {
    if !super::files::valid_recording_id(&failed.segment_id)
        || !failed.segment_id.starts_with("rec-")
    {
        return Err("invalid_segment_id".into());
    }
    let path = root.join(format!("{}.json", failed.segment_id));
    let temp = path.with_extension("json.tmp");
    let mut file = File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(failed).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    File::open(root)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

pub fn list_failed(app: &tauri::AppHandle) -> Result<Vec<FailedSegment>, String> {
    list_failed_at(&failed_root(app)?)
}

fn list_failed_at(root: &std::path::Path) -> Result<Vec<FailedSegment>, String> {
    let mut failed = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            failed.push(
                serde_json::from_slice(&fs::read(entry.path()).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
    }
    Ok(failed)
}

pub fn remove_failed(app: &tauri::AppHandle, segment_id: &str) -> Result<(), String> {
    if !super::files::valid_recording_id(segment_id) || !segment_id.starts_with("rec-") {
        return Err("invalid_segment_id".into());
    }
    let root = failed_root(app)?;
    match fs::remove_file(root.join(format!("{segment_id}.json"))) {
        Ok(()) => File::open(root)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete_failed_for_note(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    delete_failed_for_note_at(&failed_root(app)?, &super::files::sessions_root(app)?, id)
}

fn delete_failed_for_note_at(
    root: &std::path::Path,
    sessions: &std::path::Path,
    id: &str,
) -> Result<(), String> {
    if !super::files::valid_recording_id(id) {
        return Err("invalid_recording_id".into());
    }
    for failed in list_failed_at(root)?
        .into_iter()
        .filter(|failed| failed.id == id)
    {
        super::files::remove_source_session(sessions, &failed.segment_id)?;
        let failed_sources = root.join("sources");
        if failed_sources.exists() {
            super::files::remove_source_session(&failed_sources, &failed.segment_id)?;
        }
        fs::remove_file(root.join(format!("{}.json", failed.segment_id)))
            .map_err(|e| e.to_string())?;
    }
    File::open(root)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
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
            system_audio: false,
        };
        let value = serde_json::to_value(&journal).unwrap();
        assert_eq!(value["segmentId"], "segment");
        assert_eq!(
            serde_json::from_value::<Journal>(value).unwrap().paused_ms,
            300
        );
    }

    #[test]
    fn failed_segment_manifest_survives_and_keeps_source_reference() {
        let base = std::env::temp_dir().join(format!("exo-failed-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("failed");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(root.join("sources/rec-broken")).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            root.join("sources/rec-broken/audio.mp3"),
            b"recoverable bytes",
        )
        .unwrap();
        let journal = Journal {
            id: "note".into(),
            started_at: 1,
            segment_id: Some("rec-broken".into()),
            recorded_ms: 500,
            paused_ms: 0,
            max_duration_ms: 10_000,
            system_audio: true,
        };
        let failed = FailedSegment {
            id: "note".into(),
            segment_id: "rec-broken".into(),
            reason: "write_failed".into(),
            error: "unreadable fixture".into(),
            journal,
        };
        save_failed_at(&root, &failed).unwrap();
        let listed = list_failed_at(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].segment_id, "rec-broken");
        assert_eq!(listed[0].journal.recorded_ms, 500);
        assert!(listed[0].journal.system_audio);
        delete_failed_for_note_at(&root, &sessions, "note").unwrap();
        assert!(list_failed_at(&root).unwrap().is_empty());
        assert!(!root.join("sources/rec-broken").exists());
        fs::remove_dir_all(base).unwrap();
    }
}
