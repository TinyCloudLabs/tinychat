//! A small durable pointer from a note ID to the upstream capture segment.
//! The upstream plugin keeps segment bytes on disk while capture is live.
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingAudioSpan {
    pub kind: String,
    pub reason: String,
    pub started_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    pub at_audio_ms: u64,
    pub audio_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub id: String,
    pub started_at: u64,
    #[serde(default)]
    pub segment_id: Option<String>,
    pub recorded_ms: u64,
    pub paused_ms: u64,
    pub max_duration_ms: u64,
    #[serde(default)]
    pub system_audio: bool,
    #[serde(default)]
    pub spans: Vec<MissingAudioSpan>,
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

fn stopped_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = path(app)?.parent().unwrap().join("recorder-stopped");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    File::open(root.parent().unwrap())
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(root)
}

fn stopped_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !super::files::valid_recording_id(id) {
        return Err("invalid_recording_id".into());
    }
    Ok(stopped_root(app)?.join(format!("{id}.json")))
}

pub fn save_stopped(app: &tauri::AppHandle, value: &Journal) -> Result<(), String> {
    let path = stopped_path(app, &value.id)?;
    save_stopped_at(&path, value)
}

pub(crate) fn save_stopped_at(path: &std::path::Path, value: &Journal) -> Result<(), String> {
    let temp = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    let mut file = File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    File::open(path.parent().unwrap())
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

pub fn clear_active_if_matches(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    clear_active_if_matches_at(&path(app)?, id)
}

fn clear_active_if_matches_at(path: &std::path::Path, id: &str) -> Result<(), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let pending: Journal = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if pending.id != id {
        return Ok(());
    }
    fs::remove_file(path).map_err(|e| e.to_string())?;
    File::open(path.parent().unwrap())
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

pub fn load_stopped(app: &tauri::AppHandle, id: &str) -> Result<Option<Journal>, String> {
    match fs::read(stopped_path(app, id)?) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn list_stopped(app: &tauri::AppHandle) -> Result<Vec<Journal>, String> {
    let root = stopped_root(app)?;
    let failed = failed_root(app)?;
    list_stopped_at(&root, &failed)
}

fn list_stopped_at(
    root: &std::path::Path,
    failed: &std::path::Path,
) -> Result<Vec<Journal>, String> {
    let mut journals = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            quarantine_stopped_at(root, failed, "recorder-stopped", &error.to_string())?;
            fs::create_dir_all(root).map_err(|e| e.to_string())?;
            return Ok(journals);
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                quarantine_stopped_at(root, failed, "recorder-stopped", &error.to_string())?;
                fs::create_dir_all(root).map_err(|e| e.to_string())?;
                return Ok(Vec::new());
            }
        };
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let parsed = fs::read(entry.path())
            .map_err(|e| e.to_string())
            .and_then(|bytes| serde_json::from_slice::<Journal>(&bytes).map_err(|e| e.to_string()));
        match parsed {
            Ok(journal) => journals.push(journal),
            Err(error) => {
                let entry_path = entry.path();
                let id = entry_path
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unknown");
                quarantine_stopped_at(&entry_path, failed, id, &error)?;
            }
        }
    }
    journals.sort_by(|a: &Journal, b: &Journal| a.id.cmp(&b.id));
    Ok(journals)
}

fn quarantine_stopped_at(
    source: &std::path::Path,
    failed_root: &std::path::Path,
    id: &str,
    error: &str,
) -> Result<(), String> {
    let id = if super::files::valid_recording_id(id) {
        id
    } else {
        "unknown-stopped-journal"
    };
    let segment_id = format!("rec-journal-{}", uuid::Uuid::new_v4());
    let quarantine = failed_root.join("journals");
    fs::create_dir_all(&quarantine).map_err(|e| e.to_string())?;
    let target = quarantine.join(&segment_id);
    fs::rename(source, &target).map_err(|e| e.to_string())?;
    File::open(source.parent().unwrap())
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    File::open(&quarantine)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    let failed = FailedSegment {
        id: id.into(),
        segment_id: segment_id.clone(),
        reason: "stopped_journal_invalid".into(),
        error: error.into(),
        journal: Journal {
            id: id.into(),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            segment_id: None,
            recorded_ms: 0,
            paused_ms: 0,
            max_duration_ms: 3 * 60 * 60_000,
            system_audio: false,
            spans: Vec::new(),
        },
    };
    save_failed_at(failed_root, &failed)?;
    tracing::error!(target: "exo_dev::recorder", kind = "pipeline", source_id = %id,
        operation = "stopped_journal", phase = "quarantined", error = %error,
        path = %target.display());
    Ok(())
}

