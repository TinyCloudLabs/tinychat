//! Native capture registry: turns a stopped capture into an open descriptor
//! behind an opaque handle.
//!
//! The recording is opened by walking `vault/sessions` → `<session_id>` →
//! `audio.{mp3,wav,ogg}` with `openat` and `O_NOFOLLOW` at every step, and
//! must be a regular file of at most [`MAX_CAPTURE_BYTES`]. Hashing and upload
//! read the kept descriptor (see `reader`), never the path again.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rustix::fs::{Mode, OFlags};

/// 2 h at 128 kbps stereo MP3 + 5% (plan D2).
pub const MAX_CAPTURE_BYTES: u64 = 120_960_000;

/// Handles kept at once; the oldest is released first. An upload in flight
/// keeps its own reference, so eviction never closes a descriptor under it.
const MAX_LIVE_HANDLES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Mp3,
    Wav,
    Ogg,
}

impl AudioFormat {
    fn from_file_name(name: &str) -> Option<Self> {
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

/// What identifies the file's contents at a point in time (from `fstat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    pub size: u64,
    pub mtime: i64,
    pub mtime_nsec: i64,
    pub ino: u64,
    pub dev: u64,
}

impl FileStamp {
    pub fn of(file: &File) -> std::io::Result<Self> {
        let meta = file.metadata()?; // fstat on the descriptor
        Ok(Self {
            size: meta.size(),
            mtime: meta.mtime(),
            mtime_nsec: meta.mtime_nsec(),
            ino: meta.ino(),
            dev: meta.dev(),
        })
    }
}

/// A recording opened by [`open_capture`].
#[derive(Debug)]
pub struct OpenedCapture {
    pub file: File,
    pub format: AudioFormat,
    pub stamp: FileStamp,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Rejection {
    pub code: &'static str,
    pub message: String,
}

fn reject(code: &'static str, message: impl Into<String>) -> Rejection {
    Rejection {
        code,
        message: message.into(),
    }
}

/// Session ids come from the webview (`crypto.randomUUID()`); anything that
/// could be more than one path component is refused.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Opens `<sessions_dir>/<session_id>/<audio file>` without following a
/// symlink at any of those three components. `audio_path` is the plugin's
/// report and must name exactly that location.
pub fn open_capture(
    sessions_dir: &Path,
    session_id: &str,
    audio_path: &str,
) -> Result<OpenedCapture, Rejection> {
    if !valid_session_id(session_id) {
        return Err(reject(
            "capture_not_available",
            "The recording's session id is not valid",
        ));
    }
    let audio_path = Path::new(audio_path);
    let file_name = audio_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let format = AudioFormat::from_file_name(file_name).ok_or_else(|| {
        reject(
            "capture_not_available",
            "The recording is not an Exo audio file",
        )
    })?;
    if audio_path.parent() != Some(sessions_dir.join(session_id).as_path()) {
        return Err(reject(
            "capture_not_available",
            "The recording is not in Exo's sessions folder",
        ));
    }

    let dir_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let open_err = |what: &str, e: rustix::io::Errno| {
        reject("capture_not_available", format!("Opening {what}: {e}"))
    };
    let sessions = rustix::fs::open(sessions_dir, dir_flags, Mode::empty())
        .map_err(|e| open_err("sessions folder", e))?;
    let session = rustix::fs::openat(&sessions, session_id, dir_flags, Mode::empty())
        .map_err(|e| open_err("session folder", e))?;
    // NONBLOCK: opening a FIFO planted in the session folder must not hang.
    let fd = rustix::fs::openat(
        &session,
        file_name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|e| open_err("recording", e))?;
    let file = File::from(fd);

    let meta = file.metadata().map_err(|e| {
        reject(
            "capture_not_available",
            format!("Reading the recording: {e}"),
        )
    })?;
    if !meta.file_type().is_file() {
        return Err(reject(
            "capture_not_available",
            "The recording is not a regular file",
        ));
    }
    let stamp = FileStamp::of(&file).map_err(|e| {
        reject(
            "capture_not_available",
            format!("Reading the recording: {e}"),
        )
    })?;
    if stamp.size == 0 {
        return Err(reject("capture_not_available", "The recording is empty"));
    }
    if stamp.size > MAX_CAPTURE_BYTES {
        return Err(reject(
            "recording_too_long_for_cloud",
            "Private cloud transcription takes recordings up to 2 hours",
        ));
    }
    Ok(OpenedCapture {
        file,
        format,
        stamp,
    })
}

/// A stopped capture reported by the transcription plugin.
#[derive(Debug, PartialEq, Eq)]
pub struct StoppedCapture {
    pub session_id: String,
    pub audio_path: String,
    /// Capture ended with an error but left audio.
    pub partial: bool,
}

/// Session ids the webview gives captures it will upload (`cloud-<uuid>`).
/// Only those are opened; an on-device capture never gets a descriptor or an
/// `exo://capture-ready` event.
pub const CLOUD_SESSION_PREFIX: &str = "cloud-";

/// Reads the plugin's own event type, so a change to its shape fails to compile
/// here rather than silently never matching. `None` for anything but a
/// cloud-bound capture that stopped with audio.
pub fn parse_stopped(payload: &str) -> Option<StoppedCapture> {
    use tauri_plugin_transcription::CaptureLifecycleEvent;
    match serde_json::from_str::<CaptureLifecycleEvent>(payload).ok()? {
        CaptureLifecycleEvent::Stopped {
            session_id,
            audio_path: Some(audio_path),
            error,
            ..
        } if session_id.starts_with(CLOUD_SESSION_PREFIX) => Some(StoppedCapture {
            session_id,
            audio_path,
            partial: error.is_some(),
        }),
        _ => None,
    }
}

/// An open recording the webview refers to by handle.
#[derive(Debug)]
pub struct Capture {
    pub file: File,
    pub format: AudioFormat,
    /// `fstat` when the capture was registered.
    pub stamp: FileStamp,
    /// Aborts the upload in flight for this capture, if any.
    upload: Mutex<Option<futures_util::future::AbortHandle>>,
}

impl Capture {
    pub fn new(opened: OpenedCapture) -> Self {
        Self {
            file: opened.file,
            format: opened.format,
            stamp: opened.stamp,
            upload: Mutex::new(None),
        }
    }

