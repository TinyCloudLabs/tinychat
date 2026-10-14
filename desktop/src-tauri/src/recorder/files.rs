//! File storage for the shared voice-note store. IDs, never paths, cross IPC.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(test)]
use exo_local_transcription::audio_import::import_at;
pub use exo_local_transcription::audio_import::remove_source_session;
use exo_local_transcription::audio_import::{audio_path, normalize_and_import_at, valid_id};
use rustix::fs::{Mode, OFlags};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri_plugin_settings::SettingsPluginExt;

const MAX_CHUNK: usize = 4 * 1024 * 1024;
// All stage writers and removers, including launch cleanup and note deletion,
// must agree on one lock. File descriptors still enforce the on-disk boundary.
static STAGE_LOCK: Mutex<()> = Mutex::new(());

pub fn valid_recording_id(id: &str) -> bool {
    valid_id(id)
}

pub fn import_segment(
    app: &tauri::AppHandle,
    id: &str,
    segment_id: &str,
    path: &Path,
    system_audio: bool,
) -> Result<(), String> {
    normalize_and_import_at(
        &root(app)?,
        &sessions_root(app)?,
        id,
        segment_id,
        path,
        system_audio,
    )
}

pub fn sessions_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let vault = app.settings().vault_base().map_err(|e| e.to_string())?;
    Ok(Path::new(vault.as_str()).join("sessions"))
}

pub fn segment_imported(
    app: &tauri::AppHandle,
    id: &str,
    segment_id: &str,
) -> Result<bool, String> {
    if !valid_id(id) || !valid_id(segment_id) {
        return Err("invalid_segment_id".into());
    }
    Ok(root(app)?
        .join(format!("{id}.{segment_id}.imported"))
        .exists())
}

fn sealed_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid_recording_id".into());
    }
    Ok(root.join(format!("{id}.sealed")))
}

pub(crate) fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voice-notes")
        .join("audio");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

pub(super) fn open_read(root: &Path, id: &str) -> Result<File, String> {
    let path = audio_path(root, id)?;
    let file = File::from(
        rustix::fs::open(
            &path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|error| {
            let io_error = std::io::Error::from(error);
            if io_error.kind() == std::io::ErrorKind::NotFound {
                "not_found".into()
            } else {
                io_error.to_string()
            }
        })?,
    );
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("audio_not_regular_file".into());
    }
    Ok(file)
}

pub(crate) fn open_sealed(root: &Path, id: &str) -> Result<File, String> {
    if !sealed_path(root, id)?.exists() {
        return Err("audio_not_ready".into());
    }
    open_read(root, id)
}

fn append(root: &Path, id: &str, bytes: &[u8]) -> Result<u64, String> {
    if bytes.len() > MAX_CHUNK {
        return Err("audio_chunk_too_large".into());
    }
    if sealed_path(root, id)?.exists() {
        return Err("audio_finalized".into());
    }
    let path = audio_path(root, id)?;
    let mut file = File::from(
        rustix::fs::open(
            &path,
            OFlags::WRONLY | OFlags::CREATE | OFlags::APPEND | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|e| e.to_string())?,
    );
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("audio_not_regular_file".into());
    }
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_data().map_err(|e| e.to_string())?;
    file.metadata().map(|m| m.len()).map_err(|e| e.to_string())
}

