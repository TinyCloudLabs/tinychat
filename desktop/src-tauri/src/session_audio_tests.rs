use super::*;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::PathBuf;
use std::sync::{Arc, Barrier};

const ID: &str = "e8342e15-48f7-42bc-8847-3c92046c6712";
const OTHER: &str = "ccadbd56-643d-4919-aa16-ac6a5314d58e";

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    fs::create_dir(&sessions).unwrap();
    (root, sessions)
}

fn recording(sessions: &Path, id: &str, name: &str) {
    fs::create_dir_all(sessions.join(id)).unwrap();
    fs::write(sessions.join(id).join(name), b"sound").unwrap();
}

fn code<T>(result: Result<T, Rejection>) -> &'static str {
    result.err().unwrap().code
}

#[test]
fn selects_plugin_preference_for_both_session_id_forms() {
    let (_root, sessions) = fixture();
    for id in [ID.to_owned(), format!("cloud-{ID}")] {
        recording(&sessions, &id, "audio.ogg");
        assert_eq!(
            open_session_recording(&sessions, &id).unwrap().format,
            AudioFormat::Ogg
        );
        fs::write(sessions.join(&id).join("audio.wav"), b"wav").unwrap();
        assert_eq!(
            open_session_recording(&sessions, &id).unwrap().format,
            AudioFormat::Wav
        );
        fs::write(sessions.join(&id).join("audio.mp3"), b"mp3").unwrap();
        assert_eq!(
            open_session_recording(&sessions, &id).unwrap().format,
            AudioFormat::Mp3
        );
    }
}

#[test]
fn rejects_bad_ids_missing_audio_and_symlinks_at_every_level() {
    let (root, sessions) = fixture();
    for id in [
        "",
        "..",
        "../x",
        "a/b",
        "/tmp/x",
        "a\0b",
        "a".repeat(65).as_str(),
        "ñ",
    ] {
        assert_eq!(
            code(open_session_recording(&sessions, id)),
            "recording_unavailable"
        );
    }
    assert_eq!(
        code(open_session_recording(&sessions, ID)),
        "recording_unavailable"
    );
    fs::create_dir(sessions.join(ID)).unwrap();
    assert_eq!(
        code(open_session_recording(&sessions, ID)),
        "recording_unavailable"
    );
    fs::write(sessions.join(ID).join("audio.wav"), b"sound").unwrap();
    for name in AUDIO_FILES {
        let candidate = sessions.join(ID).join(name);
        if name != "audio.wav" {
            symlink("audio.wav", &candidate).unwrap();
        } else {
            fs::rename(&candidate, sessions.join(ID).join("original.wav")).unwrap();
            symlink("original.wav", &candidate).unwrap();
        }
        assert_eq!(
            code(open_session_recording(&sessions, ID)),
            "recording_unavailable"
        );
        fs::remove_file(candidate).unwrap();
        if name == "audio.wav" {
            fs::rename(
                sessions.join(ID).join("original.wav"),
                sessions.join(ID).join("audio.wav"),
            )
            .unwrap();
        }
    }
    fs::rename(sessions.join(ID), sessions.join(OTHER)).unwrap();
    symlink(OTHER, sessions.join(ID)).unwrap();
    assert_eq!(
        code(open_session_recording(&sessions, ID)),
        "recording_unavailable"
    );
    fs::remove_file(sessions.join(ID)).unwrap();
    fs::rename(&sessions, root.path().join("actual")).unwrap();
    symlink("actual", &sessions).unwrap();
    assert_eq!(
        code(open_session_recording(&sessions, OTHER)),
        "recording_unavailable"
    );
}

#[test]
fn refuses_wrong_file_types_but_does_not_impose_cloud_size_cap() {
    let (_root, sessions) = fixture();
    recording(&sessions, ID, "audio.mp3");
    let file = sessions.join(ID).join("audio.mp3");
    fs::write(&file, b"").unwrap();
    assert_eq!(
        code(open_session_recording(&sessions, ID)),
        "recording_unavailable"
    );
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    assert_eq!(
        code(open_session_recording(&sessions, ID)),
        "recording_unavailable"
    );
    fs::remove_dir(&file).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(&file)
        .status()
        .unwrap()
        .success());
    assert_eq!(
        code(open_session_recording(&sessions, ID)),
        "recording_unavailable"
    );
    fs::remove_file(&file).unwrap();
    let sparse = fs::File::create(&file).unwrap();
    sparse.set_len(120_960_001).unwrap();
    assert_eq!(
        open_session_recording(&sessions, ID).unwrap().format,
        AudioFormat::Mp3
    );
}