    /// Claims the capture for one upload; `false` if one is already running.
    pub fn begin_upload(&self, abort: futures_util::future::AbortHandle) -> bool {
        let mut slot = self.upload.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return false;
        }
        *slot = Some(abort);
        true
    }

    pub fn end_upload(&self) {
        self.upload.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    pub fn abort_upload(&self) {
        if let Some(abort) = self.upload.lock().unwrap_or_else(|e| e.into_inner()).take() {
            abort.abort();
        }
    }
}

#[derive(Default)]
struct Handles {
    order: VecDeque<String>,
    captures: HashMap<String, Arc<Capture>>,
}

#[derive(Default)]
pub struct CaptureRegistry {
    inner: Mutex<Handles>,
}

/// 128 random bits, hex.
fn new_handle() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS randomness is unavailable");
    hex::encode(bytes)
}

impl CaptureRegistry {
    pub fn insert(&self, capture: Capture) -> String {
        let handle = new_handle();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.captures.insert(handle.clone(), Arc::new(capture));
        inner.order.push_back(handle.clone());
        while inner.order.len() > MAX_LIVE_HANDLES {
            if let Some(oldest) = inner.order.pop_front() {
                inner.captures.remove(&oldest);
            }
        }
        handle
    }

    pub fn get(&self, handle: &str) -> Option<Arc<Capture>> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .captures
            .get(handle)
            .cloned()
    }

    /// Forgets the handle; the descriptor closes once no upload holds it.
    pub fn remove(&self, handle: &str) -> Option<Arc<Capture>> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.order.retain(|h| h != handle);
        inner.captures.remove(handle)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::symlink;

    pub const SESSION: &str = "0b7c6d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";

    pub fn sessions_with(contents: &[u8]) -> (tempdir::TempDir, std::path::PathBuf) {
        let dir = tempdir::TempDir::new();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(sessions.join(SESSION)).unwrap();
        let mut f = File::create(sessions.join(SESSION).join("audio.mp3")).unwrap();
        f.write_all(contents).unwrap();
        (dir, sessions)
    }

    /// Minimal self-deleting temp dir (no extra dev-dependency).
    pub mod tempdir {
        pub struct TempDir(std::path::PathBuf);
        impl TempDir {
            pub fn new() -> Self {
                let mut bytes = [0u8; 8];
                getrandom::fill(&mut bytes).unwrap();
                let path =
                    std::env::temp_dir().join(format!("exo-cloud-test-{}", hex::encode(bytes)));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn audio_path(sessions: &Path, name: &str) -> String {
        sessions
            .join(SESSION)
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn opens_a_regular_recording_in_its_session_folder() {
        let (_d, sessions) = sessions_with(b"ID3 audio");
        let opened = open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).unwrap();
        assert_eq!(opened.format, AudioFormat::Mp3);
        assert_eq!(opened.stamp.size, 9);
    }

    #[test]
    fn refuses_paths_outside_the_session_folder() {
        let (d, sessions) = sessions_with(b"x");
        let other = d.path().join("elsewhere");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("audio.mp3"), b"x").unwrap();
        for (session, path) in [
            (
                SESSION,
                other.join("audio.mp3").to_string_lossy().into_owned(),
            ),
            (SESSION, audio_path(&sessions, "notes.txt")),
            (
                SESSION,
                format!(
                    "{}/../{SESSION}/audio.mp3",
                    sessions.join(SESSION).display()
                ),
            ),
            (
                "../elsewhere",
                d.path()
                    .join("elsewhere/audio.mp3")
                    .to_string_lossy()
                    .into_owned(),
            ),
            ("a/b", audio_path(&sessions, "audio.mp3")),
            ("", audio_path(&sessions, "audio.mp3")),
        ] {
            let err = open_capture(&sessions, session, &path).unwrap_err();
            assert_eq!(err.code, "capture_not_available", "{session} {path}");
        }
    }