fn read(root: &Path, id: &str, offset: u64, len: u32) -> Result<Vec<u8>, String> {
    if len as usize > MAX_CHUNK {
        return Err("audio_chunk_too_large".into());
    }
    let mut file = open_read(root, id)?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if offset >= size {
        return Ok(Vec::new());
    }
    let count = (len as u64).min(size - offset) as usize;
    let mut bytes = vec![0; count];
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[tauri::command]
pub async fn append_audio_chunk(
    app: tauri::AppHandle,
    id: String,
    bytes: Vec<u8>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        append(&root(&app)?, &id, &bytes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn audio_file_size(app: tauri::AppHandle, id: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        let root = root(&app)?;
        let path = audio_path(&root, &id)?;
        match rustix::fs::open(
            &path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(fd) => {
                let meta = File::from(fd).metadata().map_err(|e| e.to_string())?;
                if !meta.is_file() {
                    return Err("audio_not_regular_file".into());
                }
                Ok(meta.len())
            }
            Err(rustix::io::Errno::NOENT) => Ok(0),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_audio_chunk(
    app: tauri::AppHandle,
    id: String,
    offset: u64,
    len: u32,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        Ok(tauri::ipc::Response::new(read(
            &root(&app)?,
            &id,
            offset,
            len,
        )?))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn finalize_audio_file(app: tauri::AppHandle, id: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        finalize_at(&root(&app)?, &id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn finalize_at(root: &Path, id: &str) -> Result<u64, String> {
    let file = open_read(root, id)?;
    file.sync_all().map_err(|e| e.to_string())?;
    let size = file
        .metadata()
        .map(|m| m.len())
        .map_err(|e| e.to_string())?;
    let marker = sealed_path(root, id)?;
    let seal = File::from(
        rustix::fs::open(
            &marker,
            OFlags::WRONLY | OFlags::CREATE | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|e| e.to_string())?,
    );
    seal.sync_all().map_err(|e| e.to_string())?;
    File::open(root)
        .and_then(|d| d.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(size)
}

/** Copy a sealed note into a guarded vault session; no path crosses IPC. */
#[tauri::command]
pub async fn recorder_whisper_stage_audio(
    app: tauri::AppHandle,
    id: String,
    stage_id: String,
) -> Result<(), String> {
    super::ensure(&app);
    let dir = root(&app)?;
    let sessions = sessions_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || stage_whisper_at(&dir, &sessions, &id, &stage_id))
        .await
        .map_err(|error| error.to_string())?
}

fn whisper_stage_id(id: &str) -> Result<String, String> {
    if !valid_id(id) || id.starts_with("whisper-") {
        return Err("invalid_recording_id".into());
    }
    let digest = Sha256::digest(id.as_bytes());
    Ok(format!("whisper-{}", hex::encode(&digest[..16])))
}

const STAGE_MARKER: &str = ".exo-whisper-stage";

fn stage_session_id(stage_id: &str) -> Result<String, String> {
    let hex = stage_id
        .strip_prefix("whisper-")
        .ok_or("invalid_whisper_stage")?;
    if hex.len() != 32 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid_whisper_stage".into());
    }
    let uuid = uuid::Uuid::parse_str(hex).map_err(|_| "invalid_whisper_stage")?;
    Ok(uuid.hyphenated().to_string())
}

fn stage_marker(session: &rustix::fd::OwnedFd, stage_id: &str) -> Result<bool, String> {
    let marker = match rustix::fs::openat(
        session,
        STAGE_MARKER,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    let marker = File::from(marker);
    if !marker.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("unsafe_whisper_stage".into());
    }
    let mut content = String::new();
    marker
        .take(64)
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    if content != stage_id {
        return Err("unsafe_whisper_stage".into());
    }
    Ok(true)
}
// An interrupted older removal can leave a marker-less derived session. Only
// reclaim it when it contains nothing except a byte-for-byte copy (or partial
// prefix) of this note; a squatted session with unrelated data stays untouched.
fn orphan_matches_note(
    root: &Path,
    id: &str,
    session: &rustix::fd::OwnedFd,
) -> Result<bool, String> {
    let mut entries = rustix::fs::Dir::read_from(session).map_err(|e| e.to_string())?;
    while let Some(entry) = entries.read() {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(name) = entry.file_name().to_str().ok() else {
            return Ok(false);
        };
        if name == "." || name == ".." {
            continue;
        }
        if !matches!(name, "audio.mp3" | "audio.mp3.tmp") {
            return Ok(false);
        }
        let mut orphan = File::from(
            rustix::fs::openat(
                session,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|e| e.to_string())?,
        );
        let length = orphan.metadata().map_err(|e| e.to_string())?;
        if !length.is_file() {
            return Ok(false);
        }
        let mut source = open_read(root, id)?;
        let source_len = source.metadata().map_err(|e| e.to_string())?.len();
        if length.len() > source_len || (name == "audio.mp3" && length.len() != source_len) {
            return Ok(false);
        }
        let mut original = [0u8; 8192];
        let mut copy = [0u8; 8192];
        let mut remaining = length.len();
        while remaining > 0 {
            let count = remaining.min(original.len() as u64) as usize;
            source
                .read_exact(&mut original[..count])
                .map_err(|e| e.to_string())?;
            orphan
                .read_exact(&mut copy[..count])
                .map_err(|e| e.to_string())?;
            if original[..count] != copy[..count] {
                return Ok(false);
            }
            remaining -= count as u64;
        }
    }
    Ok(true)
}

fn derived_stages(dir: &Path) -> Result<HashMap<String, (String, String)>, String> {
    let mut stages = HashMap::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(id) = name.strip_suffix(".sealed") else {
            continue;
        };
        if valid_id(id)
            && !id.starts_with("whisper-")
            && entry.file_type().map_err(|e| e.to_string())?.is_file()
        {
            let stage = whisper_stage_id(id)?;
            stages.insert(stage_session_id(&stage)?, (stage, id.to_owned()));
        }
    }
    Ok(stages)
}

fn remove_stage_for_note_locked(
    root: &Path,
    sessions: &Path,
    id: &str,
    stage_id: &str,
) -> Result<u64, String> {
    let session_id = stage_session_id(stage_id)?;
    let session = match crate::session_audio::open_session_dir(sessions, &session_id) {
        Ok(fd) => fd,
        Err((_, rustix::io::Errno::NOENT)) => return Ok(0),
        Err((_, e)) => return Err(e.to_string()),
    };
    let marked = stage_marker(&session, stage_id)?;
    if !marked && !orphan_matches_note(root, id, &session)? {
        return Err("unsafe_whisper_stage".into());
    }
    remove_stage_locked(sessions, stage_id, !marked)
}

pub(crate) fn staged_session(sessions: &Path, id: &str, stage_id: &str) -> Result<String, String> {
    if stage_id != whisper_stage_id(id)? {
        return Err("invalid_whisper_stage".into());
    }
    let session_id = stage_session_id(stage_id)?;
    let session = crate::session_audio::open_session_dir(sessions, &session_id)
        .map_err(|(_, e)| e.to_string())?;
    if !stage_marker(&session, stage_id)? {
        return Err("audio_not_staged".into());
    }
    Ok(session_id)
}

fn stage_whisper_at(dir: &Path, sessions: &Path, id: &str, stage_id: &str) -> Result<(), String> {
    let _guard = STAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if stage_id != whisper_stage_id(id)? {
        return Err("invalid_whisper_stage".into());
    }
    let seal = sealed_path(dir, id)?;
    let seal = File::from(
        rustix::fs::open(
            &seal,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|e| e.to_string())?,
    );
    if !seal.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("audio_not_finalized".into());
    }
    let mut source = open_read(dir, id)?;
    if source.metadata().map_err(|e| e.to_string())?.len() == 0 {
        return Err("audio_empty".into());
    }
    let session_id = stage_session_id(stage_id)?;
    let mut reservation = match crate::session_audio::prepare_capture_dir(sessions, &session_id) {
        Ok(prepared) => Some(prepared),
        Err(e) if e.code == "session_exists" => None,
        Err(e) => return Err(format!("{}: {}", e.code, e.message)),
    };
    let session = crate::session_audio::open_session_dir(sessions, &session_id)
        .map_err(|(_, e)| e.to_string())?;
    if reservation.is_none() {
        if !stage_marker(&session, stage_id)? {
            return Err("unsafe_whisper_stage".into());
        }
    } else {
        let mut marker = File::from(
            rustix::fs::openat(
                &session,
                STAGE_MARKER,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(|e| e.to_string())?,
        );
        let written = marker
            .write_all(stage_id.as_bytes())
            .and_then(|_| marker.sync_all());
        if let Err(error) = written {
            drop(marker);
            let _ = rustix::fs::unlinkat(&session, STAGE_MARKER, rustix::fs::AtFlags::empty());
            return Err(error.to_string());
        }
        reservation.as_mut().unwrap().started();
    }
    match rustix::fs::unlinkat(&session, "audio.mp3.tmp", rustix::fs::AtFlags::empty()) {
        Ok(()) | Err(rustix::io::Errno::NOENT) => {}
        Err(e) => return Err(e.to_string()),
    }
    let mut target = File::from(
        rustix::fs::openat(
            &session,
            "audio.mp3.tmp",
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|e| e.to_string())?,
    );
    let copied = std::io::copy(&mut source, &mut target).map_err(|e| e.to_string())?;
    if copied == 0 {
        return Err("audio_empty".into());
    }
    target.sync_all().map_err(|e| e.to_string())?;
    rustix::fs::renameat(&session, "audio.mp3.tmp", &session, "audio.mp3")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn recorder_whisper_cleanup_stages(app: tauri::AppHandle) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        cleanup_whisper_stages_at(&root(&app)?, &sessions_root(&app)?)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
fn remove_stage_at(sessions: &Path, stage_id: &str) -> Result<u64, String> {
    let _guard = STAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    remove_stage_locked(sessions, stage_id, false)
}

fn remove_stage_locked(
    sessions: &Path,
    stage_id: &str,
    verified_orphan: bool,
) -> Result<u64, String> {
    let id = stage_session_id(stage_id)?;
    let session = match crate::session_audio::open_session_dir(sessions, &id) {
        Ok(fd) => fd,
        Err((_, rustix::io::Errno::NOENT)) => return Ok(0),
        Err((_, e)) => return Err(e.to_string()),
    };
    if !verified_orphan && !stage_marker(&session, stage_id)? {
        return Err("unsafe_whisper_stage".into());
    }
    for name in ["audio.mp3.tmp", "audio.mp3", STAGE_MARKER] {
        match rustix::fs::unlinkat(&session, name, rustix::fs::AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    let root = rustix::fs::open(
        sessions,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|e| e.to_string())?;
    rustix::fs::unlinkat(&root, id.as_str(), rustix::fs::AtFlags::REMOVEDIR)
        .map_err(|e| e.to_string())?;
    Ok(1)
}

fn cleanup_whisper_stages_at(dir: &Path, sessions: &Path) -> Result<u64, String> {
    let _guard = STAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut derived = None;
    let mut removed = 0;
    // Also clear pre-migration temporary copies in the old app-data store.
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let stem = [".mp3", ".sealed", ".mp3.tmp"]
            .iter()
            .find_map(|suffix| name.strip_suffix(suffix));
        let Some(hex) = stem.and_then(|value| value.strip_prefix("whisper-")) else {
            continue;
        };
        if hex.len() != 32 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            return Err("whisper_stage_not_file".into());
        }
        fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        removed += 1;
    }
    let root = match rustix::fs::open(
        sessions,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(removed),
        Err(e) => return Err(e.to_string()),
    };
    let mut entries = rustix::fs::Dir::read_from(&root).map_err(|e| e.to_string())?;
    while let Some(entry) = entries.read() {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(name) = entry.file_name().to_str().ok() else {
            continue;
        };
        if uuid::Uuid::parse_str(name).is_err() {
            continue;
        }
        let session = rustix::fs::openat(
            &root,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|e| e.to_string())?;
        let marker = match rustix::fs::openat(
            &session,
            STAGE_MARKER,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => {
                let stages = match &derived {
                    Some(stages) => stages,
                    None => derived.insert(derived_stages(dir)?),
                };
                if let Some((stage, id)) = stages.get(name) {
                    if orphan_matches_note(dir, id, &session)? {
                        removed += remove_stage_locked(sessions, stage, true)?;
                    }
                }
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let marker = File::from(marker);
        if !marker.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("unsafe_whisper_stage".into());
        }
        let mut stage_id = String::new();
        marker
            .take(64)
            .read_to_string(&mut stage_id)
            .map_err(|e| e.to_string())?;
        if stage_session_id(&stage_id)? != name {
            return Err("unsafe_whisper_stage".into());
        }
        removed += remove_stage_locked(sessions, &stage_id, false)?;
    }
    Ok(removed)
}

#[tauri::command]
pub async fn delete_audio_file(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ensure(&app);
        super::with_import_lock(|| {
            let root = root(&app)?;
            let sessions = sessions_root(&app)?;
            let note_cleanup = delete_note_at(&root, &sessions, &id);
            let segment_cleanup = (|| {
                if let Some(stopped) = super::journal::load_stopped(&app, &id)? {
                    if let Some(segment_id) = stopped.segment_id {
                        remove_source_session(&sessions, &segment_id)?;
                        super::journal::remove_failed_source(&app, &segment_id)?;
                    }
                    super::journal::clear_stopped(&app, &id)?;
                    super::refresh_finishing_quit(&app)?;
                }
                if let Some(pending) = super::journal::load(&app)? {
                    if pending.id == id {
                        if let Some(segment_id) = pending.segment_id {
                            remove_source_session(&sessions, &segment_id)?;
                            super::journal::remove_failed_source(&app, &segment_id)?;
                        }
                        super::journal::clear(&app)?;
                    }
                }
                super::journal::delete_failed_for_note(&app, &id)
            })();
            note_cleanup.and(segment_cleanup)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn delete_note_at(root: &Path, sessions: &Path, id: &str) -> Result<(), String> {
    let _guard = STAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if id.starts_with("whisper-") {
        let stage_cleanup = remove_stage_locked(sessions, id, false);
        let note_cleanup = delete_at(root, sessions, id);
        stage_cleanup?;
        note_cleanup?;
        remove_if_present(&root.join(format!("{id}.mp3.tmp")))?;
    } else {
        let stage = whisper_stage_id(id)?;
        let stage_cleanup = remove_stage_for_note_locked(root, sessions, id, &stage)
            .and_then(|_| delete_at(root, sessions, &stage))
            .and_then(|_| remove_if_present(&root.join(format!("{stage}.mp3.tmp"))));
        let note_cleanup = delete_at(root, sessions, id);
        stage_cleanup?;
        note_cleanup?;
    }
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn delete_at(root: &Path, sessions: &Path, id: &str) -> Result<(), String> {
    let path = audio_path(root, id)?;
    let marker = sealed_path(root, id)?;
    match fs::remove_file(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    match fs::remove_file(marker) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&format!("{id}.rec-"))
            && (name.ends_with(".importing") || name.ends_with(".imported"))
        {
            let segment_id = name
                .strip_prefix(&format!("{id}."))
                .and_then(|value| {
                    value
                        .strip_suffix(".importing")
                        .or_else(|| value.strip_suffix(".imported"))
                })
                .ok_or("invalid_segment_marker")?;
            remove_source_session(sessions, segment_id)?;
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    File::open(root)
        .and_then(|d| d.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retry_fixture(root: &Path, source: &Path, failed: &Path) {
        if failed.exists() {
            import_at(root, "note", "rec-segment", source).unwrap();
            fs::remove_file(failed).unwrap();
        }
    }

    fn fixture_step(root: &Path, sessions: &Path, failed: &Path, retry: bool) {
        if retry {
            retry_fixture(root, &sessions.join("rec-segment/audio.mp3"), failed);
        } else {
            delete_note_at(root, sessions, "note").unwrap();
            remove_source_session(sessions, "rec-segment").unwrap();
            if failed.exists() {
                fs::remove_file(failed).unwrap();
            }
        }
    }

    #[test]
    fn parallel_retries_import_one_segment_once() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("audio");
        fs::create_dir(&root).unwrap();
        let source = base.path().join("segment.mp3");
        let failed = base.path().join("failed.json");
        fs::write(&source, b"second").unwrap();
        fs::write(root.join("note.mp3"), b"first").unwrap();
        fs::write(&failed, b"pending").unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let (root, source, failed, start) =
                    (root.clone(), source.clone(), failed.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    super::super::with_import_lock(|| retry_fixture(&root, &source, &failed));
                })
            })
            .collect();
        start.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(fs::read(root.join("note.mp3")).unwrap(), b"firstsecond");
        assert!(root.join("note.rec-segment.imported").exists());
        assert!(!failed.exists());
    }

    #[test]
    fn retry_and_delete_cannot_resurrect_audio() {
        for retry_first in [true, false] {
            let base = tempfile::tempdir().unwrap();
            let root = base.path().join("audio");
            let sessions = base.path().join("sessions");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&sessions).unwrap();
            let source = sessions.join("rec-segment");
            fs::create_dir(&source).unwrap();
            fs::write(source.join("audio.mp3"), b"segment").unwrap();
            let failed = base.path().join("failed.json");
            fs::write(&failed, b"pending").unwrap();
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let first_paths = (root.clone(), sessions.clone(), failed.clone());
            let first = std::thread::spawn(move || {
                super::super::with_import_lock(|| {
                    ready_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    fixture_step(&first_paths.0, &first_paths.1, &first_paths.2, retry_first);
                });
            });
            ready_rx.recv().unwrap();
            let second_paths = (root.clone(), sessions.clone(), failed.clone());
            let second = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                super::super::with_import_lock(|| {
                    fixture_step(
                        &second_paths.0,
                        &second_paths.1,
                        &second_paths.2,
                        !retry_first,
                    );
                });
            });
            started_rx.recv().unwrap();
            release_tx.send(()).unwrap();
            first.join().unwrap();
            second.join().unwrap();
            assert!(!root.join("note.mp3").exists());
            assert!(!failed.exists());
        }
    }

    #[test]
    fn whisper_stage_copies_into_vault_and_delete_removes_only_its_session() {
        let base = std::env::temp_dir().join(format!("exo-whisper-stage-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        let stage = whisper_stage_id("note").unwrap();
        assert!(stage_whisper_at(&root, &sessions, "note", "whisper-wrong").is_err());
        append(&root, "note", b"mp3").unwrap();
        assert!(stage_whisper_at(&root, &sessions, "note", &stage).is_err());
        finalize_at(&root, "note").unwrap();
        stage_whisper_at(&root, &sessions, "note", &stage).unwrap();
        let session = staged_session(&sessions, "note", &stage).unwrap();
        let path = sessions.join(&session).join("audio.mp3");
        assert_eq!(fs::read(&path).unwrap(), b"mp3");
        assert!(!root.join(format!("{stage}.mp3")).exists());
        let other = sessions.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&other).unwrap();
        fs::write(other.join("audio.mp3"), b"unrelated").unwrap();
        stage_whisper_at(&root, &sessions, "note", &stage).unwrap();
        delete_note_at(&root, &sessions, "note").unwrap();
        assert!(!path.exists());
        assert!(other.join("audio.mp3").exists());
        assert!(!audio_path(&root, "note").unwrap().exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn squatted_stage_does_not_block_deletion_of_own_audio() {
        let base =
            std::env::temp_dir().join(format!("exo-squatted-stage-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        append(&root, "note", b"audio").unwrap();
        finalize_at(&root, "note").unwrap();
        let stage = whisper_stage_id("note").unwrap();
        let session = sessions.join(stage_session_id(&stage).unwrap());
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("audio.mp3"), b"unowned").unwrap();

        assert_eq!(
            delete_note_at(&root, &sessions, "note").unwrap_err(),
            "unsafe_whisper_stage"
        );
        assert!(!root.join("note.mp3").exists());
        assert!(!root.join("note.sealed").exists());
        assert_eq!(fs::read(session.join("audio.mp3")).unwrap(), b"unowned");
        assert!(!session.join(STAGE_MARKER).exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn stage_refuses_symlinked_root_and_unowned_session() {
        let base = std::env::temp_dir().join(format!("exo-stage-deny-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        append(&root, "note", b"audio").unwrap();
        finalize_at(&root, "note").unwrap();
        let stage = whisper_stage_id("note").unwrap();
        let session = stage_session_id(&stage).unwrap();
        fs::create_dir(&sessions).unwrap();
        fs::create_dir(sessions.join(&session)).unwrap();
        fs::write(sessions.join(&session).join("audio.mp3"), b"not ours").unwrap();
        assert!(stage_whisper_at(&root, &sessions, "note", &stage).is_err());
        assert_eq!(
            fs::read(sessions.join(&session).join("audio.mp3")).unwrap(),
            b"not ours"
        );
        fs::remove_dir_all(sessions.join(&session)).unwrap();
        stage_whisper_at(&root, &sessions, "note", &stage).unwrap();
        let marker = sessions.join(&session).join(STAGE_MARKER);
        fs::remove_file(&marker).unwrap();
        let sentinel = base.join("sentinel");
        fs::write(&sentinel, b"outside").unwrap();
        std::os::unix::fs::symlink(&sentinel, &marker).unwrap();
        assert!(staged_session(&sessions, "note", &stage).is_err());
        assert!(remove_stage_at(&sessions, &stage).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside");
        fs::remove_dir_all(&sessions).unwrap();
        let outside = base.join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, &sessions).unwrap();
        assert!(stage_whisper_at(&root, &sessions, "note", &stage).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn launch_cleanup_removes_only_marked_whisper_stages() {
        let base =
            std::env::temp_dir().join(format!("exo-whisper-cleanup-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir(&sessions).unwrap();
        let stage = whisper_stage_id("note").unwrap();
        fs::write(root.join(format!("{stage}.mp3.tmp")), b"old partial").unwrap();
        fs::write(root.join("note.mp3"), b"durable").unwrap();
        fs::write(root.join("note.sealed"), b"").unwrap();
        stage_whisper_at(&root, &sessions, "note", &stage).unwrap();
        let unrelated = sessions.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("audio.mp3"), b"other").unwrap();
        assert_eq!(cleanup_whisper_stages_at(&root, &sessions).unwrap(), 2);
        assert!(root.join("note.mp3").exists());
        assert!(unrelated.join("audio.mp3").exists());
        assert!(staged_session(&sessions, "note", &stage).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn reclaims_only_derived_markerless_copies_and_allows_restaging() {
        let base = std::env::temp_dir().join(format!("exo-orphan-stage-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        append(&root, "note", b"durable recording").unwrap();
        finalize_at(&root, "note").unwrap();
        let stage = whisper_stage_id("note").unwrap();
        let session = sessions.join(stage_session_id(&stage).unwrap());

        stage_whisper_at(&root, &sessions, "note", &stage).unwrap();
        fs::remove_file(session.join(STAGE_MARKER)).unwrap();
        assert_eq!(cleanup_whisper_stages_at(&root, &sessions).unwrap(), 1);
        assert!(!session.exists());
        stage_whisper_at(&root, &sessions, "note", &stage).unwrap();
        fs::remove_file(session.join(STAGE_MARKER)).unwrap();
        fs::rename(session.join("audio.mp3"), session.join("audio.mp3.tmp")).unwrap();
        assert_eq!(cleanup_whisper_stages_at(&root, &sessions).unwrap(), 1);
        stage_whisper_at(&root, &sessions, "note", &stage).unwrap();
        fs::remove_file(session.join(STAGE_MARKER)).unwrap();
        delete_note_at(&root, &sessions, "note").unwrap();
        assert!(!session.exists());
        assert!(!root.join("note.mp3").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn concurrent_stage_remove_and_cleanup_leave_no_markerless_copy() {
        use std::sync::Barrier;

        let base = std::env::temp_dir().join(format!("exo-stage-race-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        let audio = vec![7u8; 64 * 1024];
        append(&root, "note", &audio).unwrap();
        finalize_at(&root, "note").unwrap();
        let stage = whisper_stage_id("note").unwrap();
        let session = sessions.join(stage_session_id(&stage).unwrap());

        for cleanup in [false, true] {
            for _ in 0..500 {
                stage_whisper_at(&root, &sessions, "note", &stage).unwrap();
                let barrier = Barrier::new(2);
                std::thread::scope(|scope| {
                    let writer = scope.spawn(|| {
                        barrier.wait();
                        stage_whisper_at(&root, &sessions, "note", &stage)
                    });
                    let remover = scope.spawn(|| {
                        barrier.wait();
                        if cleanup {
                            cleanup_whisper_stages_at(&root, &sessions).map(|_| ())
                        } else {
                            remove_stage_at(&sessions, &stage).map(|_| ())
                        }
                    });
                    writer.join().unwrap().unwrap();
                    remover.join().unwrap().unwrap();
                });
                if session.exists() {
                    assert!(session.join(STAGE_MARKER).is_file());
                    assert_eq!(fs::read(session.join("audio.mp3")).unwrap(), audio);
                }
            }
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn deleting_while_staging_cannot_leave_a_note_copy() {
        use std::sync::Barrier;

        let base = std::env::temp_dir().join(format!("exo-delete-race-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        let stage = whisper_stage_id("note").unwrap();
        let session = sessions.join(stage_session_id(&stage).unwrap());
        for _ in 0..150 {
            append(&root, "note", &[7u8; 4096]).unwrap();
            finalize_at(&root, "note").unwrap();
            let barrier = Barrier::new(2);
            std::thread::scope(|scope| {
                let writer = scope.spawn(|| {
                    barrier.wait();
                    stage_whisper_at(&root, &sessions, "note", &stage)
                });
                let remover = scope.spawn(|| {
                    barrier.wait();
                    delete_note_at(&root, &sessions, "note")
                });
                let _ = writer.join().unwrap();
                remover.join().unwrap().unwrap();
            });
            assert!(!session.exists());
            assert!(!root.join("note.mp3").exists());
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn chunks_are_bounded_and_read_at_offsets() {
        let root = std::env::temp_dir().join(format!("exo-recorder-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let id = "test-file";
        assert_eq!(append(&root, id, b"abc").unwrap(), 3);
        assert_eq!(append(&root, id, b"def").unwrap(), 6);
        assert_eq!(read(&root, id, 2, 3).unwrap(), b"cde");
        assert_eq!(read(&root, id, 6, 3).unwrap(), b"");
        assert!(append(&root, "../escape", b"x").is_err());
        assert!(read(&root, id, 0, MAX_CHUNK as u32 + 1).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recorder_file_commands_reject_traversal_and_symlinked_audio() {
        let base =
            std::env::temp_dir().join(format!("exo-recorder-guard-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir(&sessions).unwrap();
        let outside = base.join("outside");
        fs::write(&outside, b"sentinel").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("note.mp3")).unwrap();
        assert!(append(&root, "note", b"tamper").is_err());
        assert!(read(&root, "note", 0, 8).is_err());
        assert!(finalize_at(&root, "note").is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"sentinel");
        assert!(read(&root, "../outside", 0, 8).is_err());
        assert!(delete_note_at(&root, &sessions, "../outside").is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"sentinel");
        fs::remove_file(root.join("note.mp3")).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(root.join("note.mp3"))
                .status()
                .unwrap()
                .success()
        );
        assert!(read(&root, "note", 0, 8).is_err());
        assert!(append(&root, "note", b"tamper").is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn deleting_note_removes_audio_and_every_segment_source() {
        let base = std::env::temp_dir().join(format!("exo-delete-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("audio");
        let sessions = base.join("sessions");
        let source = sessions.join("rec-first");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("audio.mp3"), b"fixture").unwrap();
        import_at(&root, "note", "rec-first", &source.join("audio.mp3")).unwrap();
        remove_source_session(&sessions, "rec-first").unwrap();
        let leftover = sessions.join("rec-second");
        fs::create_dir_all(&leftover).unwrap();
        fs::write(leftover.join("audio_mic.wav"), b"fixture").unwrap();
        fs::write(root.join("note.rec-second.importing"), b"7").unwrap();
        delete_at(&root, &sessions, "note").unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&sessions).unwrap().count(), 0);
        fs::remove_dir_all(base).unwrap();
    }
}
