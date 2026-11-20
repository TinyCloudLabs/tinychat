//! What the watcher last did, in `<app data>/voice-notes/call-prompt/_status.json`, beside the
//! names feature's own status file. Release builds have no log, so this file is how one sees on
//! a Mac what the watcher does.
//!
//! It holds kinds, states and times only, never a bundle id or a name:
//!
//! ```json
//! {"v":1,"at":"2026-11-20T01:23:45Z","enabled":true,"phase":"offered","stage":"offered",
//!  "kind":"native","gate":"open","pass":"followed","pass_ms":0.4,"scan_ms":95.2,
//!  "last_start":{"claimed_after_ms":850,"timed_out":false,"stopped_from_tile":false},
//!  "error":null}
//! ```
//!
//! - `kind`: the rule of the call's app, `native` or `browser`, or null.
//! - `gate`: `open` (an input device is in use), `closed`, `failed` (it could not be read) or
//!   `off` (the setting is off).
//! - `pass`: the last look's pass, `gate` (nothing else read), `followed` (only the call apps'
//!   process objects) or `full` (every process object); `pass_ms`: how long it took.
//! - `scan_ms`: how long the last full scan took.
//! - `phase`: `recording` while the tile shows the recording it started.
//! - `last_start`: the last "Start" on the tile: how long after it the web app claimed the start
//!   request (null until it does), whether the 8 s wait for the recording ran out, and whether
//!   "Stop" on the tile asked to stop that recording.
//!
//! It is written at most once per [`STATUS_INTERVAL`], and at once when the phase or the setting
//! changes. Each write replaces the whole file (a temporary file, synced, then renamed), mode 0600
//! in a folder of mode 0700.

use crate::session::Phase;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The status file's name.
pub const STATUS_FILE: &str = "_status.json";
/// The least time between two writes while the phase and the setting stay the same.
pub const STATUS_INTERVAL: Duration = Duration::from_secs(30);

/// The gate, as the status file says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GateState {
    Open,
    Closed,
    Failed,
    Off,
}

/// The last "Start" on the tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LastStart {
    /// How long after the press the web app claimed the start request; `None` until it does.
    pub claimed_after_ms: Option<u64>,
    /// The wait for the recording to capture ran out, and the main window was brought forward.
    pub timed_out: bool,
    /// "Stop" on the tile asked to stop that recording.
    pub stopped_from_tile: bool,
}

/// One status. No field can hold a bundle id or a name.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    pub enabled: bool,
    pub phase: Phase,
    pub stage: &'static str,
    pub kind: Option<&'static str>,
    pub gate: GateState,
    /// The last pass: `gate`, `followed` or `full`, and how long it took.
    pub pass: &'static str,
    pub pass_ms: f64,
    /// How long the last full scan took.
    pub scan_ms: Option<f64>,
    pub last_start: Option<LastStart>,
    pub error: Option<&'static str>,
}

#[derive(Serialize)]
struct File1<'a> {
    v: u32,
    at: String,
    #[serde(flatten)]
    status: &'a Status,
}

/// The status file and when it was last written.
#[derive(Debug)]
pub struct StatusFile {
    path: PathBuf,
    last: Option<(Duration, Phase, bool)>,
}

impl StatusFile {
    /// `<dir>/_status.json`.
    pub fn new(dir: &Path) -> Self {
        StatusFile {
            path: dir.join(STATUS_FILE),
            last: None,
        }
    }

    /// `<app_data>/voice-notes/call-prompt/_status.json`.
    pub fn in_app_data(app_data: &Path) -> Self {
        Self::new(&app_data.join("voice-notes").join("call-prompt"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Write `status` when the phase or the setting changed since the last write, or when the
    /// last write is [`STATUS_INTERVAL`] old on the watcher's clock (`now`). True when written. A
    /// failed write is tried again on the next call.
    pub fn offer(&mut self, now: Duration, status: &Status) -> io::Result<bool> {
        let due = match self.last {
            None => true,
            Some((at, phase, enabled)) => {
                phase != status.phase
                    || enabled != status.enabled
                    || now.saturating_sub(at) >= STATUS_INTERVAL
            }
        };
        if !due {
            return Ok(false);
        }
        let bytes = serde_json::to_vec(&File1 {
            v: 1,
            at: utc(SystemTime::now()),
            status,
        })
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        write_atomic(&self.path, &bytes)?;
        self.last = Some((now, status.phase, status.enabled));
        Ok(true)
    }
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

/// A new file for the user alone (mode 0600 on unix). Nothing may be at `path`.
fn create_private(path: &Path) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

/// Write a whole file so that a reader sees the old content or the new one, never a part: a
/// temporary file, synced, then renamed over the target (as the names feature does).
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
        File::open(dir)?.sync_all()
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates() {
        assert_eq!(utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        let leap_day = UNIX_EPOCH + Duration::from_secs(1_709_164_800 + 3_723);
        assert_eq!(utc(leap_day), "2024-02-29T01:02:03Z");
        let late = UNIX_EPOCH + Duration::from_secs(1_795_219_199);
        assert_eq!(utc(late), "2026-11-20T23:59:59Z");
    }
}
