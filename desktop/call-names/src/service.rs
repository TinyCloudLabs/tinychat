//! The reader's service: when the meeting window is read, and what is kept on disk.
//!
//! The desktop app runs one [`Service`] on a thread of its own ([`spawn`]). The service does not
//! hook the recorder. Every tick it asks the app whether a capture is live ([`Host::live`]) and
//! reads the meeting window only while all of this holds:
//! - a capture is live (not paused, not stopping, not stopped);
//! - the recording has two channels, because only then is there a "Them" to name;
//! - the setting is on (it is off until the user turns it on);
//! - macOS lets this app use Accessibility.
//!
//! Otherwise no app is asked anything, and what the last reading changed in a browser is put back
//! ([`Window::stop`]). A reading that ends after the capture paused or stopped is thrown away.
//!
//! The names of one recording are kept in `<folder>/<recording id>.json` as the
//! `call_participants` object, written again whenever it changes. The frontend reads that file
//! when it saves the note ([`Store::read`]) and then clears it ([`Store::clear`]). A recording id
//! is checked before it becomes a file name ([`valid_id`]). A names file that cannot be read as
//! that object is removed when it is asked for. The setting is a file in the same folder
//! ([`Store::enabled`]).
//!
//! Who the user is. A meeting app marks the user's own entry in few places (Meet's People panel,
//! Zoom's participant list); the tiles of a call do not. So the service remembers the names the
//! apps did mark, newest first ([`Store::self_names`]), and also knows the full name of the
//! computer account. In a recording where no app marked anybody, the one person with a known name
//! is given as the user. With two such people nobody is. A mark from the app itself always wins,
//! also when it comes later in the same recording; from then on the recording takes no guess.
//! When the roster withdraws a mark (a second person carried it in the same recording), the
//! remembered names go back to what they were before that recording.
//!
//! What the reader last did is in `<folder>/_status.json`, for a build that has no log: the kind
//! of outcome and a few counts, never a name. It is written when the kind changes, and every
//! [`STATUS_INTERVAL`] while the window is being read.
//!
//! Who spoke when. In a Meet call with three or more tiles, the service also follows each tile's
//! speaking marker between ticks (see `speaking`) and keeps the speaking timeline of the
//! recording in `<folder>/speaking/<recording id>.json` (see `timeline`): person ids and times
//! only. A names tick goes first, every [`READING_INTERVAL`]; in between, [`Service::sample`]
//! takes a speaking sample every [`SAMPLE_INTERVAL`] (every [`SLOW_SAMPLE_INTERVAL`] for
//! [`SLOW_FOR`] after [`TIMEOUTS_BEFORE_SLOW`] samples in a row timed out). A sample is taken only
//! while the last names tick read the window and followed three tiles or more, the capture is
//! live with two channels and the setting is on; the capture is asked before and after the
//! sample's reads, and a sample is dropped when it paused or changed in between. When the capture
//! pauses or stops, the samples since the last names tick count for the tiles that tick confirmed
//! (see `timeline`), without another reading. The timeline is
//! written every [`Sampling::write_every`] of recording while it changes, when the capture pauses
//! or stops, and when the service ends. The status file adds counts (samples, unknown samples,
//! tiles followed, mode) and nothing else. The frontend reads it when it transcribes ([`Store::read_speaking`]). Saving the note
//! does not remove it ([`Store::clear`] leaves it), because a new transcription needs it again;
//! it goes with the recording's audio ([`Store::forget`]) or after [`MAX_NAMES_AGE`].
//!
//! The folder and its files are the user's alone (modes 0700 and 0600 on unix). When the service
//! starts it removes what an interrupted write left behind, and each names file and timeline
//! older than [`MAX_NAMES_AGE`]: nobody saved its note in all that time.
//!
//! Everything here is plain Rust and runs on any platform; the tests drive it with a fake host
//! and a fake window. No failure reaches the recorder: a tick that fails reads or saves nothing
//! and says so in its [`Report`], which holds counts, codes and rule ids, never a name.

use crate::ax::{
    self, NoNames, Permission, RunningApp, TickReport, CHROMIUM_BROWSERS, ZOOM_BUNDLE_ID,
};
use crate::extract::Extraction;
use crate::names::Name;
use crate::roster::{CallParticipants, Roster};
use crate::rules::Rules;
use crate::session::{Budget, Skip};
use crate::speaking::{
    tiles_to_read, Found, Mark, SampleRead, Tokens, SAMPLE_INTERVAL, SLOW_FOR,
    SLOW_SAMPLE_INTERVAL, TIMEOUTS_BEFORE_SLOW,
};
use crate::timeline::{Counts, Timeline, Tracker, MAX_TIMELINE_BYTES};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Channels of a recording of both sides of a call ("Me" and "Them").
pub const STEREO: u8 = 2;
/// Time between two readings of the meeting window.
pub const READING_INTERVAL: Duration = Duration::from_secs(5);
/// Time between two checks while nothing is read.
pub const IDLE_INTERVAL: Duration = Duration::from_secs(2);
/// The name of the reader's thread.
pub const THREAD_NAME: &str = "call-names";
/// Most names the user is remembered by.
pub const MAX_SELF_NAMES: usize = 8;
/// The least time between two status files while the kind of outcome stays the same.
pub const STATUS_INTERVAL: Duration = Duration::from_secs(30);
/// A names file older than this is removed when the service starts.
pub const MAX_NAMES_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The setting's file. No recording id gives this name: an id has no underscore.
const SETTING_FILE: &str = "_setting.json";
/// The file of the names the user is remembered by. No recording id gives this name either.
const SELF_NAMES_FILE: &str = "_self-names.json";
/// The file that says what the reader last did. No recording id gives this name either.
const STATUS_FILE: &str = "_status.json";
/// The largest file the store reads; 50 names of 80 characters are far smaller.
const MAX_FILE_BYTES: u64 = 64 * 1024;
/// The folder of the speaking timelines, inside the store's folder. No recording id gives this
/// name to a names file: those end in `.json`.
const SPEAKING_DIR: &str = "speaking";

/// True when `id` has the form of a recording id: 1 to 64 ASCII letters, digits and hyphens. It
/// is the app's own rule for note ids (`valid_id` in `desktop/local-transcription`), so an id can
/// never name a file outside the folder.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Why the store refused. The text of each is a code; none holds a path or a name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The id is not a recording id.
    InvalidId,
    /// The file system refused.
    Io(io::ErrorKind),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::InvalidId => f.write_str("invalid_recording_id"),
            StoreError::Io(kind) => write!(f, "call_names_io: {kind}"),
        }
    }
}

impl std::error::Error for StoreError {}

