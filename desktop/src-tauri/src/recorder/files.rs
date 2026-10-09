//! File storage for the shared voice-note store. IDs, never paths, cross IPC.
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rustix::fs::{Mode, OFlags};
use tauri::Manager;
use tauri_plugin_settings::SettingsPluginExt;

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

fn normalize_and_import_at(
    root: &Path,
    sessions: &Path,
    id: &str,
    segment_id: &str,
    source: &Path,
    system_audio: bool,
) -> Result<(), String> {
    if !valid_id(segment_id) || !segment_id.starts_with("rec-") {
        return Err("invalid_segment_id".into());
    }
    let done = root.join(format!("{id}.{segment_id}.imported"));
    if !done.exists() {
        let normalized = source
            .parent()
            .ok_or("missing_capture_session")?
            .join("audio.mono.mp3");
        normalize_mp3(source, &normalized, system_audio)?;
        import_at(root, id, segment_id, &normalized)?;
    }
    // The marker and audio file are synced by import_at. A crash before this
    // cleanup is harmless: a retry sees the marker and removes the source.
    remove_source_session(sessions, segment_id)
}

fn normalize_mp3(source: &Path, output: &Path, system_audio: bool) -> Result<(), String> {
    if output.exists() {
        return Ok(());
    }
    let decoded = output.with_extension("decoded.wav");
    anlg_mp3::decode_to_wav(source, &decoded).map_err(|e| format!("decode_failed: {e}"))?;
    let result = encode_mono_wav(&decoded, output, system_audio);
    let _ = fs::remove_file(decoded);
    result
}

