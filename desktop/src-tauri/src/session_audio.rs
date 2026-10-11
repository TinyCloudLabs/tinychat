//! Shared descriptor-relative access to recordings in the current vault.

use rustix::fd::OwnedFd;
use rustix::fs::{AtFlags, Dir, FileType};
use std::ffi::CStr;
use std::os::unix::ffi::OsStrExt;
use uuid::Uuid;

use std::future::Future;

use std::fs::File;
use std::path::Path;

use rustix::fs::{Mode, OFlags};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Mp3,
    Wav,
    Ogg,
}

impl AudioFormat {
    pub fn from_file_name(name: &str) -> Option<Self> {
        match name {
            "audio.mp3" => Some(Self::Mp3),
            "audio.wav" => Some(Self::Wav),
            "audio.ogg" => Some(Self::Ogg),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
            Self::Ogg => "ogg",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Mp3 => "audio/mpeg",
            Self::Wav => "audio/wav",
            Self::Ogg => "audio/ogg",
        }
    }
}

pub const AUDIO_FILES: [&str; 3] = ["audio.mp3", "audio.wav", "audio.ogg"];

pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn open_session_dir(
    sessions_dir: &Path,
    session_id: &str,
) -> Result<rustix::fd::OwnedFd, (&'static str, rustix::io::Errno)> {
    let dir_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let sessions = rustix::fs::open(sessions_dir, dir_flags, Mode::empty())
        .map_err(|e| ("sessions folder", e))?;
    rustix::fs::openat(&sessions, session_id, dir_flags, Mode::empty())
        .map_err(|e| ("session folder", e))
}

pub fn open_audio(
    session: &rustix::fd::OwnedFd,
    file_name: &str,
) -> rustix::io::Result<rustix::fd::OwnedFd> {
    // A planted FIFO must never block a command waiting for audio.
    rustix::fs::openat(
        session,
        file_name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )
}

