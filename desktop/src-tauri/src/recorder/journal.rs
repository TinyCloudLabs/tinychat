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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quarantined_journal: Option<String>,
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
    list_stopped_at_with_read(root, failed, |path| fs::read(path))
}

fn list_stopped_at_with_read(
    root: &std::path::Path,
    failed: &std::path::Path,
    read: impl Fn(&std::path::Path) -> std::io::Result<Vec<u8>>,
) -> Result<Vec<Journal>, String> {
    let mut journals = Vec::new();
    let entries = fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let parsed = read(&entry.path())
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
    let quarantine = failed_root.join("journals");
    fs::create_dir_all(&quarantine).map_err(|e| e.to_string())?;
    let name = format!("{id}.{}.json", uuid::Uuid::new_v4());
    let target = quarantine.join(&name);
    fs::rename(source, &target).map_err(|e| e.to_string())?;
    File::open(source.parent().unwrap())
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    File::open(&quarantine)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    let failed = failed_journal_at(&target, id, error)?;
    save_failed_at(failed_root, &failed)?;
    tracing::error!(target: "exo_dev::recorder", kind = "pipeline", source_id = %id,
        operation = "stopped_journal", phase = "quarantined", error = %error,
        path = %target.display());
    Ok(())
}

fn failed_journal_at(
    source: &std::path::Path,
    id: &str,
    error: &str,
) -> Result<FailedSegment, String> {
    let bytes = fs::read(source).unwrap_or_default();
    let parsed = serde_json::from_slice::<Journal>(&bytes).ok();
    let partial = serde_json::from_slice::<serde_json::Value>(&bytes).ok();
    let id = if id == "unknown" {
        parsed
            .as_ref()
            .map(|journal| journal.id.as_str())
            .filter(|id| super::files::valid_recording_id(id))
            .unwrap_or(id)
    } else {
        id
    }
    .to_owned();
    let segment_id = parsed
        .as_ref()
        .and_then(|j| j.segment_id.clone())
        .or_else(|| {
            partial
                .as_ref()?
                .get("segmentId")?
                .as_str()
                .map(str::to_owned)
        })
        .filter(|value| super::files::valid_recording_id(value) && value.starts_with("rec-"));
    let journal = parsed.unwrap_or_else(|| Journal {
        id: id.clone(),
        started_at: partial
            .as_ref()
            .and_then(|v| v.get("startedAt"))
            .and_then(|v| v.as_u64())
            .unwrap_or_default(),
        segment_id: segment_id.clone(),
        recorded_ms: partial
            .as_ref()
            .and_then(|v| v.get("recordedMs"))
            .and_then(|v| v.as_u64())
            .unwrap_or_default(),
        paused_ms: partial
            .as_ref()
            .and_then(|v| v.get("pausedMs"))
            .and_then(|v| v.as_u64())
            .unwrap_or_default(),
        max_duration_ms: partial
            .as_ref()
            .and_then(|v| v.get("maxDurationMs"))
            .and_then(|v| v.as_u64())
            .unwrap_or(3 * 60 * 60_000),
        system_audio: partial
            .as_ref()
            .and_then(|v| v.get("systemAudio"))
            .and_then(|v| v.as_bool())
            .unwrap_or_default(),
        spans: Vec::new(),
    });
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("invalid_journal_path")?;
    Ok(FailedSegment {
        id,
        segment_id: segment_id.unwrap_or_default(),
        reason: "stopped_journal_invalid".into(),
        error: error.into(),
        journal,
        quarantined_journal: Some(name.into()),
    })
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
    if failed.quarantined_journal.is_some() {
        return save_failed_at(&failed_root(app)?, failed);
    }
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
    let key = failed_key(failed)?;
    let path = root.join(format!("{key}.json"));
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

fn failed_key(failed: &FailedSegment) -> Result<String, String> {
    if let Some(name) = &failed.quarantined_journal {
        let name = safe_journal_name(name)?;
        if name.starts_with("rec-journal-") && !name.ends_with(".json") {
            return Ok(name.into());
        }
        return Ok(format!("journal-{}", name.trim_end_matches(".json")));
    }
    if !super::files::valid_recording_id(&failed.segment_id)
        || !failed.segment_id.starts_with("rec-")
    {
        return Err("invalid_segment_id".into());
    }
    Ok(failed.segment_id.clone())
}

fn safe_journal_name(name: &str) -> Result<&str, String> {
    if let Some(uuid) = name.strip_prefix("rec-journal-") {
        if uuid::Uuid::parse_str(uuid).is_ok() {
            return Ok(name);
        }
    }
    let stem = name.strip_suffix(".json").ok_or("invalid_journal_path")?;
    let Some((id, unique)) = stem.rsplit_once('.') else {
        return Err("invalid_journal_path".into());
    };
    if !super::files::valid_recording_id(id)
        || uuid::Uuid::parse_str(unique).is_err()
        || stem.contains('/')
        || stem.contains('\\')
    {
        return Err("invalid_journal_path".into());
    }
    Ok(name)
}

pub fn retry_quarantined(
    app: &tauri::AppHandle,
    failed: &FailedSegment,
    recover: impl FnOnce(&Journal) -> Result<(), String>,
) -> Result<(), String> {
    retry_quarantined_at(
        &stopped_root(app)?,
        &failed_root(app)?,
        failed,
        || super::refresh_finishing_quit(app),
        recover,
    )
}

fn retry_quarantined_at(
    stopped: &std::path::Path,
    failed_root: &std::path::Path,
    failed: &FailedSegment,
    refresh_quit: impl FnOnce() -> Result<(), String>,
    recover: impl FnOnce(&Journal) -> Result<(), String>,
) -> Result<(), String> {
    if !super::files::valid_recording_id(&failed.id) {
        return Err("invalid_recording_id".into());
    }
    let name = safe_journal_name(
        failed
            .quarantined_journal
            .as_deref()
            .ok_or("journal_missing")?,
    )?;
    let source = failed_root.join("journals").join(name);
    let destination = stopped.join(format!("{}.json", failed.id));
    let current = match read_quarantined_at(&source, &failed.id) {
        Ok(value) => value,
        Err(error) if !source.exists() => {
            read_quarantined_at(&destination, &failed.id).map_err(|_| error)?
        }
        Err(error) => return Err(error),
    };
    save_stopped_at(&destination, &current)?;
    refresh_quit()?;
    match fs::remove_file(&source) {
        Ok(()) => File::open(source.parent().unwrap())
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    let manifest = failed_root.join(format!("{}.json", failed_key(failed)?));
    match fs::remove_file(manifest) {
        Ok(()) => File::open(failed_root)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    recover(&current)
}

fn read_quarantined_at(path: &std::path::Path, id: &str) -> Result<Journal, String> {
    let value: Journal = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if value.id != id
        || !super::files::valid_recording_id(&value.id)
        || value.segment_id.as_deref().is_some_and(|segment| {
            !super::files::valid_recording_id(segment) || !segment.starts_with("rec-")
        })
    {
        return Err("invalid_journal_association".into());
    }
    Ok(value)
}

pub fn list_failed(app: &tauri::AppHandle) -> Result<Vec<FailedSegment>, String> {
    list_failed_at(&failed_root(app)?)
}

fn list_failed_at(root: &std::path::Path) -> Result<Vec<FailedSegment>, String> {
    let mut failed = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            let mut item: FailedSegment =
                serde_json::from_slice(&fs::read(entry.path()).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if item.reason == "stopped_journal_invalid"
                && item.quarantined_journal.is_none()
                && safe_journal_name(&item.segment_id).is_ok()
                && root.join("journals").join(&item.segment_id).is_file()
            {
                item.quarantined_journal = Some(item.segment_id.clone());
            }
            failed.push(item);
        }
    }
    let journals = root.join("journals");
    if journals.exists() {
        for entry in fs::read_dir(&journals).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if safe_journal_name(name).is_err() {
                continue;
            }
            if failed
                .iter()
                .any(|item: &FailedSegment| item.quarantined_journal.as_deref() == Some(name))
            {
                continue;
            }
            let id = name
                .trim_end_matches(".json")
                .rsplit_once('.')
                .map(|(id, _)| id)
                .unwrap_or("unknown");
            let recovered =
                failed_journal_at(&entry.path(), id, "journal_manifest_missing_after_crash")?;
            save_failed_at(root, &recovered)?;
            failed.push(recovered);
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
        if let Some(name) = &failed.quarantined_journal {
            fs::remove_file(root.join("journals").join(safe_journal_name(name)?))
                .map_err(|e| e.to_string())?;
            if let Some(segment) = failed.journal.segment_id.as_deref().or_else(|| {
                if failed.segment_id.starts_with("rec-")
                    && !failed.segment_id.starts_with("rec-journal-")
                {
                    Some(failed.segment_id.as_str())
                } else {
                    None
                }
            }) {
                if super::files::valid_recording_id(segment) && segment.starts_with("rec-") {
                    super::files::remove_source_session(sessions, segment)?;
                }
            }
        } else {
            super::files::remove_source_session(sessions, &failed.segment_id)?;
            let failed_sources = root.join("sources");
            if failed_sources.exists() {
                super::files::remove_source_session(&failed_sources, &failed.segment_id)?;
            }
        }
        fs::remove_file(root.join(format!("{}.json", failed_key(&failed)?)))
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
    fn bad_journal_does_not_hide_valid_journals() {
        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("recorder-stopped");
        let failed = dir.path().join("recorder-failed");
        fs::create_dir_all(&stopped).unwrap();
        fs::create_dir_all(&failed).unwrap();
        fs::write(stopped.join("bad-note.json"), b"{broken").unwrap();
        for id in ["good-one", "good-two"] {
            fs::write(stopped.join(format!("{id}.json")), format!(
                r#"{{"id":"{id}","startedAt":1,"segmentId":"rec-{id}","recordedMs":100,"pausedMs":0,"maxDurationMs":1000}}"#
            )).unwrap();
        }
        let journals = list_stopped_at(&stopped, &failed).unwrap();
        assert_eq!(journals.len(), 2);
        assert_eq!(journals[0].segment_id.as_deref(), Some("rec-good-one"));
        assert_eq!(journals[1].segment_id.as_deref(), Some("rec-good-two"));
        let failures = list_failed_at(&failed).unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].id, "bad-note");
        assert!(failed
            .join("journals")
            .join(failures[0].quarantined_journal.as_ref().unwrap())
            .exists());
        assert!(stopped.join("good-one.json").exists());
        assert!(stopped.join("good-two.json").exists());
        let audio = dir.path().join("audio");
        fs::create_dir_all(&audio).unwrap();
        for journal in &journals {
            let source = dir.path().join(format!("{}.mp3", journal.id));
            fs::write(&source, journal.id.as_bytes()).unwrap();
            exo_local_transcription::audio_import::import_at(
                &audio,
                &journal.id,
                journal.segment_id.as_deref().unwrap(),
                &source,
            )
            .unwrap();
            assert_eq!(
                fs::read(audio.join(format!("{}.mp3", journal.id))).unwrap(),
                journal.id.as_bytes()
            );
        }
    }

    #[test]
    fn unreadable_stopped_directory_is_never_quarantined_as_a_journal() {
        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("recorder-stopped");
        let failed = dir.path().join("recorder-failed");
        fs::write(&stopped, b"directory unavailable").unwrap();
        fs::create_dir_all(&failed).unwrap();
        assert!(list_stopped_at(&stopped, &failed).is_err());
        assert_eq!(fs::read(&stopped).unwrap(), b"directory unavailable");
        assert!(list_failed_at(&failed).unwrap().is_empty());
    }

    #[test]
    fn salvageable_journal_recovers_with_serde_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("recorder-stopped");
        let failed = dir.path().join("recorder-failed");
        fs::create_dir_all(&stopped).unwrap();
        fs::create_dir_all(&failed).unwrap();
        fs::write(stopped.join("note.json"), br#"{"id":"note","startedAt":7,"segmentId":"rec-original","recordedMs":900,"pausedMs":10,"maxDurationMs":1000}"#).unwrap();
        let journals = list_stopped_at(&stopped, &failed).unwrap();
        assert_eq!(journals.len(), 1);
        assert_eq!(journals[0].segment_id.as_deref(), Some("rec-original"));
        assert!(!journals[0].system_audio);
        assert!(journals[0].spans.is_empty());
        assert!(list_failed_at(&failed).unwrap().is_empty());
        let audio = dir.path().join("audio");
        let source = dir.path().join("session.mp3");
        fs::create_dir_all(&audio).unwrap();
        fs::write(&source, b"salvaged audio").unwrap();
        exo_local_transcription::audio_import::import_at(
            &audio,
            &journals[0].id,
            journals[0].segment_id.as_deref().unwrap(),
            &source,
        )
        .unwrap();
        assert_eq!(fs::read(audio.join("note.mp3")).unwrap(), b"salvaged audio");
    }

    #[test]
    fn retry_rereads_transiently_unreadable_journal_and_restores_full_note() {
        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("recorder-stopped");
        let failed = dir.path().join("recorder-failed");
        fs::create_dir_all(&stopped).unwrap();
        fs::create_dir_all(&failed).unwrap();
        let original = Journal {
            id: "note".into(),
            started_at: 7,
            segment_id: Some("rec-original".into()),
            recorded_ms: 900,
            paused_ms: 10,
            max_duration_ms: 1000,
            system_audio: true,
            spans: vec![],
        };
        fs::write(
            stopped.join("note.json"),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        let journals = list_stopped_at_with_read(&stopped, &failed, |_| {
            Err(std::io::Error::other("transient read error"))
        })
        .unwrap();
        assert!(journals.is_empty());
        let failure = list_failed_at(&failed).unwrap().pop().unwrap();
        assert_eq!(failure.segment_id, "rec-original");
        let audio = dir.path().join("audio");
        let source = dir.path().join("session.mp3");
        fs::create_dir_all(&audio).unwrap();
        fs::write(&source, b"full note audio").unwrap();
        retry_quarantined_at(
            &stopped,
            &failed,
            &failure,
            || Ok(()),
            |restored| {
                assert_eq!(restored, &original);
                exo_local_transcription::audio_import::import_at(
                    &audio,
                    &restored.id,
                    restored.segment_id.as_deref().unwrap(),
                    &source,
                )
            },
        )
        .unwrap();
        assert_eq!(
            fs::read(audio.join("note.mp3")).unwrap(),
            b"full note audio"
        );
        assert!(audio.join("note.rec-original.imported").exists());
        assert_eq!(
            serde_json::from_slice::<Journal>(&fs::read(stopped.join("note.json")).unwrap())
                .unwrap(),
            original
        );
        assert!(list_failed_at(&failed).unwrap().is_empty());
    }

    #[test]
    fn retry_guards_quit_until_restored_journal_is_acknowledged() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("recorder-stopped");
        let failed = dir.path().join("recorder-failed");
        fs::create_dir_all(&stopped).unwrap();
        fs::create_dir_all(&failed).unwrap();
        let original = Journal {
            id: "note".into(),
            started_at: 7,
            segment_id: Some("rec-original".into()),
            recorded_ms: 900,
            paused_ms: 0,
            max_duration_ms: 1000,
            system_audio: false,
            spans: vec![],
        };
        save_stopped_at(&stopped.join("note.json"), &original).unwrap();
        list_stopped_at_with_read(&stopped, &failed, |_| {
            Err(std::io::Error::other("transient read error"))
        })
        .unwrap();
        let failure = list_failed_at(&failed).unwrap().pop().unwrap();
        let finishing_quit = AtomicBool::new(false);
        assert!(list_stopped_at(&stopped, &failed).unwrap().is_empty());

        retry_quarantined_at(
            &stopped,
            &failed,
            &failure,
            || {
                finishing_quit.store(
                    !list_stopped_at(&stopped, &failed)?.is_empty(),
                    Ordering::SeqCst,
                );
                Ok(())
            },
            |restored| {
                assert_eq!(restored, &original);
                assert!(crate::guard_user_exit(
                    finishing_quit.load(Ordering::SeqCst),
                    None
                ));
                Ok(())
            },
        )
        .unwrap();

        // Acknowledgement removes the durable stopped journal and refreshes
        // the quit guard through the same stopped-journal check.
        fs::remove_file(stopped.join("note.json")).unwrap();
        finishing_quit.store(
            !list_stopped_at(&stopped, &failed).unwrap().is_empty(),
            Ordering::SeqCst,
        );
        assert!(!crate::guard_user_exit(
            finishing_quit.load(Ordering::SeqCst),
            None
        ));
    }

    #[test]
    fn crash_after_rename_recreates_manifest_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("recorder-stopped");
        let failed = dir.path().join("recorder-failed");
        let quarantined = failed.join("journals");
        fs::create_dir_all(&stopped).unwrap();
        fs::create_dir_all(&quarantined).unwrap();
        let original = Journal {
            id: "note".into(),
            started_at: 7,
            segment_id: Some("rec-original".into()),
            recorded_ms: 900,
            paused_ms: 10,
            max_duration_ms: 1000,
            system_audio: true,
            spans: vec![],
        };
        let name = format!("note.{}.json", uuid::Uuid::new_v4());
        fs::write(
            stopped.join("note.json"),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        fs::rename(stopped.join("note.json"), quarantined.join(&name)).unwrap();
        let first = list_failed_at(&failed).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].segment_id, "rec-original");
        assert_eq!(list_failed_at(&failed).unwrap().len(), 1);
        let audio = dir.path().join("audio");
        let source = dir.path().join("session.mp3");
        fs::create_dir_all(&audio).unwrap();
        fs::write(&source, b"crash recovered audio").unwrap();
        retry_quarantined_at(
            &stopped,
            &failed,
            &first[0],
            || Ok(()),
            |restored| {
                assert_eq!(restored, &original);
                exo_local_transcription::audio_import::import_at(
                    &audio,
                    &restored.id,
                    restored.segment_id.as_deref().unwrap(),
                    &source,
                )
            },
        )
        .unwrap();
        assert_eq!(
            fs::read(audio.join("note.mp3")).unwrap(),
            b"crash recovered audio"
        );
        assert!(list_failed_at(&failed).unwrap().is_empty());
    }

    #[test]
    fn existing_synthetic_journal_failure_can_retry_original_segment() {
        let dir = tempfile::tempdir().unwrap();
        let stopped = dir.path().join("recorder-stopped");
        let failed = dir.path().join("recorder-failed");
        fs::create_dir_all(&stopped).unwrap();
        fs::create_dir_all(failed.join("journals")).unwrap();
        let legacy_key = format!("rec-journal-{}", uuid::Uuid::new_v4());
        let original = Journal {
            id: "note".into(),
            started_at: 7,
            segment_id: Some("rec-original".into()),
            recorded_ms: 900,
            paused_ms: 0,
            max_duration_ms: 1000,
            system_audio: false,
            spans: vec![],
        };
        fs::write(
            failed.join("journals").join(&legacy_key),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        save_failed_at(
            &failed,
            &FailedSegment {
                id: "note".into(),
                segment_id: legacy_key.clone(),
                reason: "stopped_journal_invalid".into(),
                error: "old read failure".into(),
                journal: original.clone(),
                quarantined_journal: None,
            },
        )
        .unwrap();
        let found = list_failed_at(&failed).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].quarantined_journal.as_deref(),
            Some(legacy_key.as_str())
        );
        retry_quarantined_at(
            &stopped,
            &failed,
            &found[0],
            || Ok(()),
            |restored| {
                assert_eq!(restored, &original);
                Ok(())
            },
        )
        .unwrap();
        assert!(list_failed_at(&failed).unwrap().is_empty());
        assert_eq!(
            serde_json::from_slice::<Journal>(&fs::read(stopped.join("note.json")).unwrap())
                .unwrap(),
            original
        );
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
        assert!(serde_json::from_value::<Journal>(old_journal)
            .unwrap()
            .spans
            .is_empty());
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
            quarantined_journal: None,
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