fn io_error(error: io::Error) -> StoreError {
    StoreError::Io(error.kind())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Setting {
    enabled: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SelfNamesFile {
    names: Vec<Name>,
}

/// What the reader last did: the kind of outcome and counts. No field can hold a name.
#[derive(Serialize)]
struct Status<'a> {
    v: u32,
    /// When this was written, in UTC.
    at: String,
    outcome: &'a str,
    apps: usize,
    people: usize,
    self_known: bool,
    self_guessed: bool,
    tick_ms: u64,
    /// Speaking samples of the recording: counts and the mode only. Absent without them.
    #[serde(skip_serializing_if = "Option::is_none")]
    speaking: Option<Counts>,
}

/// The folder with the names file of each recording, the setting, the names the user is
/// remembered by, and the status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// A store in `dir`. The folder is made when something is first written.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Store { dir: dir.into() }
    }

    /// The store of the app whose data folder is `app_data`:
    /// `<app_data>/voice-notes/call-names`, beside the recorder's own files.
    pub fn in_app_data(app_data: &Path) -> Self {
        Store::new(app_data.join("voice-notes").join("call-names"))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Whether the user turned reading on. Off until then, and off when the setting cannot be
    /// read.
    pub fn enabled(&self) -> bool {
        read_small(&self.dir.join(SETTING_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Setting>(&bytes).ok())
            .is_some_and(|setting| setting.enabled)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(&Setting { enabled })
            .map_err(|_| StoreError::Io(io::ErrorKind::InvalidData))?;
        write_atomic(&self.dir.join(SETTING_FILE), &bytes).map_err(io_error)
    }

    /// The names a meeting app marked as the user in earlier calls, newest first, at most
    /// [`MAX_SELF_NAMES`]. Empty when there are none, or when the file cannot be read.
    pub fn self_names(&self) -> Vec<Name> {
        let mut names = read_small(&self.dir.join(SELF_NAMES_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SelfNamesFile>(&bytes).ok())
            .map(|file| file.names)
            .unwrap_or_default();
        names.truncate(MAX_SELF_NAMES);
        names
    }

    /// Keep these names, newest first, in place of the ones kept before. Names after the first
    /// [`MAX_SELF_NAMES`] are left out.
    pub fn set_self_names(&self, names: &[Name]) -> Result<(), StoreError> {
        let names = names[..names.len().min(MAX_SELF_NAMES)].to_vec();
        let bytes = serde_json::to_vec(&SelfNamesFile { names })
            .map_err(|_| StoreError::Io(io::ErrorKind::InvalidData))?;
        write_atomic(&self.dir.join(SELF_NAMES_FILE), &bytes).map_err(io_error)
    }

    /// Say what the reader last did, in place of what was said before: the kind of outcome, the
    /// running apps it was given, the people kept so far, whether one of them is given as the
    /// user and whether that is a guess, and the time the reading took.
    pub fn set_status(&self, report: &Report, now: SystemTime) -> Result<(), StoreError> {
        self.set_status_with(report, None, now)
    }

    /// As [`Store::set_status`], with the speaking counts of the recording when there are any.
    pub fn set_status_with(
        &self,
        report: &Report,
        speaking: Option<Counts>,
        now: SystemTime,
    ) -> Result<(), StoreError> {
        let status = Status {
            v: 1,
            at: utc(now),
            outcome: &report.outcome,
            apps: report.apps,
            people: report.people,
            self_known: report.self_known,
            self_guessed: report.guessed,
            tick_ms: report.elapsed_ms,
            speaking,
        };
        let bytes =
            serde_json::to_vec(&status).map_err(|_| StoreError::Io(io::ErrorKind::InvalidData))?;
        write_atomic(&self.dir.join(STATUS_FILE), &bytes).map_err(io_error)
    }

    /// What the service does to the folder when it starts. The folder becomes the user's alone.
    /// What an interrupted write left behind is removed, and so is each names file last written
    /// more than [`MAX_NAMES_AGE`] before `now`. The setting, the remembered names and the
    /// status stay. Returns the number of files removed.
    pub fn tidy(&self, now: SystemTime) -> usize {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return 0;
        };
        restrict_dir(&self.dir);
        let mut removed = tidy_files(&self.dir.join(SPEAKING_DIR), now);
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let old = || {
                entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|written| now.duration_since(written).ok())
                    .is_some_and(|age| age > MAX_NAMES_AGE)
            };
            let leftover = name.ends_with(".tmp");
            let old_names = name.strip_suffix(".json").is_some_and(valid_id) && old();
            if (leftover || old_names) && fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    fn names_path(&self, id: &str) -> Result<PathBuf, StoreError> {
        if !valid_id(id) {
            return Err(StoreError::InvalidId);
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    /// The people read during the recording `id`, or `None` when there are none. A names file
    /// that is not a `call_participants` object this build reads can never be saved with the
    /// note: it is removed, and the answer is `None`.
    pub fn read(&self, id: &str) -> Result<Option<CallParticipants>, StoreError> {
        let people = match read_small(&self.names_path(id)?) {
            Ok(bytes) => String::from_utf8(bytes)
                .ok()
                .and_then(|json| CallParticipants::from_json(&json).ok()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => None,
            Err(error) => return Err(io_error(error)),
        };
        if people.is_none() {
            self.clear(id)?;
        }
        Ok(people)
    }

    /// Keep the people of the recording `id`, in place of what was kept before.
    pub fn write(&self, id: &str, participants: &CallParticipants) -> Result<(), StoreError> {
        write_atomic(&self.names_path(id)?, participants.to_json().as_bytes()).map_err(io_error)
    }

    /// Forget the people of the recording `id`. Not an error when there are none.
    pub fn clear(&self, id: &str) -> Result<(), StoreError> {
        let path = self.names_path(id)?;
        // What an interrupted write left behind holds names too.
        let temporary = format!("{id}.json.");
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name
                    .to_str()
                    .is_some_and(|name| name.starts_with(&temporary) && name.ends_with(".tmp"))
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        match fs::remove_file(&path) {
            Ok(()) => sync_dir(&self.dir).map_err(io_error),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(error)),
        }
    }

    fn speaking_path(&self, id: &str) -> Result<PathBuf, StoreError> {
        if !valid_id(id) {
            return Err(StoreError::InvalidId);
        }
        Ok(self.dir.join(SPEAKING_DIR).join(format!("{id}.json")))
    }

    /// The speaking timeline of the recording `id`, or `None` when there is none. A file that is
    /// not a timeline this build reads is removed, and the answer is `None`.
    pub fn read_speaking(&self, id: &str) -> Result<Option<Timeline>, StoreError> {
        let path = self.speaking_path(id)?;
        let timeline = match read_limited(&path, MAX_TIMELINE_BYTES) {
            Ok(bytes) => String::from_utf8(bytes)
                .ok()
                .and_then(|json| Timeline::from_json(&json).ok()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => None,
            Err(error) => return Err(io_error(error)),
        };
        if timeline.is_none() {
            remove_with_temporaries(&path).map_err(io_error)?;
        }
        Ok(timeline)
    }

    /// Keep the speaking timeline of the recording `id`, in place of what was kept before.
    pub fn write_speaking(&self, id: &str, timeline: &Timeline) -> Result<(), StoreError> {
        write_atomic(&self.speaking_path(id)?, timeline.to_json().as_bytes()).map_err(io_error)
    }

    /// Forget everything kept about the recording `id`: its names and its speaking timeline. For
    /// when its audio is deleted. Not an error when there is nothing.
    pub fn forget(&self, id: &str) -> Result<(), StoreError> {
        let names = self.clear(id);
        let speaking = remove_with_temporaries(&self.speaking_path(id)?).map_err(io_error);
        names.and(speaking)
    }
}

/// Remove a file of the store and what an interrupted write of it left behind. Not an error when
/// there is none.
fn remove_with_temporaries(path: &Path) -> io::Result<()> {
    let (Some(dir), Some(name)) = (
        path.parent(),
        path.file_name().and_then(|name| name.to_str()),
    ) else {
        return Err(io::ErrorKind::InvalidInput.into());
    };
    let temporary = format!("{name}.");
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let file = entry.file_name();
            if file
                .to_str()
                .is_some_and(|file| file.starts_with(&temporary) && file.ends_with(".tmp"))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    match fs::remove_file(path) {
        Ok(()) => sync_dir(dir),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// In a folder of timelines: remove what an interrupted write left behind, and each timeline
/// last written more than [`MAX_NAMES_AGE`] before `now`. Returns the number removed.
fn tidy_files(dir: &Path, now: SystemTime) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    restrict_dir(dir);
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let old = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|written| now.duration_since(written).ok())
            .is_some_and(|age| age > MAX_NAMES_AGE);
        let leftover = name.ends_with(".tmp");
        let old_timeline = name.strip_suffix(".json").is_some_and(valid_id) && old;
        if (leftover || old_timeline) && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// A whole file of the store. One larger than anything the store writes is refused unread.
fn read_small(path: &Path) -> io::Result<Vec<u8>> {
    read_limited(path, MAX_FILE_BYTES)
}

/// A whole file, refused unread when it is larger than `max` bytes.
fn read_limited(path: &Path, max: u64) -> io::Result<Vec<u8>> {
    if fs::metadata(path)?.len() > max {
        return Err(io::ErrorKind::InvalidData.into());
    }
    fs::read(path)
}

static TEMPORARY: AtomicU64 = AtomicU64::new(0);

/// Make the folder, for the user alone (mode 0700 on unix).
fn make_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

/// Take a folder that exists away from other users (unix). A failure changes nothing else.
fn restrict_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// A new file for the user alone (mode 0600 on unix). Nothing may be at `path`.
fn create_private(path: &Path) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

/// Write a whole file so that a reader sees the old content or the new one, never a part: a
/// temporary file, synced, then renamed over the target (as the recorder's journal does).
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    make_dir(dir)?;
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        TEMPORARY.fetch_add(1, Ordering::Relaxed)
    ));
    let temporary = PathBuf::from(temporary);
    // A file of this name can only be what an earlier process left behind.
    let _ = fs::remove_file(&temporary);
    let written = (|| {
        let mut file = create_private(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        sync_dir(dir)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

/// `time` in UTC, to the second, as RFC 3339 writes it: `2026-11-19T17:25:03Z`.
fn utc(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let (days, second) = ((seconds / 86_400) as i64, seconds % 86_400);
    // Days since 1970-01-01 to a date of the Gregorian calendar, in 400-year eras that start on
    // 1 March of year 0 (so a leap day is the last day of a year).
    let shifted = days + 719_468;
    let (era, day_of_era) = (shifted.div_euclid(146_097), shifted.rem_euclid(146_097));
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        second / 3_600,
        second % 3_600 / 60,
        second % 60
    )
}

/// The setting and the permission, as the settings screen shows them:
/// `{"enabled":false,"permission":"granted"|"missing"|"unsupported"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct State {
    pub enabled: bool,
    pub permission: Permission,
}

/// The setting, and whether macOS lets this app use Accessibility. Never prompts.
pub fn state(store: &Store) -> State {
    State {
        enabled: store.enabled(),
        permission: ax::permission(),
    }
}

/// The "gecos" field of the account this process runs as, from the system's user database. On
/// macOS that is the account's full name.
#[cfg(unix)]
#[allow(unsafe_code)]
fn account_gecos() -> Option<String> {
    let mut size = 1024;
    loop {
        let mut buffer = vec![0 as libc::c_char; size];
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::zeroed();
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: each pointer is to a live local of the type and size given. `getpwuid_r` writes
        // the entry into `entry` and its strings into `buffer`, and nowhere else.
        let code = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut found,
            )
        };
        if code == libc::ERANGE && size < 64 * 1024 {
            size *= 4;
            continue;
        }
        if code != 0 || found.is_null() {
            return None;
        }
        // SAFETY: `found` is not null, so it points at `entry`, which `getpwuid_r` filled. Its
        // `pw_gecos`, when not null, is a NUL-terminated string inside `buffer`, still alive here.
        let gecos = unsafe {
            let gecos = (*found).pw_gecos;
            if gecos.is_null() {
                return None;
            }
            std::ffi::CStr::from_ptr(gecos).to_str().ok()?.to_owned()
        };
        return Some(gecos);
    }
}

#[cfg(not(unix))]
fn account_gecos() -> Option<String> {
    None
}

/// The full name in an account's "gecos" field. macOS keeps only the name there; other systems
/// may add more after a comma.
fn full_name(gecos: &str) -> Option<Name> {
    let name = if cfg!(target_os = "macos") {
        gecos
    } else {
        gecos.split(',').next().unwrap_or_default()
    };
    Name::clean(name)
}

/// True when two names are the same but for the case of their letters.
fn same_name(a: &Name, b: &Name) -> bool {
    a.as_str().trim().to_lowercase() == b.as_str().trim().to_lowercase()
}

/// The names known to be the user's own.
struct SelfNames {
    /// Names a meeting app marked as the user, newest first. Kept in the store.
    remembered: Vec<Name>,
    /// The full name of the computer account. Never stored.
    account: Option<Name>,
    /// `remembered` changed since it was last stored.
    unsaved: bool,
}

impl SelfNames {
    fn load(store: &Store, account: fn() -> Option<String>) -> Self {
        SelfNames {
            remembered: store.self_names(),
            account: account().as_deref().and_then(full_name),
            unsaved: false,
        }
    }

    fn knows(&self, name: &Name) -> bool {
        self.account
            .iter()
            .chain(&self.remembered)
            .any(|known| same_name(known, name))
    }

    /// A meeting app marked `name` as the user: it becomes the newest remembered name. When
    /// that changes the remembered names, the answer is what they were before.
    fn remember(&mut self, name: &Name) -> Option<Vec<Name>> {
        if self
            .remembered
            .first()
            .is_some_and(|newest| same_name(newest, name))
        {
            return None;
        }
        let before = self.remembered.clone();
        self.remembered.retain(|known| !same_name(known, name));
        self.remembered.insert(0, name.clone());
        self.remembered.truncate(MAX_SELF_NAMES);
        self.unsaved = true;
        Some(before)
    }

    /// Put the remembered names back as they were.
    fn restore(&mut self, before: Vec<Name>) {
        self.unsaved |= self.remembered != before;
        self.remembered = before;
    }

    /// For a recording in which no meeting app marked anybody: the one person with a known name
    /// is the user. With two such people nobody is. True when somebody was marked.
    fn mark(&self, participants: &mut CallParticipants) -> bool {
        if participants.people.iter().any(|person| person.is_self) {
            return false;
        }
        let mut known = participants
            .people
            .iter_mut()
            .filter(|person| self.knows(&person.name));
        match (known.next(), known.next()) {
            (Some(person), None) => {
                person.is_self = true;
                true
            }
            _ => false,
        }
    }
}

/// A capture that is live right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Live {
    /// The recording's id (the note's id).
    pub id: String,
    pub channels: u8,
    /// The recording's audio clock.
    pub recorded_ms: u64,
}

/// What the service asks of the app.
pub trait Host {
    /// The capture, while the native source is capturing. `None` when idle, paused, stopping or
    /// stopped.
    fn live(&self) -> Option<Live>;

    /// The running apps with this bundle id. The process id and the bundle id of each must come
    /// from one lookup (`processIdentifier` and `bundleIdentifier` of one
    /// `NSRunningApplication`); see [`RunningApp`].
    fn running(&self, bundle_id: &str) -> Vec<RunningApp>;

    /// Runs one tick. The macOS app wraps it in an autorelease pool.
    fn scope(&self, tick: &mut dyn FnMut()) {
        tick()
    }

    /// What a tick did, for the app's log. Called when it differs from the tick before.
    fn report(&self, _report: &Report) {}

    /// What a speaking sample did, for a developer's tool (`examples/snapshot.rs`): ids, marks,
    /// counts and times. The app does not log it.
    fn sampled(&self, _sample: &SampleReport) {}
}

/// What one speaking sample did: per tile its person id and a preliminary mark (the timeline
/// keeps the sample only once the next names tick confirms its tiles), and what it cost.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SampleReport {
    /// On the recording's clock.
    pub at_ms: u64,
    pub interval_ms: u64,
    /// Tile index in the last names tick, person id, mark.
    pub tiles: Vec<(usize, Option<String>, Mark)>,
    pub calls: u64,
    pub elapsed: Duration,
    pub timed_out: bool,
    /// False when the capture paused or changed during the sample, which drops it.
    pub kept: bool,
}

/// The reader of the meeting window: [`ax::Reader`] in the app, a fake in tests.
pub trait Window {
    /// Whether this process may read other apps' windows. Never prompts.
    fn permission(&self) -> Permission;

    /// Ask the system to show its permission prompt. Returns at once; the prompt shows by
    /// itself. The default asks nothing.
    fn request_permission(&self) {}

    /// One reading over the given running apps.
    fn read(&mut self, rules: &Rules, apps: &[RunningApp], budget: Budget) -> TickReport;

    /// Put back what reading changed in the apps.
    fn stop(&mut self);

    /// What the last [`Window::read`] found for speaking: `None` when it did not look. Asked
    /// once after each reading. The default follows nothing.
    fn speaking(&mut self) -> Option<Found> {
        None
    }

    /// One speaking sample of these tiles of the last reading. The default reads nothing.
    fn sample(&mut self, slots: &[usize]) -> SampleRead {
        let _ = slots;
        SampleRead::default()
    }
}

impl Window for ax::Reader {
    fn permission(&self) -> Permission {
        ax::permission()
    }

    fn request_permission(&self) {
        ax::request_permission();
    }

    fn read(&mut self, rules: &Rules, apps: &[RunningApp], budget: Budget) -> TickReport {
        ax::Reader::read(self, rules, apps, budget)
    }

    fn stop(&mut self) {
        ax::Reader::stop(self)
    }

    fn speaking(&mut self) -> Option<Found> {
        ax::Reader::speaking(self)
    }

    fn sample(&mut self, slots: &[usize]) -> SampleRead {
        ax::Reader::sample(self, slots)
    }
}

/// How long the service waits between ticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pace {
    /// After a tick that read the window.
    pub reading: Duration,
    /// After a tick that read nothing.
    pub idle: Duration,
}

impl Default for Pace {
    fn default() -> Self {
        Pace {
            reading: READING_INTERVAL,
            idle: IDLE_INTERVAL,
        }
    }
}

/// How speaking samples are taken and kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sampling {
    /// Between two samples.
    pub interval: Duration,
    /// The least recording time between two writes of a timeline that changes.
    pub write_every: Duration,
}

impl Default for Sampling {
    fn default() -> Self {
        Sampling {
            interval: SAMPLE_INTERVAL,
            write_every: Duration::from_secs(15),
        }
    }
}

/// What the reader's thread does next: a names tick goes first, speaking samples go in between.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Due {
    Names,
    Sample,
    /// Nothing until this much time has passed.
    Wait(Duration),
}

/// When the next names tick and the next sample are due, on the thread's own clock.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Schedule {
    next_names: Duration,
    next_sample: Option<Duration>,
}

impl Schedule {
    pub fn due(&self, now: Duration) -> Due {
        if now >= self.next_names {
            return Due::Names;
        }
        match self.next_sample {
            Some(at) if now >= at => Due::Sample,
            Some(at) => Due::Wait(at.min(self.next_names) - now),
            None => Due::Wait(self.next_names - now),
        }
    }

    /// A names tick ended at `now`; the next one is `delay` away. `sample`: the sample interval
    /// from now on, when samples are taken.
    pub fn ticked(&mut self, now: Duration, delay: Duration, sample: Option<Duration>) {
        self.next_names = now + delay;
        self.next_sample = sample.map(|interval| now + interval);
    }

    /// A sample ended at `now`; `next`: the interval to the next one, if samples go on.
    pub fn sampled(&mut self, now: Duration, next: Option<Duration>) {
        self.next_sample = next.map(|interval| now + interval);
    }
}