pub fn clear_stopped(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let path = stopped_path(app, id)?;
    match fs::remove_file(&path) {
        Ok(()) => File::open(path.parent().unwrap())
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
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
    fn startup_quarantines_bad_stopped_journals_and_keeps_older_ones() {
        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("recorder-stopped");
        let failed = dir.path().join("recorder-failed");
        fs::create_dir_all(&stopped).unwrap();
        fs::create_dir_all(&failed).unwrap();
        fs::write(stopped.join("bad-note.json"), b"{broken").unwrap();
        fs::write(
            stopped.join("good-note.json"),
            br#"{"id":"good-note","startedAt":1,"recordedMs":100,
            "pausedMs":0,"maxDurationMs":1000}"#,
        )
        .unwrap();
        let journals = list_stopped_at(&stopped, &failed).unwrap();
        assert_eq!(journals.len(), 1);
        assert_eq!(journals[0].id, "good-note");
        assert_eq!(journals[0].segment_id, None);
        assert!(!stopped.join("bad-note.json").exists());
        let failures = list_failed_at(&failed).unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].id, "bad-note");
        assert_eq!(failures[0].reason, "stopped_journal_invalid");
        assert!(failures[0].journal.started_at > 0);
        assert!(failures[0].journal.max_duration_ms > 0);
        assert!(
            failed
                .join("journals")
                .join(&failures[0].segment_id)
                .exists()
        );

        // A directory that cannot be enumerated is moved aside as one unit.
        fs::remove_dir_all(&stopped).unwrap();
        fs::write(&stopped, b"unreadable stopped directory fixture").unwrap();
        assert!(list_stopped_at(&stopped, &failed).unwrap().is_empty());
        assert!(stopped.is_dir());
        let failures = list_failed_at(&failed).unwrap();
        assert_eq!(failures.len(), 2);
        assert!(failures.iter().any(|item| item.id == "recorder-stopped"));
    }
    #[test]
    fn stopped_journal_works_while_import_lock_is_held_and_recovers_crash_window() {
        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("note.json");
        let active = dir.path().join("recorder-session.json");
        let journal = Journal {
            id: "note".into(),
            started_at: 1,
            segment_id: Some("rec-final".into()),
            recorded_ms: 60_000,
            paused_ms: 0,
            max_duration_ms: 180_000,
            system_audio: false,
            spans: vec![],
        };
        let (locked_tx, locked_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let lock_holder = std::thread::spawn(move || {
            super::super::with_import_lock(|| {
                locked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });
        locked_rx.recv().unwrap();
        let (saved_tx, saved_rx) = std::sync::mpsc::sync_channel(0);
        let worker = std::thread::spawn({
            let stopped = stopped.clone();
            let journal = journal.clone();
            move || {
                save_stopped_at(&stopped, &journal).unwrap();
                saved_tx.send(()).unwrap();
            }
        });
        let saved_while_importing = saved_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .is_ok();
        release_tx.send(()).unwrap();
        lock_holder.join().unwrap();
        worker.join().unwrap();
        assert!(
            saved_while_importing,
            "Stop journal waited for another note's import"
        );
        fs::write(&active, serde_json::to_vec(&journal).unwrap()).unwrap();
        clear_active_if_matches_at(&active, "other").unwrap();
        assert!(active.exists());
        clear_active_if_matches_at(&active, "note").unwrap();
        assert!(!active.exists());
        assert_eq!(
            serde_json::from_slice::<Journal>(&fs::read(stopped).unwrap())
                .unwrap()
                .id,
            "note"
        );
    }
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
            spans: Vec::new(),
        };
        let value = serde_json::to_value(&journal).unwrap();
        assert_eq!(value["segmentId"], "segment");
        assert_eq!(value["spans"], serde_json::json!([]));
        assert_eq!(
            serde_json::from_value::<Journal>(value.clone())
                .unwrap()
                .paused_ms,
            300
        );
        let mut old_journal = value;
        old_journal.as_object_mut().unwrap().remove("spans");
        assert!(
            serde_json::from_value::<Journal>(old_journal)
                .unwrap()
                .spans
                .is_empty()
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
            spans: Vec::new(),
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