#[test]
fn finalisation_states_and_atomic_replacement_never_lose_audio() {
    let (_root, sessions) = fixture();
    recording(&sessions, ID, "audio.wav");
    let dir = sessions.join(ID);
    assert_eq!(
        open_session_recording(&sessions, ID).unwrap().format,
        AudioFormat::Wav
    );
    fs::write(dir.join("audio.mp3"), b"sound").unwrap();
    assert_eq!(
        open_session_recording(&sessions, ID).unwrap().format,
        AudioFormat::Mp3
    );
    fs::remove_file(dir.join("audio.wav")).unwrap();
    assert_eq!(
        open_session_recording(&sessions, ID).unwrap().format,
        AudioFormat::Mp3
    );
    fs::write(dir.join("audio.wav"), b"sound").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let writer_dir = dir.clone();
    let ready = barrier.clone();
    let writer = std::thread::spawn(move || {
        ready.wait();
        for _ in 0..500 {
            fs::write(writer_dir.join("audio.tmp"), b"sound").unwrap();
            fs::rename(writer_dir.join("audio.tmp"), writer_dir.join("audio.mp3")).unwrap();
            fs::remove_file(writer_dir.join("audio.wav")).unwrap();
            fs::write(writer_dir.join("audio.wav.tmp"), b"sound").unwrap();
            fs::rename(
                writer_dir.join("audio.wav.tmp"),
                writer_dir.join("audio.wav"),
            )
            .unwrap();
        }
    });
    barrier.wait();
    for _ in 0..500 {
        open_session_recording(&sessions, ID).unwrap();
    }
    writer.join().unwrap();
}

/// Paths, content and symlink targets are compared, so a refused capture
/// cannot mutate either the sessions tree or the outside sentinel tree.
fn tree_snapshot(root: &Path) -> Vec<(PathBuf, String)> {
    fn walk(root: &Path, current: &Path, out: &mut Vec<(PathBuf, String)>) {
        let mut entries = fs::read_dir(current)
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).unwrap();
            let content = if meta.file_type().is_symlink() {
                format!("link:{}", fs::read_link(&path).unwrap().display())
            } else if meta.is_file() {
                format!("file:{:?}", fs::read(&path).unwrap())
            } else {
                "dir".into()
            };
            out.push((path.strip_prefix(root).unwrap().to_owned(), content));
            if meta.is_dir() {
                walk(root, &path, out);
            }
        }
    }
    let mut result = vec![];
    walk(root, root, &mut result);
    result
}

fn reject_without_start(root: &Path, sessions: &Path, id: &str, expected: &str) {
    let before = tree_snapshot(root);
    let mut called = false;
    let result = prepare_capture_dir(sessions, id).map(|mut guard| {
        called = true;
        guard.started();
    });
    assert_eq!(code(result), expected);
    assert!(!called);
    assert_eq!(tree_snapshot(root), before);
}

#[test]
fn capture_refuses_unsafe_tree_collisions_and_noncanonical_ids_without_side_effects() {
    let (root, sessions) = fixture();
    fs::create_dir(root.path().join("outside")).unwrap();
    recording(&root.path().join("outside"), ID, "audio.wav");
    for id in [
        "../x",
        "Documents",
        "Ccadbd56-643d-4919-aa16-ac6a5314d58e",
        "cloud-not-uuid",
    ] {
        reject_without_start(root.path(), &sessions, id, "invalid_session");
    }
    symlink(root.path().join("outside"), sessions.join("folder")).unwrap();
    assert_eq!(
        anlg_transcription_core::listener::actors::find_session_dir(&sessions, ID),
        sessions.join("folder").join(ID)
    );
    reject_without_start(root.path(), &sessions, ID, "unsafe_sessions_folder");
    fs::remove_file(sessions.join("folder")).unwrap();
    fs::create_dir(sessions.join(ID)).unwrap();
    fs::write(sessions.join(ID).join("audio.wav"), b"existing").unwrap();
    reject_without_start(root.path(), &sessions, ID, "session_exists");
    fs::remove_dir_all(sessions.join(ID)).unwrap();
    for kind in ["file", "dangling"] {
        if kind == "file" {
            fs::write(sessions.join(ID), b"existing").unwrap();
        } else {
            symlink("missing", sessions.join(ID)).unwrap();
        }
        reject_without_start(
            root.path(),
            &sessions,
            ID,
            if kind == "file" {
                "session_exists"
            } else {
                "unsafe_sessions_folder"
            },
        );
        fs::remove_file(sessions.join(ID)).unwrap();
    }
    fs::create_dir(sessions.join("folder")).unwrap();
    fs::create_dir(sessions.join("folder").join(ID)).unwrap();
    reject_without_start(root.path(), &sessions, ID, "session_exists");
    fs::remove_dir_all(sessions.join("folder")).unwrap();
    fs::create_dir(sessions.join(format!("cloud-{OTHER}"))).unwrap();
    symlink(
        "missing",
        sessions.join(format!("cloud-{OTHER}")).join("bad"),
    )
    .unwrap();
    reject_without_start(root.path(), &sessions, ID, "unsafe_sessions_folder");
    fs::remove_file(sessions.join(format!("cloud-{OTHER}")).join("bad")).unwrap();
    fs::rename(&sessions, root.path().join("actual")).unwrap();
    symlink("actual", &sessions).unwrap();
    reject_without_start(root.path(), &sessions, ID, "unsafe_sessions_folder");
}