/// What one tick did, for the app's log and the status file. Counts, codes and rule ids only: no
/// field can hold a name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// The kind of outcome. Nothing was read: `not_live`, `mono`, `invalid_id`, `setting_off`,
    /// `no_rules`, `no_permission`, `unsupported`. The window was read: `names`, `no_apps` (no
    /// meeting app runs), `no_target`, `not_in_call`, `several_in_call:N`, `discarded:…`, or
    /// `capture_ended` when the capture paused or stopped during the reading.
    pub outcome: String,
    /// The running meeting apps the reading was given.
    pub apps: usize,
    /// Elements the reading visited.
    pub nodes: usize,
    pub elapsed_ms: u64,
    /// The names each rule found in this tick, as `rule=count` pairs.
    pub sources: String,
    /// The people kept for the recording so far.
    pub people: usize,
    /// One of them is given as the user.
    pub self_known: bool,
    /// The user is given by a known name, because no meeting app marked anybody.
    pub guessed: bool,
    /// The names file was written in this tick.
    pub saved: bool,
    /// The code of a save that failed. It is tried again on the next reading.
    pub error: Option<String>,
}

impl Report {
    fn of(outcome: &str) -> Self {
        Report {
            outcome: outcome.to_owned(),
            ..Report::default()
        }
    }
}

fn outcome(no_names: &NoNames) -> String {
    match no_names {
        NoNames::Unsupported => "unsupported".into(),
        NoNames::PermissionMissing => "no_permission".into(),
        NoNames::Skip(Skip::NoTarget) => "no_target".into(),
        NoNames::Skip(Skip::NotInCall) => "not_in_call".into(),
        NoNames::Skip(Skip::SeveralInCall(count)) => format!("several_in_call:{count}"),
        NoNames::Skip(Skip::Discarded(discard)) => format!("discarded:{discard:?}"),
        // A reason this file does not know yet. Its `Debug` holds codes and counts only.
        #[allow(unreachable_patterns)]
        other => format!("{other:?}"),
    }
}

fn sources(extraction: &Extraction) -> String {
    let counts: Vec<String> = extraction
        .sources
        .iter()
        .map(|source| format!("{}={}", source.id, source.entries.len()))
        .collect();
    counts.join(",")
}

/// The running apps a reading may look at: Zoom and the allow-listed browsers, nothing else.
fn running_apps<H: Host>(host: &H) -> Vec<RunningApp> {
    let mut apps = Vec::new();
    for bundle_id in std::iter::once(ZOOM_BUNDLE_ID).chain(CHROMIUM_BROWSERS) {
        if ax::app_kind(bundle_id).is_none() {
            continue;
        }
        apps.extend(
            host.running(bundle_id)
                .into_iter()
                // An app that gives another bundle id is not the app that was asked for.
                .filter(|app| app.pid > 0 && app.bundle_id == bundle_id),
        );
    }
    apps
}

/// The people of one recording. Kept while the capture is paused, so that ids stay the same
/// when it resumes; a new recording starts a new one.
struct Recording {
    id: String,
    roster: Roster,
    /// A meeting app marked somebody as the user during this recording. From then on the
    /// recording takes no guess, also when the roster later trusts no mark at all.
    marked: bool,
    /// The remembered names as they were before a mark in this recording changed them.
    before: Option<Vec<Name>>,
    /// What the names file holds.
    saved: Option<CallParticipants>,
    /// Who speaks when, once a names tick followed speaking markers.
    speaking: Option<Tracker>,
    /// The recording time of the last write of the timeline.
    speaking_written: Option<u64>,
}

impl Recording {
    /// The user's roster id in the participants as saved, if one is given.
    fn self_id(&self) -> Option<String> {
        let participants = self.saved.as_ref()?;
        let person = participants.people.iter().find(|person| person.is_self)?;
        Some(person.id.clone())
    }

    /// Write the timeline when it changed, at most every `every` of recording (always when
    /// `every` is `None`). A write that fails is tried again later.
    fn write_speaking(
        &mut self,
        store: &Store,
        now_ms: u64,
        every: Option<Duration>,
    ) -> Result<(), StoreError> {
        let Some(tracker) = self.speaking.as_ref() else {
            return Ok(());
        };
        let due = match (every, self.speaking_written) {
            (Some(every), Some(written)) => {
                now_ms.saturating_sub(written) >= every.as_millis() as u64
            }
            _ => true,
        };
        if !tracker.changed() || !due {
            return Ok(());
        }
        let Some(timeline) = tracker.timeline(self.self_id().as_deref()) else {
            return Ok(());
        };
        store.write_speaking(&self.id, &timeline)?;
        if let Some(tracker) = self.speaking.as_mut() {
            tracker.saved();
        }
        self.speaking_written = Some(now_ms);
        Ok(())
    }
}

/// Decides each tick whether to read, reads, and keeps the names file up to date.
pub struct Service<W: Window> {
    store: Store,
    window: W,
    rules: Option<Rules>,
    budget: Budget,
    pace: Pace,
    recording: Option<Recording>,
    /// The window was read since [`Window::stop`] was last called.
    reading: bool,
    /// The outcome and error last reported, so that a repeat is not reported again.
    reported: Option<(String, Option<String>)>,
    /// Gives the account's "gecos" field; called once, at the first reading.
    account: fn() -> Option<String>,
    /// The user's known names, from the first reading on. Before it, and so for as long as the
    /// setting is off, neither the account's name nor the remembered names are read.
    known: Option<SelfNames>,
    /// The kind of outcome in the status file.
    status: Option<String>,
    /// The time the ticks have taken since the status file was written.
    since_status: Duration,
    sampling: Sampling,
    /// The last names tick followed enough tiles: samples are taken until the next one.
    sample_ok: bool,
    /// Samples in a row that timed out, and until when (recording time) sampling stays slow.
    timeouts: u32,
    slow_until_ms: Option<u64>,
    /// Where the next sample starts when the tiles take turns.
    cursor: usize,
    /// The recording for which the system was last asked to prompt for the permission: it is
    /// asked once for each recording that meets a missing permission.
    prompted_for: Option<String>,
}

/// Why [`Service`] reads nothing on a tick.
enum Closed {
    /// The outcome to report.
    Because(&'static str),
    /// A recording, by its id, would be read but the permission is missing.
    NoPermission(String),
}

impl<W: Window> Service<W> {
    /// The service as the app runs it: the account's full name is a known name of the user.
    pub fn new(store: Store, window: W, pace: Pace) -> Self {
        Service::with_account(store, window, pace, account_gecos)
    }

    /// As [`Service::new`], with the account's "gecos" field given instead of read.
    pub fn with_account(
        store: Store,
        window: W,
        pace: Pace,
        account: fn() -> Option<String>,
    ) -> Self {
        store.tidy(SystemTime::now());
        Service {
            store,
            window,
            rules: Rules::embedded().ok(),
            budget: Budget::DEFAULT,
            pace,
            recording: None,
            reading: false,
            reported: None,
            account,
            known: None,
            status: None,
            since_status: Duration::ZERO,
            sampling: Sampling::default(),
            sample_ok: false,
            timeouts: 0,
            slow_until_ms: None,
            cursor: 0,
            prompted_for: None,
        }
    }

    /// Read with these rules instead of the embedded ones.
    pub fn set_rules(&mut self, rules: Rules) {
        self.rules = Some(rules);
    }

    /// Take speaking samples this way instead.
    pub fn set_sampling(&mut self, sampling: Sampling) {
        self.sampling = sampling;
    }

    /// The interval to the next speaking sample, while samples are taken: the last names tick
    /// read the window and followed three tiles or more.
    pub fn sampling(&self) -> Option<Duration> {
        (self.reading && self.sample_ok).then(|| self.interval())
    }

    fn interval(&self) -> Duration {
        if self.slow_until_ms.is_some() {
            SLOW_SAMPLE_INTERVAL
        } else {
            self.sampling.interval
        }
    }

    /// One speaking sample, between names ticks. Returns the interval to the next one, or `None`
    /// when samples stop until the next names tick. Reads nothing unless the capture is live
    /// with two channels, is the recording of the last names tick, the setting is on and three
    /// tiles or more are followed. The capture is asked again after the reads; when it paused or
    /// changed in between, the sample is dropped.
    pub fn sample<H: Host>(&mut self, host: &H) -> Option<Duration> {
        if !self.reading || !self.sample_ok {
            return None;
        }
        let recording = self.recording.as_ref()?;
        let slots = recording.speaking.as_ref()?.followed();
        if slots.is_empty() {
            return None;
        }
        let same = |live: &Live| live.id == recording.id && live.channels == STEREO;
        let before = host.live().filter(same)?;
        if !self.store.enabled() {
            return None;
        }
        if self
            .slow_until_ms
            .is_some_and(|until| before.recorded_ms >= until)
        {
            self.slow_until_ms = None;
        }
        let interval = self.interval();
        let chosen = tiles_to_read(&slots, interval, &mut self.cursor);
        let read = self.window.sample(&chosen);
        let after = host.live();
        let recording = self.recording.as_mut()?;
        let kept = after.as_ref().is_some_and(|after| {
            after.id == recording.id
                && after.channels == STEREO
                && after.recorded_ms >= before.recorded_ms
        });
        if read.timed_out {
            self.timeouts += 1;
            if self.timeouts >= TIMEOUTS_BEFORE_SLOW {
                self.timeouts = 0;
                self.slow_until_ms = Some(before.recorded_ms + SLOW_FOR.as_millis() as u64);
            }
        } else if read.calls > 0 {
            self.timeouts = 0;
        }
        let tracker = recording.speaking.as_mut()?;
        let report = SampleReport {
            at_ms: before.recorded_ms,
            interval_ms: interval.as_millis() as u64,
            tiles: tracker.preview(&read),
            calls: read.calls,
            elapsed: read.elapsed,
            timed_out: read.timed_out,
            kept,
        };
        if read.resting || read.not_trusted {
            // Nothing more until the next names tick says what can be read.
            tracker.unfollow();
            self.sample_ok = false;
        } else if kept {
            tracker.sample(before.recorded_ms, interval.as_millis() as u64, read);
        }
        host.sampled(&report);
        self.sample_ok.then(|| self.interval())
    }

    /// The capture paused or stopped, or reading stopped: the speaking intervals close and the
    /// timeline is written if it changed.
    fn pause_speaking(&mut self) {
        self.sample_ok = false;
        end_speaking(&mut self.recording, &self.store, false);
    }

    /// The service ends: the timeline is written and the apps get back what reading changed.
    pub fn finish(&mut self) {
        self.sample_ok = false;
        end_speaking(&mut self.recording, &self.store, true);
        self.stop();
    }

    /// One tick. Returns how long to wait before the next one.
    pub fn tick<H: Host>(&mut self, host: &H) -> Duration {
        let report = self.step(host);
        let said = (report.outcome.clone(), report.error.clone());
        if report.saved || self.reported.as_ref() != Some(&said) {
            host.report(&report);
            self.reported = Some(said);
        }
        let delay = if self.reading {
            self.pace.reading
        } else {
            self.pace.idle
        };
        self.tell(&report);
        self.since_status = self.since_status.saturating_add(delay);
        delay
    }

    /// Keep the status file up to date: at once when the kind of outcome changes, and every
    /// [`STATUS_INTERVAL`] while the window is being read. A status that cannot be written is
    /// tried again on the next tick.
    fn tell(&mut self, report: &Report) {
        let same = self.status.as_deref() == Some(report.outcome.as_str());
        if same && !(self.reading && self.since_status >= STATUS_INTERVAL) {
            return;
        }
        let speaking = self
            .recording
            .as_ref()
            .and_then(|recording| recording.speaking.as_ref())
            .map(Tracker::counts);
        if self
            .store
            .set_status_with(report, speaking, SystemTime::now())
            .is_ok()
        {
            self.status = Some(report.outcome.clone());
            self.since_status = Duration::ZERO;
        }
    }

    /// Stop reading: put back what the reading changed in the apps.
    pub fn stop(&mut self) {
        if std::mem::take(&mut self.reading) {
            self.window.stop();
        }
    }

    /// The capture to read now, or why nothing is read. The permission is checked on every call,
    /// so reading starts on the first tick after the user grants it.
    fn gate<H: Host>(&self, host: &H) -> Result<Live, Closed> {
        let live = host.live().ok_or(Closed::Because("not_live"))?;
        if live.channels != STEREO {
            return Err(Closed::Because("mono"));
        }
        if !valid_id(&live.id) {
            return Err(Closed::Because("invalid_id"));
        }
        if !self.store.enabled() {
            return Err(Closed::Because("setting_off"));
        }
        if self.rules.is_none() {
            return Err(Closed::Because("no_rules"));
        }
        match self.window.permission() {
            Permission::Granted => Ok(live),
            Permission::Unsupported => Err(Closed::Because("unsupported")),
            _ => Err(Closed::NoPermission(live.id)),
        }
    }

