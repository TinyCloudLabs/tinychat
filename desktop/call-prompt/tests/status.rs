//! The status file on its own: when it is written, its shape and its mode.

use call_prompt::session::Phase;
use call_prompt::status::{GateState, LastStart, Status, StatusFile, STATUS_INTERVAL};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// A folder of its own for one test, removed afterwards.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "call-prompt-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        Folder(dir)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn status(phase: Phase) -> Status {
    Status {
        enabled: true,
        phase,
        stage: "offered",
        kind: Some("native"),
        gate: GateState::Open,
        pass: "followed",
        pass_ms: 0.4,
        scan_ms: Some(12.5),
        last_start: Some(LastStart {
            claimed_after_ms: Some(850),
            timed_out: false,
            stopped_from_tile: false,
        }),
        error: None,
    }
}

const T0: Duration = Duration::from_secs(100);

#[test]
fn it_is_written_on_a_change_and_at_most_every_30_s_otherwise() {
    let folder = Folder::new();
    let mut file = StatusFile::new(&folder.0);
    assert!(file.offer(T0, &status(Phase::Offered)).unwrap());
    let mut now = T0;
    while now < T0 + STATUS_INTERVAL - Duration::from_secs(2) {
        now += Duration::from_secs(2);
        assert!(
            !file.offer(now, &status(Phase::Offered)).unwrap(),
            "at {now:?}"
        );
    }
    assert!(file
        .offer(T0 + STATUS_INTERVAL, &status(Phase::Offered))
        .unwrap());
    assert!(file
        .offer(
            T0 + STATUS_INTERVAL + Duration::from_secs(2),
            &status(Phase::Starting)
        )
        .unwrap());
    let mut off = status(Phase::Starting);
    off.enabled = false;
    assert!(file
        .offer(T0 + STATUS_INTERVAL + Duration::from_secs(3), &off)
        .unwrap());
}

#[test]
fn it_has_kinds_and_times_only() {
    let folder = Folder::new();
    let mut file = StatusFile::new(&folder.0);
    file.offer(T0, &status(Phase::Offered)).unwrap();
    let text = std::fs::read_to_string(file.path()).unwrap();
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
            "at",
            "enabled",
            "error",
            "gate",
            "kind",
            "last_start",
            "pass",
            "pass_ms",
            "phase",
            "scan_ms",
            "stage",
            "v"
        ]
    );
    assert_eq!(value["v"], 1);
    assert_eq!(value["phase"], "offered");
    assert_eq!(value["kind"], "native");
    assert_eq!(value["gate"], "open");
    assert_eq!(value["scan_ms"], 12.5);
    assert_eq!(value["pass"], "followed");
    assert_eq!(value["pass_ms"], 0.4);
    assert_eq!(
        value["last_start"],
        serde_json::json!({
            "claimed_after_ms": 850,
            "timed_out": false,
            "stopped_from_tile": false
        })
    );
    let at = value["at"].as_str().unwrap().as_bytes();
    assert_eq!(at.len(), 20);
    assert_eq!((at[4], at[10], at[19]), (b'-', b'T', b'Z'));
}

#[test]
fn it_is_the_users_alone_and_leaves_no_temporary_file() {
    let folder = Folder::new();
    let dir = folder.0.join("voice-notes").join("call-prompt");
    let mut file = StatusFile::in_app_data(&folder.0);
    assert_eq!(file.path(), dir.join("_status.json"));
    file.offer(T0, &status(Phase::Hidden)).unwrap();
    file.offer(T0 + Duration::from_secs(1), &status(Phase::Offered))
        .unwrap();
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, ["_status.json"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(file.path()), 0o600);
        assert_eq!(mode(&dir), 0o700);
    }
}

#[test]
fn a_failed_write_is_tried_again() {
    let folder = Folder::new();
    // A file where the folder should be: the write fails.
    std::fs::write(&folder.0, b"in the way").unwrap();
    let mut file = StatusFile::new(&folder.0);
    assert!(file.offer(T0, &status(Phase::Offered)).is_err());
    std::fs::remove_file(&folder.0).unwrap();
    assert!(file
        .offer(T0 + Duration::from_secs(2), &status(Phase::Offered))
        .unwrap());
}