fn encode_mono_wav(wav: &Path, output: &Path, system_audio: bool) -> Result<(), String> {
    let mut reader = hound::WavReader::open(wav).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    if !matches!(spec.channels, 1 | 2)
        || spec.sample_format != hound::SampleFormat::Float
        || spec.bits_per_sample != 32
    {
        return Err("unsupported_capture_pcm".into());
    }
    let mut encoder =
        anlg_mp3::MonoStreamEncoder::new(spec.sample_rate).map_err(|e| e.to_string())?;
    let temp = output.with_extension("mp3.tmp");
    let mut target = File::create(&temp).map_err(|e| e.to_string())?;
    let mut samples = reader.samples::<f32>();
    let mut mono = Vec::with_capacity(4096);
    let mut encoded = Vec::new();
    loop {
        mono.clear();
        for _ in 0..4096 {
            let Some(left) = samples.next() else {
                break;
            };
            let left = left.map_err(|e| e.to_string())?;
            let value = if spec.channels == 2 {
                let right = samples
                    .next()
                    .ok_or("incomplete_stereo_frame")?
                    .map_err(|e| e.to_string())?;
                if system_audio {
                    ((left + right) * 0.5).clamp(-1.0, 1.0)
                } else {
                    left
                }
            } else {
                left
            };
            mono.push(value);
        }
        if mono.is_empty() {
            break;
        }
        encoded.clear();
        encoder
            .encode_f32(&mono, &mut encoded)
            .map_err(|e| e.to_string())?;
        target.write_all(&encoded).map_err(|e| e.to_string())?;
    }
    encoded.clear();
    encoder.flush(&mut encoded).map_err(|e| e.to_string())?;
    target.write_all(&encoded).map_err(|e| e.to_string())?;
    target.sync_all().map_err(|e| e.to_string())?;
    fs::rename(temp, output).map_err(|e| e.to_string())?;
    File::open(output.parent().ok_or("missing_capture_session")?)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
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

pub fn remove_source_session(sessions: &Path, segment_id: &str) -> Result<(), String> {
    if !valid_id(segment_id) || !segment_id.starts_with("rec-") {
        return Err("invalid_segment_id".into());
    }
    let path = sessions.join(segment_id);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?
        }
        Ok(_) => return Err("capture_session_not_directory".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    }
    File::open(sessions)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
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

/** A staged, sealed copy made from bounded AudioBlobStore reads for anarlog's file-path batch API. */
#[tauri::command]
pub fn recorder_whisper_audio_path(app: tauri::AppHandle, id: String) -> Result<String, String> {
    whisper_audio_path_at(&root(&app)?, &id).map(|path| path.to_string_lossy().into_owned())
}

fn whisper_audio_path_at(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !id.starts_with("whisper-") {
        return Err("invalid_whisper_stage".into());
    }
    let path = audio_path(dir, id)?;
    let marker = sealed_path(dir, id)?;
    if !marker.is_file()
        || open_read(dir, id)?
            .metadata()
            .map_err(|e| e.to_string())?
            .len()
            == 0
    {
        return Err("whisper_stage_not_ready".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn delete_audio_file(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = root(&app)?;
    let sessions = sessions_root(&app)?;
    delete_at(&root, &sessions, &id)?;
    if let Some(pending) = super::journal::load(&app)? {
        if pending.id == id {
            if let Some(segment_id) = pending.segment_id {
                remove_source_session(&sessions, &segment_id)?;
                super::journal::remove_failed_source(&app, &segment_id)?;
            }
        }
    }
    super::journal::delete_failed_for_note(&app, &id)
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

    #[test]
    fn whisper_stage_requires_a_sealed_nonempty_file_and_rejects_other_ids() {
        let root = std::env::temp_dir().join(format!("exo-whisper-stage-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(whisper_audio_path_at(&root, "note").is_err());
        assert!(whisper_audio_path_at(&root, "whisper-../escape").is_err());
        append(&root, "whisper-note", b"mp3").unwrap();
        assert!(whisper_audio_path_at(&root, "whisper-note").is_err());
        fs::write(sealed_path(&root, "whisper-note").unwrap(), b"").unwrap();
        assert_eq!(
            whisper_audio_path_at(&root, "whisper-note").unwrap(),
            root.join("whisper-note.mp3")
        );
        fs::remove_dir_all(root).unwrap();
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

    #[test]
    fn actual_import_pipeline_produces_mono_64k_for_both_capture_modes() {
        for system_audio in [false, true] {
            let base = std::env::temp_dir().join(format!("exo-mono-test-{}", uuid::Uuid::new_v4()));
            let root = base.join("audio");
            let sessions = base.join("sessions");
            let source = sessions.join("rec-fixture");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir_all(&source).unwrap();
            let wav = source.join("audio.wav");
            let spec = hound::WavSpec {
                channels: 2,
                sample_rate: 16_000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut writer = hound::WavWriter::create(&wav, spec).unwrap();
            for frame in 0..16_000 {
                let mic = ((frame as f32 * 440.0 * std::f32::consts::TAU / 16_000.0).sin()) * 0.25;
                writer.write_sample(mic).unwrap();
                // A separate inverse channel makes the two policies observably
                // different: mic-only keeps the left signal, mixing cancels it.
                writer.write_sample(-mic).unwrap();
            }
            writer.finalize().unwrap();
            // Exercise the pinned upstream encoder, then the exact import path.
            let upstream = source.join("audio.mp3");
            anlg_mp3::encode_wav(&wav, &upstream).unwrap();
            normalize_and_import_at(
                &root,
                &sessions,
                "note",
                "rec-fixture",
                &upstream,
                system_audio,
            )
            .unwrap();
            assert!(!source.exists());
            let note = root.join("note.mp3");
            let decoded = root.join("verified.wav");
            anlg_mp3::decode_to_wav(&note, &decoded).unwrap();
            let samples: Vec<f32> = hound::WavReader::open(&decoded)
                .unwrap()
                .samples::<f32>()
                .map(Result::unwrap)
                .collect();
            let mean =
                samples.iter().map(|sample| sample.abs()).sum::<f32>() / samples.len() as f32;
            if system_audio {
                assert!(mean < 0.03, "system mix was not mono: {mean}");
            } else {
                assert!(mean > 0.10, "mic channel was lost: {mean}");
            }
            let probe = std::process::Command::new("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=channels,sample_rate,bit_rate",
                    "-of",
                    "default=noprint_wrappers=1",
                ])
                .arg(&note)
                .output()
                .expect("ffprobe is required to verify the real capture encode");
            assert!(probe.status.success());
            let report = String::from_utf8(probe.stdout).unwrap();
            assert!(report.contains("channels=1"), "{report}");
            assert!(report.contains("sample_rate=16000"), "{report}");
            assert!(report.contains("bit_rate=64000"), "{report}");
            fs::remove_dir_all(base).unwrap();
        }
    }
}