    fn step<H: Host>(&mut self, host: &H) -> Report {
        let live = match self.gate(host) {
            Ok(live) => live,
            Err(closed) => {
                let why = match closed {
                    Closed::Because(why) => why,
                    Closed::NoPermission(id) => {
                        // A recording would be read but for the permission, and the user may not
                        // know it is missing: the system is asked to prompt, once per recording.
                        if self.prompted_for.as_ref() != Some(&id) {
                            self.window.request_permission();
                            self.prompted_for = Some(id);
                        }
                        "no_permission"
                    }
                };
                self.pause_speaking();
                self.stop();
                return Report::of(why);
            }
        };
        let Some(rules) = self.rules.as_ref() else {
            return Report::of("no_rules");
        };
        let apps = running_apps(host);
        self.reading = true;
        let tick = self.window.read(rules, &apps, self.budget);
        let found = self.window.speaking();
        let names_app = tick.outcome.as_ref().ok().map(|extraction| extraction.app);
        let mut report = Report {
            apps: apps.len(),
            nodes: tick.nodes,
            elapsed_ms: tick.elapsed.as_millis() as u64,
            ..Report::default()
        };
        // The capture may have paused or stopped during the reading. Then the reading is not
        // kept and nothing is saved, so the names file stops changing with the capture.
        let Some(recorded_ms) = host
            .live()
            .filter(|now| now.id == live.id && now.channels == STEREO)
            .map(|now| now.recorded_ms)
        else {
            self.pause_speaking();
            self.stop();
            report.outcome = "capture_ended".into();
            return report;
        };
        if self
            .recording
            .as_ref()
            .is_none_or(|recording| recording.id != live.id)
        {
            self.sample_ok = false;
            end_speaking(&mut self.recording, &self.store, true);
            self.recording = None;
            self.timeouts = 0;
            self.slow_until_ms = None;
            self.cursor = 0;
        }
        let recording = self.recording.get_or_insert_with(|| Recording {
            id: live.id,
            roster: Roster::new(),
            marked: false,
            before: None,
            saved: None,
            speaking: None,
            speaking_written: None,
        });
        if let Some(tracker) = recording.speaking.as_mut() {
            tracker.resume(recorded_ms);
        }
        let known = self
            .known
            .get_or_insert_with(|| SelfNames::load(&self.store, self.account));
        match tick.outcome {
            Ok(extraction) => {
                report.outcome = "names".into();
                report.sources = sources(&extraction);
                recording.roster.observe(recorded_ms, &extraction);
                // A name the meeting app itself marks as the user is remembered for later calls.
                let mut marked = false;
                for person in recording
                    .roster
                    .people()
                    .iter()
                    .filter(|person| person.is_self)
                {
                    marked = true;
                    if let Some(before) = known.remember(&person.name) {
                        recording.before.get_or_insert(before);
                    }
                }
                if marked {
                    recording.marked = true;
                } else if recording.marked {
                    // The roster withdrew its mark, because a second person carried it. Then
                    // what this recording taught is not to be trusted either.
                    if let Some(before) = recording.before.take() {
                        known.restore(before);
                    }
                }
            }
            // Without a running meeting app there is no window to look for.
            Err(NoNames::Skip(Skip::NoTarget)) if apps.is_empty() => {
                report.outcome = "no_apps".into()
            }
            Err(no_names) => report.outcome = outcome(&no_names),
        }
        // A save that fails is tried again on the next reading: what is kept stays unsaved.
        let mut failed = None;
        if known.unsaved {
            match self.store.set_self_names(&known.remembered) {
                Ok(()) => known.unsaved = false,
                Err(error) => failed = Some(error),
            }
        }
        let mut participants = recording.roster.participants();
        if let Some(participants) = participants.as_mut() {
            report.guessed = !recording.marked && known.mark(participants);
            report.self_known = participants.people.iter().any(|person| person.is_self);
        }
        if participants != recording.saved {
            let written = match &participants {
                Some(people) => self.store.write(&recording.id, people),
                None => Ok(()),
            };
            match written {
                Ok(()) => {
                    report.saved = participants.is_some();
                    recording.saved = participants;
                }
                Err(error) => failed = Some(error),
            }
        }
        // Who speaks: the tiles this tick followed confirm the samples taken since the last.
        let looked = found.as_ref();
        if recording.speaking.is_none() {
            let rule =
                names_app.and_then(|app| rules.app(app)?.speaking.first().map(|rule| (app, rule)));
            if let (Some((app, rule)), Some(found)) = (rule, looked) {
                if !found.tiles.is_empty() {
                    recording.speaking = Some(Tracker::new(
                        app,
                        rules.version,
                        self.sampling.interval.as_millis() as u64,
                        Tokens::for_rule(rule),
                    ));
                }
            }
        }
        self.sample_ok = false;
        if let Some(tracker) = recording.speaking.as_mut() {
            let roster = &recording.roster;
            let order: Vec<String> = roster
                .people()
                .iter()
                .map(|person| person.id.clone())
                .collect();
            tracker.set_order(&order);
            tracker.tick(recorded_ms, looked, |name| {
                let person = roster.people().iter().find(|person| &person.name == name)?;
                Some(person.id.clone())
            });
            self.sample_ok = !tracker.followed().is_empty();
            let every = Some(self.sampling.write_every);
            if let Err(error) = recording.write_speaking(&self.store, recorded_ms, every) {
                failed = Some(error);
            }
        }
        report.error = failed.map(|error| error.to_string());
        report.people = recording.roster.people().len();
        report
    }
}

/// The capture paused or stopped (`finished`: the recording is over): the speaking intervals of
/// the recording close, what still waits is classified when it is over, and the timeline is
/// written if it changed. A write that fails is tried again later.
fn end_speaking(recording: &mut Option<Recording>, store: &Store, finished: bool) {
    let Some(recording) = recording.as_mut() else {
        return;
    };
    let Some(tracker) = recording.speaking.as_mut() else {
        return;
    };
    if finished {
        tracker.finish();
    } else {
        tracker.pause();
    }
    let now = recording.speaking_written.unwrap_or(0);
    let _ = recording.write_speaking(store, now, None);
}

#[derive(Default)]
struct Flags {
    stop: bool,
    done: bool,
}

#[derive(Default)]
struct Shared {
    flags: Mutex<Flags>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Flags> {
        self.flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Wait for `delay`, or less when a stop is asked. True when a stop was asked.
    fn sleep(&self, delay: Duration) -> bool {
        let (flags, _) = self
            .changed
            .wait_timeout_while(self.lock(), delay, |flags| !flags.stop)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        flags.stop
    }
}

/// Says that the thread has ended, however it ended.
struct Done(Arc<Shared>);

impl Drop for Done {
    fn drop(&mut self) {
        self.0.lock().done = true;
        self.0.changed.notify_all();
    }
}

/// The reader's thread, as the app holds it.
pub struct Worker {
    shared: Arc<Shared>,
}

impl Worker {
    /// Ask the thread to stop, and wait up to `wait` until it has put back what it changed in
    /// the apps and ended. True when it ended in that time.
    pub fn stop(&self, wait: Duration) -> bool {
        let mut flags = self.shared.lock();
        flags.stop = true;
        self.shared.changed.notify_all();
        let (flags, _) = self
            .shared
            .changed
            .wait_timeout_while(flags, wait, |flags| !flags.done)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        flags.done
    }
}

/// Start the reader's thread with the real window reader. The reader is made, used, stopped and
/// dropped on that thread.
pub fn spawn<H: Host + Send + 'static>(store: Store, host: H) -> io::Result<Worker> {
    spawn_with(store, host, Pace::default(), ax::Reader::new)
}

/// As [`spawn`], with the pace and the window given; `window` runs on the new thread.
pub fn spawn_with<H, W, F>(store: Store, host: H, pace: Pace, window: F) -> io::Result<Worker>
where
    H: Host + Send + 'static,
    W: Window,
    F: FnOnce() -> W + Send + 'static,
{
    let shared = Arc::new(Shared::default());
    let done = Done(shared.clone());
    std::thread::Builder::new()
        .name(THREAD_NAME.into())
        .spawn(move || {
            // Declared first, so dropped last: after the service and its window are gone.
            let done = done;
            let mut service = Service::new(store, window(), pace);
            let started = std::time::Instant::now();
            let mut schedule = Schedule::default();
            loop {
                let wait = match schedule.due(started.elapsed()) {
                    Due::Names => {
                        let mut delay = pace.idle;
                        host.scope(&mut || delay = service.tick(&host));
                        schedule.ticked(started.elapsed(), delay, service.sampling());
                        Duration::ZERO
                    }
                    Due::Sample => {
                        let mut next = None;
                        host.scope(&mut || next = service.sample(&host));
                        schedule.sampled(started.elapsed(), next);
                        Duration::ZERO
                    }
                    Due::Wait(wait) => wait,
                };
                // Also asks whether to stop after a tick or a sample, without waiting.
                if done.0.sleep(wait) {
                    break;
                }
            }
            host.scope(&mut || service.finish());
        })?;
    Ok(Worker { shared })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ax::REFUSED_BUNDLE_IDS;
    use crate::extract::{Entry, SourceNames};
    use crate::rules::App;
    use crate::session::Discard;
    use std::collections::VecDeque;
    use std::thread::{self, ThreadId};

    const RECORDING: &str = "0b9f6a52-7c1d-4e8a-9f3b-2d5c8e1a4b70";
    const NEXT_RECORDING: &str = "7e2d9c14-55aa-4b0f-8c66-91f0a3b2c4d5";
    const ALEX_AND_SAM: &str = r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Alex Example","self":true},{"id":"p2","name":"Robin Sample"}],"truncated":false}"#;
    const FAST: Pace = Pace {
        reading: Duration::from_millis(5),
        idle: Duration::from_millis(2),
    };

    /// A folder of its own for one test, removed afterwards.
    struct Folder(PathBuf);

    impl Folder {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "call-names-service-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Folder(dir)
        }

        fn store(&self) -> Store {
            Store::new(self.0.join("call-names"))
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct HostState {
        live: Option<Live>,
        /// No meeting app runs.
        no_apps: bool,
        asked: Vec<String>,
        reports: Vec<Report>,
        scopes: usize,
    }

    /// The app, as the service sees it. Chrome runs; the lookup also gives two process ids that
    /// are not real and one app that gives another bundle id.
    #[derive(Clone, Default)]
    struct FakeHost(Arc<Mutex<HostState>>);

    impl FakeHost {
        fn record(&self, id: &str, channels: u8, recorded_ms: u64) {
            self.0.lock().unwrap().live = Some(Live {
                id: id.to_owned(),
                channels,
                recorded_ms,
            });
        }

        fn pause(&self) {
            self.0.lock().unwrap().live = None;
        }

        fn asked(&self) -> Vec<String> {
            self.0.lock().unwrap().asked.clone()
        }

        fn reports(&self) -> Vec<Report> {
            self.0.lock().unwrap().reports.clone()
        }

        fn outcomes(&self) -> Vec<String> {
            self.reports()
                .into_iter()
                .map(|report| report.outcome)
                .collect()
        }
    }

    impl Host for FakeHost {
        fn live(&self) -> Option<Live> {
            self.0.lock().unwrap().live.clone()
        }

        fn running(&self, bundle_id: &str) -> Vec<RunningApp> {
            let mut state = self.0.lock().unwrap();
            state.asked.push(bundle_id.to_owned());
            if state.no_apps {
                return Vec::new();
            }
            let app = |pid, bundle_id: &str| RunningApp {
                pid,
                bundle_id: bundle_id.to_owned(),
            };
            match bundle_id {
                "com.google.Chrome" => vec![
                    app(0, bundle_id),
                    app(-1, bundle_id),
                    app(4242, bundle_id),
                    app(4343, "com.apple.Safari"),
                ],
                "com.apple.Safari" => vec![app(777, bundle_id)],
                _ => Vec::new(),
            }
        }

        fn scope(&self, tick: &mut dyn FnMut()) {
            self.0.lock().unwrap().scopes += 1;
            tick()
        }

        fn report(&self, report: &Report) {
            self.0.lock().unwrap().reports.push(report.clone());
        }
    }

    type Reading = Result<Extraction, NoNames>;

    struct WindowState {
        permission: Permission,
        permission_checks: usize,
        /// How often the system was asked to prompt for the permission.
        permission_requests: usize,
        /// What the next readings return; the last one repeats.
        script: VecDeque<Reading>,
        /// The apps each reading was given.
        reads: Vec<Vec<RunningApp>>,
        stops: usize,
        /// Runs during the next reading: a pause or a stop that lands in the middle of it.
        during: Option<Box<dyn FnOnce() + Send>>,
        /// What happened to the window, and on which thread.
        threads: Vec<(&'static str, ThreadId)>,
    }

    struct FakeWindow(Arc<Mutex<WindowState>>);

    impl FakeWindow {
        fn new(state: &Arc<Mutex<WindowState>>) -> Self {
            state.lock().unwrap().mark("made");
            FakeWindow(state.clone())
        }
    }

    impl WindowState {
        fn new() -> Arc<Mutex<WindowState>> {
            Arc::new(Mutex::new(WindowState {
                permission: Permission::Granted,
                permission_checks: 0,
                permission_requests: 0,
                script: VecDeque::from([people(&[
                    ("Alex Example", true),
                    ("Robin Sample", false),
                ])]),
                reads: Vec::new(),
                stops: 0,
                during: None,
                threads: Vec::new(),
            }))
        }

        fn mark(&mut self, what: &'static str) {
            self.threads.push((what, thread::current().id()));
        }
    }

    impl Window for FakeWindow {
        fn permission(&self) -> Permission {
            let mut state = self.0.lock().unwrap();
            state.permission_checks += 1;
            state.permission
        }

        fn request_permission(&self) {
            self.0.lock().unwrap().permission_requests += 1;
        }

        fn read(&mut self, rules: &Rules, apps: &[RunningApp], _budget: Budget) -> TickReport {
            assert!(rules.app(App::GoogleMeet).is_some());
            let (outcome, during) = {
                let mut state = self.0.lock().unwrap();
                state.mark("read");
                state.reads.push(apps.to_vec());
                let outcome = if state.script.len() > 1 {
                    state.script.pop_front().unwrap()
                } else {
                    state.script[0].clone()
                };
                (outcome, state.during.take())
            };
            if let Some(during) = during {
                during();
            }
            TickReport {
                outcome,
                nodes: 12,
                elapsed: Duration::from_millis(3),
            }
        }

        fn stop(&mut self) {
            let mut state = self.0.lock().unwrap();
            state.mark("stop");
            state.stops += 1;
        }
    }

    impl Drop for FakeWindow {
        fn drop(&mut self) {
            // A test that failed while it held the lock has poisoned it. That failure is the one
            // to show; a second panic here would hide it.
            if let Ok(mut state) = self.0.lock() {
                state.mark("dropped");
            }
        }
    }

    /// The names of the files in a store, sorted.
    fn files(store: &Store) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(store.dir())
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Every part of a made-up name in these tests, in small letters: none may reach a log or the
    /// status file.
    const NAME_PARTS: [&str; 5] = ["alex", "example", "robin", "sample", "guest"];

    /// A reading that found these people in a Meet participant list.
    fn people(found: &[(&str, bool)]) -> Reading {
        Ok(Extraction {
            app: App::GoogleMeet,
            sources: vec![SourceNames {
                id: "panel".into(),
                one_per_person: true,
                entries: found
                    .iter()
                    .map(|(name, is_self)| Entry {
                        name: Name::clean(name).unwrap(),
                        is_self: *is_self,
                    })
                    .collect(),
            }],
            truncated: false,
        })
    }

    /// A service with the setting on, the permission granted and a call with two people, on a
    /// computer whose account has no full name.
    struct Rig {
        _folder: Folder,
        store: Store,
        host: FakeHost,
        window: Arc<Mutex<WindowState>>,
        service: Service<FakeWindow>,
    }

    impl Rig {
        fn new() -> Rig {
            Rig::with_account(|| None)
        }

        fn with_account(account: fn() -> Option<String>) -> Rig {
            let folder = Folder::new();
            let store = folder.store();
            store.set_enabled(true).unwrap();
            let window = WindowState::new();
            let service = Service::with_account(
                store.clone(),
                FakeWindow::new(&window),
                Pace::default(),
                account,
            );
            Rig {
                _folder: folder,
                store,
                host: FakeHost::default(),
                window,
                service,
            }
        }

        /// The service after the app was started again: nothing in memory, the same folder.
        fn restart(&mut self) {
            self.window = WindowState::new();
            self.service = Service::with_account(
                self.store.clone(),
                FakeWindow::new(&self.window),
                Pace::default(),
                || None,
            );
        }

        fn tick(&mut self) -> Duration {
            self.service.tick(&self.host)
        }

        fn next(&self, readings: Vec<Reading>) {
            self.window.lock().unwrap().script = readings.into();
        }

        fn reads(&self) -> usize {
            self.window.lock().unwrap().reads.len()
        }

        fn stops(&self) -> usize {
            self.window.lock().unwrap().stops
        }

        /// The names file of a recording, as it is on disk.
        fn file(&self, id: &str) -> Option<String> {
            fs::read_to_string(self.store.dir().join(format!("{id}.json"))).ok()
        }

        /// The names of the files in the store, sorted.
        fn files(&self) -> Vec<String> {
            files(&self.store)
        }
    }

    #[test]
    fn nothing_is_read_while_the_setting_is_off() {
        let mut rig = Rig::new();
        rig.store.set_enabled(false).unwrap();
        rig.host.record(RECORDING, STEREO, 1_000);
        for _ in 0..3 {
            assert_eq!(rig.tick(), IDLE_INTERVAL);
        }
        assert_eq!(rig.reads(), 0);
        assert_eq!(rig.window.lock().unwrap().permission_checks, 0);
        assert!(rig.host.asked().is_empty());
        assert_eq!(rig.files(), [SETTING_FILE, STATUS_FILE]);
        assert_eq!(rig.host.outcomes(), ["setting_off"]);

        // On: the next tick reads. Off again: reading stops and the browser gets its flag back.
        rig.store.set_enabled(true).unwrap();
        assert_eq!(rig.tick(), READING_INTERVAL);
        assert_eq!(rig.reads(), 1);
        rig.store.set_enabled(false).unwrap();
        assert_eq!(rig.tick(), IDLE_INTERVAL);
        assert_eq!(rig.tick(), IDLE_INTERVAL);
        assert_eq!((rig.reads(), rig.stops()), (1, 1));
        // The names read while it was on stay for the note.
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));
    }

    #[test]
    fn the_setting_is_off_until_the_user_turns_it_on() {
        let folder = Folder::new();
        let window = WindowState::new();
        let mut service = Service::new(folder.store(), FakeWindow::new(&window), Pace::default());
        let host = FakeHost::default();
        host.record(RECORDING, STEREO, 1_000);
        service.tick(&host);
        assert!(window.lock().unwrap().reads.is_empty());
        assert!(host.asked().is_empty());
        // The service says what it does, and nothing else is in the folder.
        assert_eq!(files(&folder.store()), [STATUS_FILE]);
    }

    #[test]
    fn a_mono_recording_is_never_read() {
        let mut rig = Rig::new();
        rig.host.record(RECORDING, 1, 1_000);
        for _ in 0..3 {
            assert_eq!(rig.tick(), IDLE_INTERVAL);
        }
        assert_eq!(rig.reads(), 0);
        assert_eq!(rig.window.lock().unwrap().permission_checks, 0);
        assert!(rig.host.asked().is_empty());
        assert_eq!(rig.file(RECORDING), None);
        assert_eq!(rig.host.outcomes(), ["mono"]);
    }

    #[test]
    fn nothing_is_read_without_a_live_capture() {
        let mut rig = Rig::new();
        for _ in 0..3 {
            assert_eq!(rig.tick(), IDLE_INTERVAL);
        }
        assert_eq!((rig.reads(), rig.stops()), (0, 0));
        assert!(rig.host.asked().is_empty());
        assert_eq!(rig.host.outcomes(), ["not_live"]);
    }

    #[test]
    fn the_names_file_appears_while_live_and_stops_changing_on_pause_and_stop() {
        let mut rig = Rig::new();
        rig.host.record(RECORDING, STEREO, 1_000);
        assert_eq!(rig.tick(), READING_INTERVAL);
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));
        assert_eq!(
            rig.files(),
            [
                format!("{RECORDING}.json"),
                SELF_NAMES_FILE.into(),
                SETTING_FILE.into(),
                STATUS_FILE.into()
            ]
        );