#[test]
fn capture_accepts_safe_tree_and_rolls_back_only_failed_starts() {
    let (_root, sessions) = fixture();
    let mut first = prepare_capture_dir(&sessions, ID).unwrap();
    assert!(sessions.join(ID).is_dir());
    assert_eq!(
        anlg_transcription_core::listener::actors::find_session_dir(&sessions, ID),
        sessions.join(ID)
    );
    assert_eq!(code(prepare_capture_dir(&sessions, ID)), "session_exists");
    first.started();
    drop(first);
    assert!(sessions.join(ID).is_dir());
    fs::create_dir(sessions.join(format!("cloud-{OTHER}"))).unwrap();
    fs::create_dir(sessions.join("group")).unwrap();
    let failed = prepare_capture_dir(&sessions, OTHER).unwrap();
    assert!(sessions.join(OTHER).is_dir());
    drop(failed);
    assert!(!sessions.join(OTHER).exists());
}

#[test]
fn scan_ignores_entries_removed_between_readdir_and_stat_or_open() {
    let (_root, sessions) = fixture();
    let fd = rustix::fs::open(
        &sessions,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .unwrap();

    fs::write(sessions.join("vanishing-file"), b"temporary").unwrap();
    let mut removed_before_stat = false;
    scan_recorder_tree_with(&fd, ID, &mut |parent, name, point| {
        if point == ScanPoint::BeforeStat && name.to_bytes() == b"vanishing-file" {
            rustix::fs::unlinkat(parent, name, AtFlags::empty()).unwrap();
            removed_before_stat = true;
        }
    })
    .unwrap();
    assert!(removed_before_stat);

    fs::create_dir(sessions.join("vanishing-dir")).unwrap();
    let mut removed_before_open = false;
    scan_recorder_tree_with(&fd, ID, &mut |parent, name, point| {
        if point == ScanPoint::BeforeOpen && name.to_bytes() == b"vanishing-dir" {
            rustix::fs::unlinkat(parent, name, AtFlags::REMOVEDIR).unwrap();
            removed_before_open = true;
        }
    })
    .unwrap();
    assert!(removed_before_open);
    assert!(prepare_capture_dir(&sessions, ID).is_ok());
}

#[test]
fn recorder_segment_uses_same_preflight_and_never_resumes_an_existing_folder() {
    let (_root, sessions) = fixture();
    let segment = format!("rec-{ID}");
    assert_eq!(
        code(prepare_capture_dir(&sessions, &segment)),
        "invalid_session"
    );
    assert_eq!(code(prepare_recorder_dir(&sessions, ID)), "invalid_session");
    assert_eq!(
        code(prepare_recorder_dir(&sessions, "rec-../escape")),
        "invalid_session"
    );
    let mut prepared = prepare_recorder_dir(&sessions, &segment).unwrap();
    assert!(sessions.join(&segment).is_dir());
    assert_eq!(
        anlg_transcription_core::listener::actors::find_session_dir(&sessions, &segment),
        sessions.join(&segment)
    );
    assert_eq!(
        code(prepare_recorder_dir(&sessions, &segment)),
        "session_exists"
    );
    prepared.started();
    drop(prepared);
    assert!(sessions.join(&segment).is_dir());
}

#[test]
fn unreadable_folder_fails_closed_when_permissions_are_enforced() {
    let (root, sessions) = fixture();
    let folder = sessions.join("group");
    fs::create_dir(&folder).unwrap();
    let before = tree_snapshot(root.path());
    fs::set_permissions(&folder, fs::Permissions::from_mode(0)).unwrap();
    if fs::read_dir(&folder).is_ok() {
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
        return; // running as root
    }
    assert_eq!(
        code(prepare_capture_dir(&sessions, ID)),
        "unsafe_sessions_folder"
    );
    assert!(!sessions.join(ID).exists());
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(tree_snapshot(root.path()), before);
}

#[tokio::test]
async fn admission_orders_resolution_snapshot_and_concurrent_capture() {
    let (_root, sessions) = fixture();
    let queried = std::cell::Cell::new(false);
    assert_eq!(
        code(
            admit_transcription(&sessions, ID, || async {
                queried.set(true);
                Ok(false)
            })
            .await
        ),
        "recording_unavailable"
    );
    assert!(!queried.get());
    recording(&sessions, ID, "audio.wav");
    let admitted = admit_transcription(&sessions, ID, || async {
        assert_eq!(code(prepare_capture_dir(&sessions, ID)), "session_exists");
        Ok(false)
    })
    .await
    .unwrap();
    assert_eq!(
        admitted.1,
        sessions.join(ID).join("audio.wav").to_str().unwrap()
    );
    assert_eq!(
        fs::read(sessions.join(ID).join("audio.wav")).unwrap(),
        b"sound"
    );
    for (state, snapshot) in [
        ("active", Ok(true)),
        ("finalizing", Ok(true)),
        ("snapshot error", Err(())),
    ] {
        assert_eq!(
            code(admit_transcription(&sessions, ID, || async { snapshot }).await),
            "recording_busy",
            "{state}"
        );
    }
    // Keep the fake recorder's lock held until the snapshot has observed it;
    // elapsed-time sleeps made this assertion race on loaded CI runners.
    let lock = Arc::new(parking_lot::Mutex::new(()));
    let writer_lock = lock.clone();
    let reader_lock = lock.clone();
    let (ready, locked) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let _guard = writer_lock.lock();
        ready.send(()).unwrap();
        released.recv().unwrap();
    });
    locked.recv().unwrap();
    let outcome = admit_transcription(&sessions, ID, || async move {
        Ok(reader_lock.try_lock().is_none())
    })
    .await;
    release.send(()).unwrap();
    writer.join().unwrap();
    assert_eq!(code(outcome), "recording_busy");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn real_recorder_stays_in_prepared_session_and_final_audio_resolves() {
    use anlg_transcription_core::listener::actors::{
        RecArgs, RecMsg, RecorderActor, RecorderEnqueueResult,
    };
    use ractor::{rpc::CallResult, Actor};
    use std::time::Duration;

    let (root, sessions) = fixture();
    fs::create_dir(root.path().join("outside")).unwrap();
    fs::write(root.path().join("outside/sentinel"), b"untouched").unwrap();
    let outside = tree_snapshot(&root.path().join("outside"));
    let mut prepared = prepare_capture_dir(&sessions, ID).unwrap();
    let (actor, handle) = Actor::spawn(
        None,
        RecorderActor::new(),
        RecArgs {
            app_dir: sessions.clone(),
            session_id: ID.into(),
        },
    )
    .await
    .unwrap();
    prepared.started();
    let samples: Arc<[f32]> = vec![0.1f32; 16_000].into();
    let reply = actor
        .call(
            move |port| RecMsg::AudioSingle(samples, port),
            Some(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    assert_eq!(reply, CallResult::Success(RecorderEnqueueResult::Accepted));
    actor.stop(Some("complete".into()));
    handle.await.unwrap();
    let result = open_session_recording(&sessions, ID).unwrap();
    assert!(result.file.metadata().unwrap().len() > 0);
    for entry in fs::read_dir(sessions.join(ID)).unwrap() {
        assert!(!fs::symlink_metadata(entry.unwrap().path())
            .unwrap()
            .file_type()
            .is_symlink());
    }
    assert_eq!(tree_snapshot(&root.path().join("outside")), outside);
    assert_eq!(code(prepare_capture_dir(&sessions, ID)), "session_exists");
}