#[derive(Debug)]
pub struct SessionRecording {
    pub file: File,
    pub format: AudioFormat,
    pub file_name: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Rejection {
    pub code: &'static str,
    pub message: String,
}

fn unavailable(message: impl Into<String>) -> Rejection {
    Rejection {
        code: "recording_unavailable",
        message: message.into(),
    }
}

/// Probe in creation order so WAV-to-MP3 finalisation never creates a gap,
/// then choose in the plugin's preferred order. An unsafe candidate fails
/// closed even if another usable format exists.
pub fn open_session_recording(
    sessions_dir: &Path,
    id: &str,
) -> Result<SessionRecording, Rejection> {
    if !valid_session_id(id) {
        return Err(unavailable("Invalid recording session"));
    }
    let session = open_session_dir(sessions_dir, id)
        .map_err(|(what, e)| unavailable(format!("Opening {what}: {e}")))?;
    let mut found: [Option<File>; 3] = [None, None, None];
    for (index, file_name) in ["audio.wav", "audio.ogg", "audio.mp3"].iter().enumerate() {
        match open_audio(&session, file_name) {
            Ok(fd) => {
                let file = File::from(fd);
                let metadata = file
                    .metadata()
                    .map_err(|e| unavailable(format!("Reading recording: {e}")))?;
                if !metadata.is_file() || metadata.len() == 0 {
                    return Err(unavailable("The recording is not a non-empty regular file"));
                }
                found[index] = Some(file);
            }
            Err(rustix::io::Errno::NOENT) => {}
            Err(e) => return Err(unavailable(format!("Opening recording: {e}"))),
        }
    }
    for (index, file_name) in [
        (2, AUDIO_FILES[0]),
        (0, AUDIO_FILES[1]),
        (1, AUDIO_FILES[2]),
    ] {
        if let Some(file) = found[index].take() {
            return Ok(SessionRecording {
                file,
                format: AudioFormat::from_file_name(file_name).expect("known format"),
                file_name,
            });
        }
    }
    Err(unavailable("The recording is no longer on this Mac"))
}
/// First open a stopped recording, then fail closed if the root actor reports
/// this id as active/finalizing or cannot answer. Caller starts Whisper only
/// after this returns successfully.
pub async fn admit_transcription<F, Fut>(
    sessions_dir: &Path,
    id: &str,
    snapshot: F,
) -> Result<(SessionRecording, String), Rejection>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<bool, ()>>,
{
    let recording = open_session_recording(sessions_dir, id)?;
    let path = sessions_dir.join(id).join(recording.file_name);
    let path = path
        .to_str()
        .ok_or_else(|| unavailable("The recording path is not UTF-8"))?
        .to_owned();
    if snapshot().await != Ok(false) {
        return Err(Rejection {
            code: "recording_busy",
            message: "This recording is still being saved".into(),
        });
    }
    Ok((recording, path))
}

/// A new empty directory reserved for exactly one recorder start. Failure
/// removes it only if still empty; a successful start leaves it to the plugin.
pub struct PreparedCapture {
    sessions: OwnedFd,
    id: String,
    started: bool,
}

impl PreparedCapture {
    pub fn started(&mut self) {
        self.started = true;
    }
}

impl Drop for PreparedCapture {
    fn drop(&mut self) {
        if !self.started {
            let _ = rustix::fs::unlinkat(&self.sessions, self.id.as_str(), AtFlags::REMOVEDIR);
        }
    }
}

fn unsafe_tree(message: impl Into<String>) -> Rejection {
    Rejection {
        code: "unsafe_sessions_folder",
        message: message.into(),
    }
}

fn canonical_capture_id(id: &str) -> bool {
    let bare = id.strip_prefix("cloud-").unwrap_or(id);
    Uuid::parse_str(bare).is_ok_and(|uuid| uuid.hyphenated().to_string() == bare)
}
/// Recorder segments use their own namespace, with the same upstream preflight.
pub fn prepare_recorder_dir(sessions_dir: &Path, id: &str) -> Result<PreparedCapture, Rejection> {
    if !id.strip_prefix("rec-").is_some_and(canonical_capture_id) {
        return Err(Rejection {
            code: "invalid_session",
            message: "Capture needs a fresh canonical recorder UUID".into(),
        });
    }
    prepare_dir(sessions_dir, id)
}

/// Walk precisely the directories the pinned recorder searches. Entries that
/// disappear between readdir and stat/open are gone; all other errors fail closed.
fn scan_recorder_tree(dir_fd: &OwnedFd, id: &str) -> Result<(), Rejection> {
    scan_recorder_tree_with(dir_fd, id, &mut |_, _, _| {})
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanPoint {
    BeforeStat,
    BeforeOpen,
}

fn scan_recorder_tree_with<F>(dir_fd: &OwnedFd, id: &str, on_entry: &mut F) -> Result<(), Rejection>
where
    F: FnMut(&OwnedFd, &CStr, ScanPoint),
{
    let mut entries =
        Dir::read_from(dir_fd).map_err(|e| unsafe_tree(format!("Reading sessions folder: {e}")))?;
    while let Some(entry) = entries.read() {
        let entry = entry.map_err(|e| unsafe_tree(format!("Reading sessions entry: {e}")))?;
        let name: &CStr = entry.file_name();
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        on_entry(dir_fd, name, ScanPoint::BeforeStat);
        let stat = match rustix::fs::statat(dir_fd, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(rustix::io::Errno::NOENT) => continue,
            Err(e) => return Err(unsafe_tree(format!("Inspecting sessions entry: {e}"))),
        };
        let kind = FileType::from_raw_mode(stat.st_mode);
        if kind.is_symlink() {
            return Err(unsafe_tree("The sessions tree contains a symlink"));
        }
        if kind.is_dir() {
            if name.to_bytes() == id.as_bytes() {
                return Err(Rejection {
                    code: "session_exists",
                    message: "The recording session already exists".into(),
                });
            }
            let child_name = std::ffi::OsStr::from_bytes(name.to_bytes());
            if Uuid::try_parse(child_name.to_str().unwrap_or("")).is_err() {
                on_entry(dir_fd, name, ScanPoint::BeforeOpen);
                let child = match rustix::fs::openat(
                    dir_fd,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                ) {
                    Ok(child) => child,
                    Err(rustix::io::Errno::NOENT) => continue,
                    Err(e) => return Err(unsafe_tree(format!("Opening sessions entry: {e}"))),
                };
                scan_recorder_tree_with(&child, id, on_entry)?;
            }
        }
    }
    Ok(())
}

pub fn prepare_capture_dir(sessions_dir: &Path, id: &str) -> Result<PreparedCapture, Rejection> {
    if !canonical_capture_id(id) {
        return Err(Rejection {
            code: "invalid_session",
            message: "Capture needs a fresh canonical UUID".into(),
        });
    }
    prepare_dir(sessions_dir, id)
}

fn prepare_dir(sessions_dir: &Path, id: &str) -> Result<PreparedCapture, Rejection> {
    match std::fs::create_dir(sessions_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(unsafe_tree(format!("Creating sessions folder: {e}"))),
    }
    let sessions = rustix::fs::open(
        sessions_dir,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| unsafe_tree(format!("Opening sessions folder: {e}")))?;
    scan_recorder_tree(&sessions, id)?;
    rustix::fs::mkdirat(&sessions, id, Mode::RWXU).map_err(|e| {
        if e == rustix::io::Errno::EXIST {
            Rejection {
                code: "session_exists",
                message: "The recording session already exists".into(),
            }
        } else {
            unsafe_tree(format!("Creating recording session: {e}"))
        }
    })?;
    let guard = PreparedCapture {
        sessions,
        id: id.to_owned(),
        started: false,
    };
    if anlg_transcription_core::listener::actors::find_session_dir(sessions_dir, id)
        != sessions_dir.join(id)
    {
        return Err(unsafe_tree(
            "The recorder would choose a different session folder",
        ));
    }
    Ok(guard)
}

#[cfg(test)]
#[path = "session_audio_tests.rs"]
mod tests;
