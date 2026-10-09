//! File storage for the shared voice-note store. IDs, never paths, cross IPC.
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rustix::fs::{Mode, OFlags};
use tauri::Manager;

const MAX_CHUNK: usize = 4 * 1024 * 1024;

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn valid_recording_id(id: &str) -> bool {
    valid_id(id)
}

pub fn import_segment(
    app: &tauri::AppHandle,
    id: &str,
    segment_id: &str,
    path: &Path,
) -> Result<(), String> {
    import_at(&root(app)?, id, segment_id, path)
}

fn import_at(root: &Path, id: &str, segment_id: &str, path: &Path) -> Result<(), String> {
    if !valid_id(id) {
        return Err("invalid_recording_id".into());
    }
    if !valid_id(segment_id) {
        return Err("invalid_segment_id".into());
    }
    let marker_base = format!("{id}.{segment_id}");
    let pending = root.join(format!("{marker_base}.importing"));
    let done = root.join(format!("{marker_base}.imported"));
    if done.exists() {
        return Ok(());
    }
    let mut source = File::from(
        rustix::fs::open(path, OFlags::RDONLY | OFlags::NOFOLLOW, Mode::empty())
            .map_err(|e| e.to_string())?,
    );
    if !source.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("capture_audio_not_regular_file".into());
    }
    let dest = audio_path(root, id)?;
    let base_size = if pending.exists() {
        let base_size = fs::read_to_string(&pending)
            .map_err(|e| e.to_string())?
            .parse::<u64>()
            .map_err(|e| e.to_string())?;
        if base_size > 0 && fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) < base_size {
            return Err("audio_corrupt_before_import".into());
        }
        base_size
    } else {
        let size = fs::metadata(&dest)
            .map(|m| m.len())
            .or_else(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Ok(0)
                } else {
                    Err(e)
                }
            })
            .map_err(|e| e.to_string())?;
        let mut marker = File::create(&pending).map_err(|e| e.to_string())?;
        marker
            .write_all(size.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        marker.sync_all().map_err(|e| e.to_string())?;
        File::open(root)
            .and_then(|d| d.sync_all())
            .map_err(|e| e.to_string())?;
        size
    };
    let mut target = File::from(
        rustix::fs::open(
            &dest,
            OFlags::WRONLY | OFlags::CREATE | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|e| e.to_string())?,
    );
    target.set_len(base_size).map_err(|e| e.to_string())?;
    target
        .seek(SeekFrom::Start(base_size))
        .map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let count = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        target
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
    }
    target.sync_all().map_err(|e| e.to_string())?;
    fs::rename(pending, done).map_err(|e| e.to_string())?;
    File::open(root)
        .and_then(|d| d.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn audio_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid_recording_id".into());
    }
    Ok(root.join(format!("{id}.mp3")))
}

fn sealed_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid_recording_id".into());
    }
    Ok(root.join(format!("{id}.sealed")))
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voice-notes")
        .join("audio");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn open_read(root: &Path, id: &str) -> Result<File, String> {
    let path = audio_path(root, id)?;
    let file = File::from(
        rustix::fs::open(&path, OFlags::RDONLY | OFlags::NOFOLLOW, Mode::empty())
            .map_err(|e| e.to_string())?,
    );
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("audio_not_regular_file".into());
    }
    Ok(file)
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
            OFlags::WRONLY | OFlags::CREATE | OFlags::APPEND | OFlags::NOFOLLOW,
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
pub fn append_audio_chunk(
    app: tauri::AppHandle,
    id: String,
    bytes: Vec<u8>,
) -> Result<u64, String> {
    append(&root(&app)?, &id, &bytes)
}

#[tauri::command]
pub fn audio_file_size(app: tauri::AppHandle, id: String) -> Result<u64, String> {
    let root = root(&app)?;
    let path = audio_path(&root, &id)?;
    match rustix::fs::open(&path, OFlags::RDONLY | OFlags::NOFOLLOW, Mode::empty()) {
        Ok(fd) => File::from(fd)
            .metadata()
            .map(|m| m.len())
            .map_err(|e| e.to_string()),
        Err(rustix::io::Errno::NOENT) => Ok(0),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn read_audio_chunk(
    app: tauri::AppHandle,
    id: String,
    offset: u64,
    len: u32,
) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(read(
        &root(&app)?,
        &id,
        offset,
        len,
    )?))
}

#[tauri::command]
pub fn finalize_audio_file(app: tauri::AppHandle, id: String) -> Result<u64, String> {
    let root = root(&app)?;
    let file = open_read(&root, &id)?;
    file.sync_all().map_err(|e| e.to_string())?;
    let size = file
        .metadata()
        .map(|m| m.len())
        .map_err(|e| e.to_string())?;
    let marker = sealed_path(&root, &id)?;
    let seal = File::from(
        rustix::fs::open(
            &marker,
            OFlags::WRONLY | OFlags::CREATE | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|e| e.to_string())?,
    );
    seal.sync_all().map_err(|e| e.to_string())?;
    File::open(&root)
        .and_then(|d| d.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(size)
}

#[tauri::command]
pub fn delete_audio_file(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = root(&app)?;
    let path = audio_path(&root, &id)?;
    let marker = sealed_path(&root, &id)?;
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
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&format!("{id}.rec-"))
            && (name.ends_with(".importing") || name.ends_with(".imported"))
        {
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    File::open(&root)
        .and_then(|d| d.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn interrupted_segment_import_retries_without_duplicate_bytes() {
        let root = std::env::temp_dir().join(format!("exo-import-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("segment.mp3");
        fs::write(&source, b"second").unwrap();
        fs::write(root.join("note.mp3"), b"firsthalf").unwrap();
        fs::write(root.join("note.rec-segment.importing"), b"5").unwrap();

        import_at(&root, "note", "rec-segment", &source).unwrap();
        assert_eq!(read(&root, "note", 0, 20).unwrap(), b"firstsecond");
        import_at(&root, "note", "rec-segment", &source).unwrap();
        assert_eq!(read(&root, "note", 0, 20).unwrap(), b"firstsecond");
        fs::remove_dir_all(root).unwrap();
    }
}