    #[test]
    fn refuses_a_symlinked_session_folder_or_file() {
        let (d, sessions) = sessions_with(b"x");
        let secret = d.path().join("secret.mp3");
        std::fs::write(&secret, b"not a recording").unwrap();

        // Symlinked file.
        let file = sessions.join(SESSION).join("audio.mp3");
        std::fs::remove_file(&file).unwrap();
        symlink(&secret, &file).unwrap();
        let err =
            open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).unwrap_err();
        assert_eq!(err.code, "capture_not_available");

        // Symlinked session folder.
        let real = d.path().join("real-session");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("audio.mp3"), b"x").unwrap();
        std::fs::remove_dir_all(sessions.join(SESSION)).unwrap();
        symlink(&real, sessions.join(SESSION)).unwrap();
        let err =
            open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).unwrap_err();
        assert_eq!(err.code, "capture_not_available");

        // Symlinked sessions folder.
        let (d2, sessions2) = sessions_with(b"x");
        let moved = d2.path().join("moved");
        std::fs::rename(&sessions2, &moved).unwrap();
        symlink(&moved, &sessions2).unwrap();
        let err =
            open_capture(&sessions2, SESSION, &audio_path(&sessions2, "audio.mp3")).unwrap_err();
        assert_eq!(err.code, "capture_not_available");
    }

    #[test]
    fn refuses_non_regular_files_without_blocking() {
        let (_d, sessions) = sessions_with(b"x");
        let file = sessions.join(SESSION).join("audio.mp3");
        std::fs::remove_file(&file).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&file)
            .status()
            .unwrap()
            .success());
        let err =
            open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).unwrap_err();
        assert_eq!(err.code, "capture_not_available");

        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let err =
            open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).unwrap_err();
        assert_eq!(err.code, "capture_not_available");
    }

    #[test]
    fn enforces_the_size_cap() {
        let (_d, sessions) = sessions_with(b"");
        let err =
            open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).unwrap_err();
        assert_eq!(err.code, "capture_not_available");

        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(sessions.join(SESSION).join("audio.mp3"))
            .unwrap();
        file.set_len(MAX_CAPTURE_BYTES).unwrap();
        assert!(open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).is_ok());
        file.set_len(MAX_CAPTURE_BYTES + 1).unwrap();
        let err =
            open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).unwrap_err();
        assert_eq!(err.code, "recording_too_long_for_cloud");
    }

    #[test]
    fn parses_only_cloud_bound_stopped_events_with_audio() {
        let cloud = format!("{CLOUD_SESSION_PREFIX}{SESSION}");
        let stopped = parse_stopped(&format!(
            r#"{{"type":"stopped","session_id":"{cloud}","audio_path":"/v/sessions/{cloud}/audio.mp3","requested_live_transcription":false,"live_transcription_active":false,"error":null}}"#
        ))
        .unwrap();
        assert_eq!(stopped.session_id, cloud);
        assert!(!stopped.partial);
        let partial = parse_stopped(&format!(
            r#"{{"type":"stopped","session_id":"{cloud}","audio_path":"/a/audio.wav","requested_live_transcription":false,"live_transcription_active":false,"error":"mic failed"}}"#
        ))
        .unwrap();
        assert!(partial.partial);
        // An on-device capture is never opened.
        assert!(parse_stopped(&format!(
            r#"{{"type":"stopped","session_id":"{SESSION}","audio_path":"/v/sessions/{SESSION}/audio.mp3","requested_live_transcription":false,"live_transcription_active":false,"error":null}}"#
        ))
        .is_none());
        assert!(parse_stopped(&format!(
            r#"{{"type":"stopped","session_id":"{cloud}","audio_path":null,"requested_live_transcription":false,"live_transcription_active":false,"error":"x"}}"#
        ))
        .is_none());
        assert!(parse_stopped(&format!(
            r#"{{"type":"finalizing","session_id":"{cloud}"}}"#
        ))
        .is_none());
        assert!(parse_stopped("not json").is_none());
    }

    #[test]
    fn handles_are_random_and_bounded() {
        let (_d, sessions) = sessions_with(b"x");
        let registry = CaptureRegistry::default();
        let mut handles = Vec::new();
        for _ in 0..(MAX_LIVE_HANDLES + 2) {
            let opened =
                open_capture(&sessions, SESSION, &audio_path(&sessions, "audio.mp3")).unwrap();
            handles.push(registry.insert(Capture::new(opened)));
        }
        assert!(handles
            .iter()
            .all(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_hexdigit())));
        assert_ne!(handles[0], handles[1]);
        assert!(registry.get(&handles[0]).is_none(), "oldest evicted");
        assert!(registry.get(&handles[1]).is_none(), "second oldest evicted");
        assert!(registry.get(handles.last().unwrap()).is_some());
        assert!(registry.remove(handles.last().unwrap()).is_some());
        assert!(registry.get(handles.last().unwrap()).is_none());
    }
}