        // Paused: a third person is in the call now, but the very next tick reads nothing.
        let three = people(&[
            ("Alex Example", true),
            ("Robin Sample", false),
            ("Test Guest A", false),
        ]);
        rig.next(vec![three]);
        rig.host.pause();
        assert_eq!(rig.tick(), IDLE_INTERVAL);
        assert_eq!(rig.tick(), IDLE_INTERVAL);
        assert_eq!((rig.reads(), rig.stops()), (1, 1));
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));

        // Resumed: the same people keep their ids and the new one follows.
        rig.host.record(RECORDING, STEREO, 9_000);
        assert_eq!(rig.tick(), READING_INTERVAL);
        let resumed = rig.file(RECORDING).unwrap();
        assert_eq!(
            resumed,
            ALEX_AND_SAM.replace("}]", r#"},{"id":"p3","name":"Test Guest A"}]"#)
        );

        // Stopped: the file is as the last live tick left it.
        rig.next(vec![people(&[
            ("Alex Example", true),
            ("Test Guest B", false),
        ])]);
        rig.host.pause();
        for _ in 0..3 {
            assert_eq!(rig.tick(), IDLE_INTERVAL);
        }
        assert_eq!((rig.reads(), rig.stops()), (2, 2));
        assert_eq!(rig.file(RECORDING), Some(resumed));
    }

    #[test]
    fn a_reading_that_ends_after_the_capture_paused_is_thrown_away() {
        let mut rig = Rig::new();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.next(vec![people(&[("Alex Example", true)])]);
        rig.tick();
        let before = rig.file(RECORDING).unwrap();

        rig.next(vec![people(&[
            ("Alex Example", true),
            ("Robin Sample", false),
        ])]);
        let host = rig.host.clone();
        rig.window.lock().unwrap().during = Some(Box::new(move || host.pause()));
        assert_eq!(rig.tick(), IDLE_INTERVAL);
        assert_eq!((rig.reads(), rig.stops()), (2, 1));
        assert_eq!(rig.file(RECORDING), Some(before.clone()));
        assert_eq!(rig.host.outcomes().last().unwrap(), "capture_ended");

        // The same when another recording went live during the reading.
        rig.host.record(RECORDING, STEREO, 2_000);
        let host = rig.host.clone();
        rig.window.lock().unwrap().during =
            Some(Box::new(move || host.record(NEXT_RECORDING, STEREO, 0)));
        rig.tick();
        assert_eq!(rig.file(RECORDING), Some(before));
        assert_eq!(rig.file(NEXT_RECORDING), None);
    }

    #[test]
    fn a_new_recording_starts_with_nobody() {
        let mut rig = Rig::new();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        rig.next(vec![people(&[("Robin Sample", false)])]);
        rig.host.record(NEXT_RECORDING, STEREO, 500);
        rig.tick();
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));
        assert_eq!(
            rig.file(NEXT_RECORDING).as_deref(),
            Some(
                r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Robin Sample"}],"truncated":false}"#
            )
        );
    }

    #[test]
    fn nothing_is_read_without_the_permission() {
        let mut rig = Rig::new();
        rig.window.lock().unwrap().permission = Permission::Missing;
        rig.host.record(RECORDING, STEREO, 1_000);
        assert_eq!(rig.tick(), IDLE_INTERVAL);
        assert_eq!(rig.reads(), 0);
        assert!(rig.host.asked().is_empty());
        assert_eq!(rig.host.outcomes(), ["no_permission"]);

        rig.window.lock().unwrap().permission = Permission::Granted;
        assert_eq!(rig.tick(), READING_INTERVAL);
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));

        // Revoked during the recording: reading stops, and what was read is kept.
        rig.window.lock().unwrap().permission = Permission::Missing;
        assert_eq!(rig.tick(), IDLE_INTERVAL);
        assert_eq!((rig.reads(), rig.stops()), (1, 1));
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));

        rig.window.lock().unwrap().permission = Permission::Unsupported;
        rig.tick();
        assert_eq!(rig.host.outcomes().last().unwrap(), "unsupported");
        assert_eq!(rig.reads(), 1);
    }

    #[test]
    fn a_recording_that_meets_a_missing_permission_asks_for_it_once_not_on_each_tick() {
        let mut rig = Rig::new();
        rig.window.lock().unwrap().permission = Permission::Missing;
        rig.host.record(RECORDING, STEREO, 1_000);
        for _ in 0..3 {
            assert_eq!(rig.tick(), IDLE_INTERVAL);
        }
        assert_eq!(rig.window.lock().unwrap().permission_requests, 1);
        // The permission is still checked on every tick, and nothing else changes.
        assert_eq!(rig.window.lock().unwrap().permission_checks, 3);
        assert_eq!(rig.reads(), 0);
        assert_eq!(rig.host.outcomes(), ["no_permission"]);
        assert_eq!(status(&rig.store).0, "no_permission");

        // Paused and resumed, it is the same recording: it is not asked again.
        rig.host.pause();
        rig.tick();
        rig.host.record(RECORDING, STEREO, 5_000);
        rig.tick();
        assert_eq!(rig.window.lock().unwrap().permission_requests, 1);

        // Granted: the same recording is read on the next tick, and nothing more is asked.
        rig.window.lock().unwrap().permission = Permission::Granted;
        assert_eq!(rig.tick(), READING_INTERVAL);
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));
        assert_eq!(rig.window.lock().unwrap().permission_requests, 1);
    }

    #[test]
    fn the_next_recording_with_the_permission_still_missing_asks_again_once() {
        let mut rig = Rig::new();
        rig.window.lock().unwrap().permission = Permission::Missing;
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        rig.tick();
        rig.host.pause();
        rig.tick();
        assert_eq!(rig.window.lock().unwrap().permission_requests, 1);

        rig.host.record(NEXT_RECORDING, STEREO, 0);
        for _ in 0..3 {
            rig.tick();
        }
        assert_eq!(rig.window.lock().unwrap().permission_requests, 2);
        assert_eq!(rig.reads(), 0);
    }

    #[test]
    fn nothing_asks_for_the_permission_when_the_recording_would_not_be_read_anyway() {
        let requests = |rig: &Rig| rig.window.lock().unwrap().permission_requests;

        // Nothing is live.
        let mut rig = Rig::new();
        rig.window.lock().unwrap().permission = Permission::Missing;
        rig.tick();
        assert_eq!(requests(&rig), 0);

        // The recording is mono.
        rig.host.record(RECORDING, 1, 1_000);
        rig.tick();
        assert_eq!(requests(&rig), 0);

        // The id is not valid.
        rig.host.record("not/an/id", STEREO, 1_000);
        rig.tick();
        assert_eq!(requests(&rig), 0);

        // The setting is off.
        rig.store.set_enabled(false).unwrap();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(requests(&rig), 0);

        // There are no rules.
        rig.store.set_enabled(true).unwrap();
        rig.service.rules = None;
        rig.tick();
        assert_eq!(requests(&rig), 0);
        assert_eq!(
            rig.host.outcomes(),
            ["not_live", "mono", "invalid_id", "setting_off", "no_rules"]
        );

        // The permission is granted, or there is none to ask for on this computer.
        for permission in [Permission::Granted, Permission::Unsupported] {
            let mut rig = Rig::new();
            rig.window.lock().unwrap().permission = permission;
            rig.host.record(RECORDING, STEREO, 1_000);
            rig.tick();
            rig.tick();
            assert_eq!(requests(&rig), 0);
        }
    }

    #[test]
    fn only_zoom_and_the_allow_listed_browsers_are_looked_up() {
        let mut rig = Rig::new();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        let mut expected = vec![ZOOM_BUNDLE_ID.to_owned()];
        expected.extend(CHROMIUM_BROWSERS.map(String::from));
        assert_eq!(rig.host.asked(), expected);
        for refused in REFUSED_BUNDLE_IDS {
            assert!(!rig.host.asked().iter().any(|asked| asked == refused));
        }
        // Process ids that are not real are left out, and so is the app that gave another
        // bundle id than the one asked for.
        assert_eq!(
            rig.window.lock().unwrap().reads,
            [vec![RunningApp {
                pid: 4242,
                bundle_id: "com.google.Chrome".into()
            }]]
        );
    }

    #[test]
    fn a_failed_save_is_reported_and_tried_again() {
        let mut rig = Rig::new();
        rig.host.record(RECORDING, STEREO, 1_000);
        // A folder where the names file belongs: the save cannot replace it.
        let blocked = rig.store.dir().join(format!("{RECORDING}.json"));
        fs::create_dir_all(blocked.join("in-the-way")).unwrap();
        rig.tick();
        let report = rig.host.reports().pop().unwrap();
        assert_eq!((report.outcome.as_str(), report.saved), ("names", false));
        assert!(report.error.unwrap().starts_with("call_names_io: "));
        // No temporary file is left behind.
        assert_eq!(
            rig.files(),
            [
                format!("{RECORDING}.json"),
                SELF_NAMES_FILE.into(),
                SETTING_FILE.into(),
                STATUS_FILE.into()
            ]
        );

        fs::remove_dir_all(&blocked).unwrap();
        rig.tick();
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));
        let report = rig.host.reports().pop().unwrap();
        assert_eq!((report.saved, report.error), (true, None));
    }

    #[test]
    fn reports_hold_counts_and_codes_and_are_not_repeated() {
        let mut rig = Rig::new();
        rig.tick();
        rig.tick();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        rig.tick();
        rig.next(vec![
            Err(NoNames::Skip(Skip::NotInCall)),
            Err(NoNames::Skip(Skip::NotInCall)),
            Err(NoNames::Skip(Skip::SeveralInCall(2))),
            Err(NoNames::Skip(Skip::Discarded(Discard::Time))),
            Err(NoNames::Skip(Skip::NoTarget)),
            Err(NoNames::PermissionMissing),
            people(&[("Alex Example", true), ("Robin Sample", false)]),
        ]);
        for _ in 0..7 {
            rig.tick();
        }
        rig.host.pause();
        rig.tick();
        assert_eq!(
            rig.host.outcomes(),
            [
                "not_live",
                "names",
                "not_in_call",
                "several_in_call:2",
                "discarded:Time",
                "no_target",
                "no_permission",
                "names",
                "not_live"
            ]
        );
        assert_eq!(
            rig.host.reports()[1],
            Report {
                outcome: "names".into(),
                apps: 1,
                nodes: 12,
                elapsed_ms: 3,
                sources: "panel=2".into(),
                people: 2,
                self_known: true,
                guessed: false,
                saved: true,
                error: None,
            }
        );
        let log = format!("{:?}", rig.host.reports());
        for name in ["Alex", "Example", "Robin", "Sample"] {
            assert!(!log.contains(name), "{log}");
        }
    }

    #[test]
    fn a_bad_id_is_refused() {
        let folder = Folder::new();
        let store = folder.store();
        let secret = folder.0.join("secret.json");
        fs::write(&secret, ALEX_AND_SAM).unwrap();
        let participants = CallParticipants::from_json(ALEX_AND_SAM).unwrap();
        let long = "a".repeat(65);
        for bad in [
            "",
            ".",
            "..",
            "../secret",
            "a/b",
            "a\\b",
            "a.b",
            "secret.json",
            "_setting",
            "a b",
            "a\0b",
            "é",
            long.as_str(),
        ] {
            assert!(!valid_id(bad), "{bad:?}");
            assert_eq!(store.read(bad), Err(StoreError::InvalidId), "{bad:?}");
            assert_eq!(
                store.write(bad, &participants),
                Err(StoreError::InvalidId),
                "{bad:?}"
            );
            assert_eq!(store.clear(bad), Err(StoreError::InvalidId), "{bad:?}");
        }
        assert_eq!(fs::read_to_string(&secret).unwrap(), ALEX_AND_SAM);
        assert!(!store.dir().exists());
        assert_eq!(StoreError::InvalidId.to_string(), "invalid_recording_id");

        let longest = "a".repeat(64);
        for good in [RECORDING, "abc", "A-1", longest.as_str()] {
            assert!(valid_id(good), "{good}");
            assert_eq!(store.read(good), Ok(None));
        }

        // A live capture with such an id is not read either.
        let mut rig = Rig::new();
        rig.host.record("../secret", STEREO, 1_000);
        rig.tick();
        assert_eq!(rig.reads(), 0);
        assert_eq!(rig.host.outcomes(), ["invalid_id"]);
    }

    #[test]
    fn clear_removes_the_names_file_of_that_recording_only() {
        let folder = Folder::new();
        let store = folder.store();
        let participants = CallParticipants::from_json(ALEX_AND_SAM).unwrap();
        store.write(RECORDING, &participants).unwrap();
        store.write(NEXT_RECORDING, &participants).unwrap();
        // What an interrupted write would leave behind.
        let leftover = store.dir().join(format!("{RECORDING}.json.1.2.tmp"));
        fs::write(&leftover, ALEX_AND_SAM).unwrap();

        assert_eq!(store.clear(RECORDING), Ok(()));
        assert_eq!(store.read(RECORDING), Ok(None));
        assert!(!leftover.exists());
        assert_eq!(store.read(NEXT_RECORDING), Ok(Some(participants)));
        // Nothing to clear is not an error.
        assert_eq!(store.clear(RECORDING), Ok(()));
        assert_eq!(Folder::new().store().clear(RECORDING), Ok(()));
    }

    #[test]
    fn read_gives_the_agreed_object_and_removes_what_it_cannot_read() {
        let folder = Folder::new();
        let store = folder.store();
        assert_eq!(store.read(RECORDING), Ok(None));
        let participants = CallParticipants::from_json(ALEX_AND_SAM).unwrap();
        store.write(RECORDING, &participants).unwrap();
        let read = store.read(RECORDING).unwrap().unwrap();
        assert_eq!(serde_json::to_string(&read).unwrap(), ALEX_AND_SAM);
        // A write leaves the one file, whole, and reading it leaves it there.
        let path = store.dir().join(format!("{RECORDING}.json"));
        assert_eq!(fs::read_to_string(&path).unwrap(), ALEX_AND_SAM);
        assert_eq!(fs::read_dir(store.dir()).unwrap().count(), 1);

        // What can never be saved with the note does not stay on the computer.
        let other_version = ALEX_AND_SAM.replace("\"v\":1", "\"v\":2");
        let too_large = format!("{ALEX_AND_SAM}{}", " ".repeat(70_000));
        for unreadable in [
            &b"{\"v\":1"[..],
            &b"[]"[..],
            other_version.as_bytes(),
            too_large.as_bytes(),
            &[0xff, 0xfe, 0x00][..],
        ] {
            fs::write(&path, unreadable).unwrap();
            assert_eq!(store.read(RECORDING), Ok(None));
            assert!(!path.exists());
        }

        // A failure of the file system is an error, and nothing is removed.
        fs::create_dir_all(path.join("in-the-way")).unwrap();
        assert!(matches!(store.read(RECORDING), Err(StoreError::Io(_))));
        assert!(path.join("in-the-way").exists());
    }

    #[test]
    fn the_setting_is_kept_in_the_folder() {
        let folder = Folder::new();
        let store = folder.store();
        assert!(!store.enabled());
        assert!(!store.dir().exists());
        store.set_enabled(true).unwrap();
        assert!(store.enabled());
        assert!(folder.store().enabled());
        let path = store.dir().join(SETTING_FILE);
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"enabled":true}"#);
        store.set_enabled(false).unwrap();
        assert!(!store.enabled());
        for unreadable in [
            "",
            "true",
            r#"{"enabled":"yes"}"#,
            r#"{"enabled":true,"x":1}"#,
        ] {
            fs::write(&path, unreadable).unwrap();
            assert!(!store.enabled(), "{unreadable}");
        }
        // Neither the setting nor the remembered names can be reached as a recording.
        for file in [SETTING_FILE, SELF_NAMES_FILE] {
            assert!(!valid_id(file.trim_end_matches(".json")), "{file}");
        }
        assert_eq!(
            Store::in_app_data(Path::new("/data")).dir(),
            Path::new("/data/voice-notes/call-names")
        );
    }

    #[test]
    fn state_has_the_shape_the_settings_screen_reads() {
        let folder = Folder::new();
        let store = folder.store();
        let off = serde_json::to_value(state(&store)).unwrap();
        assert_eq!(
            off,
            serde_json::json!({ "enabled": false, "permission": ax::permission() })
        );
        store.set_enabled(true).unwrap();
        assert!(state(&store).enabled);
        let permission = off["permission"].as_str().unwrap();
        assert!(["granted", "missing", "unsupported"].contains(&permission));
    }

    /// The file of remembered names, as it is on disk.
    fn remembered(store: &Store) -> Option<String> {
        fs::read_to_string(store.dir().join(SELF_NAMES_FILE)).ok()
    }

    fn names(store: &Store) -> Vec<String> {
        store
            .self_names()
            .iter()
            .map(|name| name.as_str().to_owned())
            .collect()
    }

    fn name(text: &str) -> Name {
        Name::clean(text).unwrap()
    }

    const UNMARKED: [(&str, bool); 2] = [("Alex Example", false), ("Robin Sample", false)];

    #[test]
    fn the_account_name_alone_marks_the_one_person_who_has_it() {
        // Spaces and the case of letters do not matter.
        let mut rig = Rig::with_account(|| Some("  alex   EXAMPLE ".to_owned()));
        rig.next(vec![people(&UNMARKED)]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));
        let report = rig.host.reports().pop().unwrap();
        assert!(report.guessed && report.saved);
        // A guess is not a mark: nothing is remembered, and the account's name is never stored.
        assert_eq!(remembered(&rig.store), None);
        assert_eq!(
            rig.files(),
            [
                format!("{RECORDING}.json"),
                SETTING_FILE.into(),
                STATUS_FILE.into()
            ]
        );
        let log = format!("{:?}", rig.host.reports()).to_lowercase();
        for part in NAME_PARTS {
            assert!(!log.contains(part), "{log}");
        }

        // Without a known name nobody is marked.
        let mut rig = Rig::new();
        rig.next(vec![people(&UNMARKED)]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(
            rig.file(RECORDING).unwrap(),
            ALEX_AND_SAM.replace(r#","self":true"#, "")
        );
        assert!(!rig.host.reports().pop().unwrap().guessed);
    }

    #[test]
    fn two_people_with_a_known_name_mark_nobody() {
        // Two entries carry the known name: the roster keeps one entry for each spelling, and a
        // known name is compared without case and spacing.
        let mut rig = Rig::with_account(|| Some("Alex Example".to_owned()));
        rig.next(vec![people(&[
            ("Alex Example", false),
            ("ALEX EXAMPLE", false),
            ("Robin Sample", false),
        ])]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        let file = rig.file(RECORDING).unwrap();
        assert!(
            file.contains(r#""id":"p3""#) && !file.contains("\"self\""),
            "{file}"
        );
        assert!(!rig.host.reports().pop().unwrap().guessed);

        // The same when two known names are in the call: the account's and a remembered one.
        rig.store.set_self_names(&[name("Robin Sample")]).unwrap();
        rig.restart();
        rig.service = Service::with_account(
            rig.store.clone(),
            FakeWindow::new(&rig.window),
            Pace::default(),
            || Some("Alex Example".to_owned()),
        );
        rig.next(vec![people(&UNMARKED)]);
        rig.host.record(NEXT_RECORDING, STEREO, 1_000);
        rig.tick();
        let file = rig.file(NEXT_RECORDING).unwrap();
        assert!(
            file.contains(r#""id":"p2""#) && !file.contains("\"self\""),
            "{file}"
        );
    }

    #[test]
    fn one_name_on_two_rows_is_one_person_for_the_guess() {
        // The user's account is in the call on two devices: two rows, one name, one person.
        let mut rig = Rig::with_account(|| Some("Alex Example".to_owned()));
        rig.next(vec![people(&[
            ("Alex Example", false),
            ("Alex Example", false),
            ("Robin Sample", false),
        ])]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));
        assert!(rig.host.reports().pop().unwrap().guessed);
    }

    #[test]
    fn a_mark_from_the_app_replaces_the_guess() {
        let mut rig = Rig::with_account(|| Some("Alex Example".to_owned()));
        rig.next(vec![people(&UNMARKED)]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));

        // The People panel opens: the app says the user is the other person.
        rig.next(vec![people(&[
            ("Alex Example", false),
            ("Robin Sample", true),
        ])]);
        rig.tick();
        let marked = r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Alex Example"},{"id":"p2","name":"Robin Sample","self":true}],"truncated":false}"#;
        assert_eq!(rig.file(RECORDING).as_deref(), Some(marked));
        let report = rig.host.reports().pop().unwrap();
        assert!(report.saved && !report.guessed);
        assert_eq!(
            remembered(&rig.store).as_deref(),
            Some(r#"{"names":["Robin Sample"]}"#)
        );

        // The panel closes again: the mark stays, and the guess does not come back.
        rig.next(vec![people(&UNMARKED)]);
        rig.tick();
        assert_eq!(rig.file(RECORDING).as_deref(), Some(marked));
    }

    #[test]
    fn a_recording_with_a_mark_takes_no_guess_even_when_the_mark_is_withdrawn() {
        let mut rig = Rig::with_account(|| Some("Alex Example".to_owned()));
        rig.next(vec![people(&[
            ("Alex Example", false),
            ("Robin Sample", true),
        ])]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        // A second, different person carries the mark: the roster trusts neither from now on.
        rig.next(vec![people(&[
            ("Alex Example", true),
            ("Robin Sample", false),
        ])]);
        rig.tick();
        let file = rig.file(RECORDING).unwrap();
        assert!(!file.contains("\"self\""), "{file}");
        assert!(!rig.host.reports().pop().unwrap().guessed);
    }

    #[test]
    fn a_withdrawn_mark_is_not_remembered() {
        let first = people(&[("Alex Example", false), ("Robin Sample", true)]);
        let second = people(&[("Alex Example", true), ("Robin Sample", false)]);
        let mut rig = Rig::new();
        rig.next(vec![first.clone()]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(names(&rig.store), ["Robin Sample"]);
        // A second person carries the mark: the name this recording taught is forgotten, and
        // the second name is not learned.
        rig.next(vec![second.clone()]);
        rig.tick();
        assert_eq!(remembered(&rig.store).as_deref(), Some(r#"{"names":[]}"#));
        rig.tick();
        assert!(names(&rig.store).is_empty());

        // A name that was known before this recording stays known.
        rig.store.set_self_names(&[name("Robin Sample")]).unwrap();
        rig.restart();
        rig.next(vec![first.clone(), second.clone()]);
        rig.host.record(NEXT_RECORDING, STEREO, 1_000);
        rig.tick();
        rig.tick();
        let file = rig.file(NEXT_RECORDING).unwrap();
        assert!(!file.contains("\"self\""), "{file}");
        assert_eq!(names(&rig.store), ["Robin Sample"]);

        // With as many names as are kept, the mark pushes the oldest one out. When the mark is
        // withdrawn that name comes back, in its place.
        let full: Vec<Name> = (0..MAX_SELF_NAMES)
            .map(|number| name(&format!("Name {number}")))
            .collect();
        rig.store.set_self_names(&full).unwrap();
        rig.restart();
        rig.next(vec![first, second]);
        rig.host.record("recording-3", STEREO, 1_000);
        rig.tick();
        let taught = names(&rig.store);
        assert_eq!(taught.len(), MAX_SELF_NAMES);
        assert_eq!(taught[0], "Robin Sample");
        assert!(!taught.contains(&"Name 7".to_owned()));
        rig.tick();
        assert_eq!(rig.store.self_names(), full);
    }

    #[test]
    fn a_name_marked_in_one_recording_is_known_in_the_next() {
        let mut rig = Rig::new();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(
            remembered(&rig.store).as_deref(),
            Some(r#"{"names":["Alex Example"]}"#)
        );

        // The next recording shows tiles only: nobody is marked, but one name is known.
        let tiles = people(&[("Test Guest A", false), ("alex example", false)]);
        let guessed = r#"{"v":1,"source":"call_window","app":"google-meet","people":[{"id":"p1","name":"Test Guest A"},{"id":"p2","name":"alex example","self":true}],"truncated":false}"#;
        rig.next(vec![tiles.clone()]);
        rig.host.record(NEXT_RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(rig.file(NEXT_RECORDING).as_deref(), Some(guessed));
        assert!(rig.host.reports().pop().unwrap().guessed);
        // A guess does not change what is remembered.
        assert_eq!(
            remembered(&rig.store).as_deref(),
            Some(r#"{"names":["Alex Example"]}"#)
        );

        // And after the app was started again.
        rig.store.clear(NEXT_RECORDING).unwrap();
        rig.restart();
        rig.next(vec![tiles]);
        rig.tick();
        assert_eq!(rig.file(NEXT_RECORDING).as_deref(), Some(guessed));
    }

    #[test]
    fn the_remembered_names_never_grow_past_the_cap() {
        let mut rig = Rig::new();
        for number in 0..12 {
            let marked = format!("Person {number}");
            rig.next(vec![people(&[
                (marked.as_str(), true),
                ("Robin Sample", false),
            ])]);
            rig.host
                .record(&format!("recording-{number}"), STEREO, 1_000);
            rig.tick();
        }
        let newest_first: Vec<String> = (4..12)
            .rev()
            .map(|number| format!("Person {number}"))
            .collect();
        assert_eq!(names(&rig.store), newest_first);
        assert_eq!(newest_first.len(), MAX_SELF_NAMES);

        // A name that is known already moves to the front; nothing is added.
        rig.next(vec![people(&[("PERSON 6", true)])]);
        rig.host.record("recording-12", STEREO, 1_000);
        rig.tick();
        let mut moved = newest_first.clone();
        moved.retain(|known| known != "Person 6");
        moved.insert(0, "PERSON 6".into());
        assert_eq!(names(&rig.store), moved);

        // The store itself keeps and gives at most the cap.
        let many: Vec<Name> = (0..12)
            .map(|number| name(&format!("Name {number}")))
            .collect();
        rig.store.set_self_names(&many).unwrap();
        assert_eq!(rig.store.self_names(), many[..MAX_SELF_NAMES]);
        let all: Vec<String> = (0..12).map(|number| format!("\"Name {number}\"")).collect();
        let path = rig.store.dir().join(SELF_NAMES_FILE);
        fs::write(&path, format!("{{\"names\":[{}]}}", all.join(","))).unwrap();
        assert_eq!(rig.store.self_names(), many[..MAX_SELF_NAMES]);
        // A name is cleaned and cut like every other name.
        let long = "x".repeat(200);
        fs::write(&path, format!("{{\"names\":[\" {long}\\n\"]}}")).unwrap();
        assert_eq!(
            names(&rig.store),
            ["x".repeat(crate::names::MAX_NAME_CHARS)]
        );
    }

    #[test]
    fn a_bad_or_missing_file_of_remembered_names_is_ignored() {
        let mut rig = Rig::new();
        assert!(rig.store.self_names().is_empty());
        let path = rig.store.dir().join(SELF_NAMES_FILE);
        let large = format!("{{\"names\":[\"Alex Example\"]}}{}", " ".repeat(70_000));
        for bad in [
            "",
            "[]",
            "[\"Alex Example\"]",
            "{\"names\":\"Alex Example\"}",
            "{\"names\":[\"Alex Example\",\" \"]}",
            "{\"names\":[\"Alex Example\"],\"more\":1}",
            "{\"names\":[\"Alex Example\"",
            large.as_str(),
        ] {
            fs::write(&path, bad).unwrap();
            assert!(
                rig.store.self_names().is_empty(),
                "{}",
                &bad[..bad.len().min(40)]
            );
        }
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(rig.store.self_names().is_empty());

        // The service reads on, without a guess, and the next mark from an app replaces the file.
        rig.next(vec![people(&UNMARKED)]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(
            rig.file(RECORDING).unwrap(),
            ALEX_AND_SAM.replace(r#","self":true"#, "")
        );
        rig.next(vec![people(&[
            ("Alex Example", true),
            ("Robin Sample", false),
        ])]);
        rig.tick();
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));
        assert_eq!(names(&rig.store), ["Alex Example"]);
    }

    #[test]
    fn a_failed_save_of_the_remembered_names_is_tried_again() {
        let mut rig = Rig::new();
        // A folder where the file belongs: the save cannot replace it.
        let blocked = rig.store.dir().join(SELF_NAMES_FILE);
        fs::create_dir_all(blocked.join("in-the-way")).unwrap();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        let report = rig.host.reports().pop().unwrap();
        assert!(report.saved && report.error.unwrap().starts_with("call_names_io: "));
        assert_eq!(rig.file(RECORDING).as_deref(), Some(ALEX_AND_SAM));

        fs::remove_dir_all(&blocked).unwrap();
        rig.tick();
        assert_eq!(names(&rig.store), ["Alex Example"]);
        assert_eq!(rig.host.reports().pop().unwrap().error, None);
    }

    #[test]
    fn the_account_name_is_read_once_and_only_for_a_reading() {
        static READS: AtomicU64 = AtomicU64::new(0);
        fn account() -> Option<String> {
            READS.fetch_add(1, Ordering::SeqCst);
            Some("Alex Example".to_owned())
        }
        let mut rig = Rig::with_account(account);
        rig.next(vec![people(&UNMARKED)]);
        // Off, mono, paused, no permission: the account is not asked for its name.
        rig.store.set_enabled(false).unwrap();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        rig.store.set_enabled(true).unwrap();
        rig.host.record(RECORDING, 1, 1_000);
        rig.tick();
        rig.host.pause();
        rig.tick();
        rig.window.lock().unwrap().permission = Permission::Missing;
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(READS.load(Ordering::SeqCst), 0);

        rig.window.lock().unwrap().permission = Permission::Granted;
        for _ in 0..3 {
            rig.tick();
        }
        rig.host.record(NEXT_RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(READS.load(Ordering::SeqCst), 1);
        assert_eq!(rig.file(NEXT_RECORDING).as_deref(), Some(ALEX_AND_SAM));
    }

    #[test]
    fn the_full_name_comes_from_the_account() {
        assert_eq!(full_name("Alex Example"), Some(name("Alex Example")));
        assert_eq!(full_name(" Alex\tExample "), Some(name("Alex Example")));
        assert_eq!(full_name(""), None);
        assert_eq!(full_name(" "), None);
        // Only macOS keeps nothing but the name in the field.
        let with_more = full_name("Alex Example,Room 1,555-0100").unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(with_more, name("Alex Example,Room 1,555-0100"));
        } else {
            assert_eq!(with_more, name("Alex Example"));
            assert_eq!(full_name(",,,"), None);
        }
        // Whatever this computer's account holds, reading it is safe and gives text or nothing.
        let _ = account_gecos().as_deref().and_then(full_name);
        assert_eq!(account_gecos(), account_gecos());
    }

    #[test]
    fn names_compare_without_the_case_of_letters() {
        assert!(same_name(
            &name("Zoë O'Brien-Núñez"),
            &name("ZOË o'brien-NÚÑEZ")
        ));
        assert!(same_name(&name("山田 太郎"), &name("山田 太郎")));
        assert!(!same_name(&name("Alex Example"), &name("Alex Exampl")));
        assert!(!same_name(&name("Alex Example"), &name("AlexExample")));
    }

    /// The status file as `(outcome, apps, people, self_known, self_guessed, tick_ms)`, after a
    /// check that it holds these and the time, and no part of a name.
    fn status(store: &Store) -> (String, u64, u64, bool, bool, u64) {
        let text = fs::read_to_string(store.dir().join(STATUS_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "apps",
                "at",
                "outcome",
                "people",
                "self_guessed",
                "self_known",
                "tick_ms",
                "v"
            ],
            "{text}"
        );
        assert_eq!(value["v"], 1, "{text}");
        let at = value["at"].as_str().unwrap().as_bytes();
        assert!(at.len() == 20 && at[10] == b'T' && at[19] == b'Z', "{text}");
        let lower = text.to_lowercase();
        for part in NAME_PARTS {
            assert!(!lower.contains(part), "{text}");
        }
        (
            value["outcome"].as_str().unwrap().to_owned(),
            value["apps"].as_u64().unwrap(),
            value["people"].as_u64().unwrap(),
            value["self_known"].as_bool().unwrap(),
            value["self_guessed"].as_bool().unwrap(),
            value["tick_ms"].as_u64().unwrap(),
        )
    }

    #[test]
    fn the_status_file_says_what_the_reader_last_did() {
        let mut rig = Rig::new();
        assert!(!rig.store.dir().join(STATUS_FILE).exists());
        rig.tick();
        assert_eq!(
            status(&rig.store),
            ("not_live".into(), 0, 0, false, false, 0)
        );
        rig.host.record(RECORDING, 1, 1_000);
        rig.tick();
        assert_eq!(status(&rig.store).0, "mono");
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.store.set_enabled(false).unwrap();
        rig.tick();
        assert_eq!(status(&rig.store).0, "setting_off");
        rig.store.set_enabled(true).unwrap();
        rig.window.lock().unwrap().permission = Permission::Missing;
        rig.tick();
        assert_eq!(status(&rig.store).0, "no_permission");
        rig.window.lock().unwrap().permission = Permission::Unsupported;
        rig.tick();
        assert_eq!(status(&rig.store).0, "unsupported");
        assert_eq!(rig.reads(), 0);

        // From here on the window is read. First no meeting app runs.
        rig.window.lock().unwrap().permission = Permission::Granted;
        rig.host.0.lock().unwrap().no_apps = true;
        rig.next(vec![Err(NoNames::Skip(Skip::NoTarget))]);
        rig.tick();
        assert_eq!(
            status(&rig.store),
            ("no_apps".into(), 0, 0, false, false, 3)
        );
        // A browser runs, without a call.
        rig.host.0.lock().unwrap().no_apps = false;
        rig.tick();
        assert_eq!(
            status(&rig.store),
            ("no_target".into(), 1, 0, false, false, 3)
        );
        rig.next(vec![Err(NoNames::Skip(Skip::NotInCall))]);
        rig.tick();
        assert_eq!(status(&rig.store).0, "not_in_call");
        rig.next(vec![Err(NoNames::Skip(Skip::Discarded(Discard::Time)))]);
        rig.tick();
        assert_eq!(status(&rig.store).0, "discarded:Time");
        // A call with two people, and nobody is known to be the user.
        rig.next(vec![people(&UNMARKED)]);
        rig.tick();
        assert_eq!(status(&rig.store), ("names".into(), 1, 2, false, false, 3));
        rig.host.pause();
        rig.tick();
        assert_eq!(
            status(&rig.store),
            ("not_live".into(), 0, 0, false, false, 0)
        );

        // The app marked the user.
        let mut rig = Rig::new();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(status(&rig.store), ("names".into(), 1, 2, true, false, 3));
        // The user is a guess from a known name.
        let mut rig = Rig::with_account(|| Some("Alex Example".to_owned()));
        rig.next(vec![people(&UNMARKED)]);
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(status(&rig.store), ("names".into(), 1, 2, true, true, 3));
    }

    #[cfg(unix)]
    #[test]
    fn the_status_file_is_written_on_a_change_and_every_30_s_of_reading() {
        use std::os::unix::fs::MetadataExt;
        // A write puts a new file in the place of the old one, so its number tells one write
        // from the next.
        fn written(rig: &Rig) -> u64 {
            fs::metadata(rig.store.dir().join(STATUS_FILE))
                .unwrap()
                .ino()
        }
        let mut rig = Rig::new();
        // Nothing is live: one status file, however long that lasts.
        rig.tick();
        let idle = written(&rig);
        for _ in 0..100 {
            rig.tick();
        }
        assert_eq!(written(&rig), idle);

        // A call is read: a status file at once, then one for every 30 s of ticks.
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        let first = written(&rig);
        assert_ne!(first, idle);
        // A third person joins at once. The kind of outcome stays, so the status file waits.
        rig.next(vec![people(&[
            ("Alex Example", true),
            ("Robin Sample", false),
            ("Test Guest A", false),
        ])]);
        let ticks = STATUS_INTERVAL.as_secs() / READING_INTERVAL.as_secs();
        for _ in 1..ticks {
            rig.tick();
            assert_eq!(written(&rig), first);
        }
        assert_eq!(status(&rig.store).2, 2);
        rig.tick();
        assert_ne!(written(&rig), first);
        assert_eq!(status(&rig.store), ("names".into(), 1, 3, true, false, 3));
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_and_its_files_are_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        fn mode(path: &Path) -> u32 {
            fs::metadata(path).unwrap().permissions().mode() & 0o777
        }
        let mut rig = Rig::new();
        rig.host.record(RECORDING, STEREO, 1_000);
        rig.tick();
        assert_eq!(mode(rig.store.dir()), 0o700);
        let all = rig.files();
        assert_eq!(
            all,
            [
                format!("{RECORDING}.json"),
                SELF_NAMES_FILE.into(),
                SETTING_FILE.into(),
                STATUS_FILE.into()
            ]
        );
        for file in all {
            assert_eq!(mode(&rig.store.dir().join(&file)), 0o600, "{file}");
        }

        // A folder that an earlier build made for everybody to read is the user's alone once the
        // service has started.
        fs::set_permissions(rig.store.dir(), fs::Permissions::from_mode(0o755)).unwrap();
        rig.restart();
        assert_eq!(mode(rig.store.dir()), 0o700);
    }

    #[test]
    fn the_service_tidies_the_folder_when_it_starts() {
        let folder = Folder::new();
        let store = folder.store();
        store.set_enabled(true).unwrap();
        let participants = CallParticipants::from_json(ALEX_AND_SAM).unwrap();
        store.write(RECORDING, &participants).unwrap();
        store.write(NEXT_RECORDING, &participants).unwrap();
        store.set_self_names(&[name("Alex Example")]).unwrap();
        let report = Report::of("names");
        store.set_status(&report, SystemTime::now()).unwrap();
        let dir = store.dir().to_owned();
        // What an interrupted write left behind, and a file that is not the store's.
        fs::write(
            dir.join(format!("{NEXT_RECORDING}.json.77.0.tmp")),
            ALEX_AND_SAM,
        )
        .unwrap();
        fs::write(dir.join("other.txt"), "kept").unwrap();
        // All but one names file were last written long ago.
        let long_ago = SystemTime::now() - MAX_NAMES_AGE - Duration::from_secs(60);
        for file in [
            format!("{RECORDING}.json"),
            SELF_NAMES_FILE.into(),
            SETTING_FILE.into(),
            STATUS_FILE.into(),
            "other.txt".into(),
        ] {
            fs::OpenOptions::new()
                .write(true)
                .open(dir.join(file))
                .unwrap()
                .set_modified(long_ago)
                .unwrap();
        }

        let window = WindowState::new();
        let _service = Service::with_account(
            store.clone(),
            FakeWindow::new(&window),
            Pace::default(),
            || None,
        );
        assert_eq!(
            files(&store),
            [
                format!("{NEXT_RECORDING}.json"),
                SELF_NAMES_FILE.into(),
                SETTING_FILE.into(),
                STATUS_FILE.into(),
                "other.txt".into()
            ]
        );
        assert_eq!(store.read(RECORDING), Ok(None));
        assert_eq!(names(&store), ["Alex Example"]);
        assert!(store.enabled());

        // The age counts from the last write, and the limit itself is not too old.
        let written = fs::metadata(dir.join(format!("{NEXT_RECORDING}.json")))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(store.tidy(written + MAX_NAMES_AGE), 0);
        assert_eq!(store.read(NEXT_RECORDING), Ok(Some(participants)));
        assert_eq!(
            store.tidy(written + MAX_NAMES_AGE + Duration::from_secs(1)),
            1
        );
        assert_eq!(store.read(NEXT_RECORDING), Ok(None));
        // A folder that is not there is not made.
        assert_eq!(Folder::new().store().tidy(SystemTime::now()), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_write_puts_a_whole_new_file_in_place() {
        use std::os::unix::fs::MetadataExt;
        let folder = Folder::new();
        let store = folder.store();
        let small = CallParticipants::from_json(ALEX_AND_SAM).unwrap();
        let fifty: Vec<String> = (1..=50)
            .map(|number| {
                format!(
                    r#"{{"id":"p{number}","name":"Person {number} {}"}}"#,
                    "x".repeat(60)
                )
            })
            .collect();
        let large = CallParticipants::from_json(&format!(
            r#"{{"v":1,"source":"call_window","app":"zoom","people":[{}],"truncated":false}}"#,
            fifty.join(",")
        ))
        .unwrap();
        let path = store.dir().join(format!("{RECORDING}.json"));
        store.write(RECORDING, &small).unwrap();
        let first = fs::metadata(&path).unwrap().ino();
        store.write(RECORDING, &large).unwrap();
        // Another file is in the place of the first one: the first was never written into.
        assert_ne!(fs::metadata(&path).unwrap().ino(), first);

        // While one thread writes, a reader sees one whole file or the other: never a part of
        // one, and never no file.
        let whole = [small.to_json(), large.to_json()];
        let writer = {
            let store = store.clone();
            thread::spawn(move || {
                for round in 0..60 {
                    let people = if round % 2 == 0 { &small } else { &large };
                    store.write(RECORDING, people).unwrap();
                }
            })
        };
        let mut reads = 0;
        while !writer.is_finished() {
            let seen = fs::read_to_string(&path).unwrap();
            assert!(
                whole.contains(&seen),
                "a part of a file: {} bytes",
                seen.len()
            );
            reads += 1;
        }
        writer.join().unwrap();
        assert!(reads > 0);
        // Nothing temporary is left.
        assert_eq!(files(&store), [format!("{RECORDING}.json")]);
    }

    #[test]
    fn the_time_in_the_status_file_is_utc() {
        let at = |seconds: u64| utc(UNIX_EPOCH + Duration::from_secs(seconds));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(946_684_799), "1999-12-31T23:59:59Z");
        assert_eq!(at(951_782_399), "2000-02-28T23:59:59Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(951_868_800), "2000-03-01T00:00:00Z");
        assert_eq!(at(1_709_251_199), "2024-02-29T23:59:59Z");
        assert_eq!(at(1_735_689_599), "2024-12-31T23:59:59Z");
        assert_eq!(at(1_795_109_103), "2026-11-19T17:25:03Z");
        // 2100 is not a leap year.
        assert_eq!(at(4_102_444_800), "2100-01-01T00:00:00Z");
        assert_eq!(at(4_107_542_399), "2100-02-28T23:59:59Z");
        assert_eq!(at(4_107_542_400), "2100-03-01T00:00:00Z");
        // A clock set before 1970 gives the first time there is, not a panic.
        assert_eq!(
            utc(UNIX_EPOCH - Duration::from_secs(5)),
            "1970-01-01T00:00:00Z"
        );
    }

    /// Long enough for a machine that is busy with other work.
    const PATIENCE: Duration = Duration::from_secs(60);

    fn wait_for(what: impl Fn() -> bool) {
        let started = std::time::Instant::now();
        while started.elapsed() < PATIENCE {
            if what() {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("the reader's thread did not get there in {PATIENCE:?}");
    }

    #[test]
    fn the_thread_makes_uses_stops_and_drops_the_window_itself() {
        let folder = Folder::new();
        let store = folder.store();
        store.set_enabled(true).unwrap();
        let host = FakeHost::default();
        host.record(RECORDING, STEREO, 1_000);
        let window = WindowState::new();
        let made = window.clone();
        let worker = spawn_with(store.clone(), host.clone(), FAST, move || {
            assert_eq!(thread::current().name(), Some(THREAD_NAME));
            FakeWindow::new(&made)
        })
        .unwrap();
        wait_for(|| {
            store.read(RECORDING) == Ok(Some(CallParticipants::from_json(ALEX_AND_SAM).unwrap()))
        });
        assert!(worker.stop(PATIENCE));

        let state = window.lock().unwrap();
        let reader = state.threads[0].1;
        assert_ne!(reader, thread::current().id());
        assert!(state.threads.iter().all(|(_, thread)| *thread == reader));
        let steps: Vec<&str> = state.threads.iter().map(|(what, _)| *what).collect();
        assert_eq!(steps[..2], ["made", "read"]);
        assert_eq!(steps[steps.len() - 2..], ["stop", "dropped"]);
        assert_eq!(state.stops, 1);
        assert!(host.0.lock().unwrap().scopes > 1);
        // Stopping again is harmless.
        assert!(worker.stop(Duration::ZERO));
    }

    #[test]
    fn stop_wakes_a_waiting_thread() {
        let folder = Folder::new();
        let window = WindowState::new();
        let made = window.clone();
        let slow = Pace {
            reading: Duration::from_secs(3_600),
            idle: Duration::from_secs(3_600),
        };
        let host = FakeHost::default();
        let worker = spawn_with(folder.store(), host.clone(), slow, move || {
            FakeWindow::new(&made)
        })
        .unwrap();
        wait_for(|| host.outcomes() == ["not_live"]);
        assert!(worker.stop(PATIENCE));
        let state = window.lock().unwrap();
        // Nothing was read, so there is nothing to put back.
        assert_eq!((state.reads.len(), state.stops), (0, 0));
        assert_eq!(state.threads.last().unwrap().0, "dropped");
    }

    #[test]
    fn the_real_reader_runs_idle_and_stops() {
        let folder = Folder::new();
        let host = FakeHost::default();
        let worker = spawn(folder.store(), host.clone()).unwrap();
        wait_for(|| host.outcomes() == ["not_live"]);
        assert!(worker.stop(PATIENCE));
        assert!(host.asked().is_empty());
        assert_eq!(files(&folder.store()), [STATUS_FILE]);
    }
}
