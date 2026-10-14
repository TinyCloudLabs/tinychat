//! Recorder audio import, shared with the native transcript-quality runner.
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rustix::fs::{Mode, OFlags};

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn normalize_and_import_at(
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
    let attempt = uuid::Uuid::new_v4();
    let decoded = output.with_extension(format!("decoded-{attempt}.wav"));
    let result = anlg_mp3::decode_to_wav(source, &decoded)
        .map_err(|e| format!("decode_failed: {e}"))
        .and_then(|_| encode_mono_wav(&decoded, output, system_audio, attempt));
    let _ = fs::remove_file(decoded);
    result
}

fn encode_mono_wav(
    wav: &Path,
    output: &Path,
    system_audio: bool,
    attempt: uuid::Uuid,
) -> Result<(), String> {
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
    let temp = output.with_extension(format!("mp3-{attempt}.tmp"));
    let result = (|| {
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
        fs::rename(&temp, output).map_err(|e| e.to_string())?;
        File::open(output.parent().ok_or("missing_capture_session")?)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
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

pub fn import_at(root: &Path, id: &str, segment_id: &str, path: &Path) -> Result<(), String> {
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
        rustix::fs::open(
            path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
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

pub fn audio_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid_recording_id".into());
    }
    Ok(root.join(format!("{id}.mp3")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_normalization_uses_separate_attempt_files() {
        let base = std::env::temp_dir().join(format!("exo-normalize-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&base).unwrap();
        let wav = base.join("source.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&wav, spec).unwrap();
        for _ in 0..3_200 {
            writer.write_sample(0_i16).unwrap();
        }
        writer.finalize().unwrap();
        let source = base.join("source.mp3");
        anlg_mp3::encode_wav(&wav, &source).unwrap();
        let output = base.join("audio.mono.mp3");
        let start = std::sync::Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let (source, output, start) = (source.clone(), output.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    normalize_mp3(&source, &output, false)
                })
            })
            .collect();
        start.wait();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        assert!(fs::metadata(&output).unwrap().len() > 0);
        let decoded = base.join("verified.wav");
        anlg_mp3::decode_to_wav(&output, &decoded).unwrap();
        assert!(hound::WavReader::open(&decoded).unwrap().duration() > 0);
        for entry in fs::read_dir(&base).unwrap() {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            assert!(
                !name.contains("decoded-") && !name.contains("mp3-"),
                "leftover attempt: {name}"
            );
        }
        fs::remove_dir_all(base).unwrap();
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
        assert_eq!(fs::read(root.join("note.mp3")).unwrap(), b"firstsecond");
        import_at(&root, "note", "rec-segment", &source).unwrap();
        assert_eq!(fs::read(root.join("note.mp3")).unwrap(), b"firstsecond");
        fs::remove_dir_all(root).unwrap();
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
            let spec = hound::WavReader::open(&decoded).unwrap().spec();
            assert_eq!(spec.channels, 1);
            assert_eq!(spec.sample_rate, 16_000);
            // MPEG-2 Layer III at 16 kHz uses bitrate index 8 for 64 kb/s.
            // Inspect the produced frame instead of requiring ffprobe on CI.
            let mp3 = fs::read(&note).unwrap();
            let offset = if mp3.starts_with(b"ID3") {
                let size = mp3.get(6..10).expect("complete ID3 header");
                10 + size
                    .iter()
                    .fold(0usize, |n, byte| (n << 7) | usize::from(byte & 0x7f))
            } else {
                0
            };
            let header = u32::from_be_bytes(
                mp3.get(offset..offset + 4)
                    .expect("MP3 frame header")
                    .try_into()
                    .unwrap(),
            );
            assert_eq!(header >> 21, 0x7ff, "invalid MP3 frame");
            assert_eq!((header >> 19) & 0b11, 0b10, "expected MPEG-2");
            assert_eq!((header >> 17) & 0b11, 0b01, "expected Layer III");
            assert_eq!((header >> 12) & 0b1111, 8, "expected 64 kb/s");
            assert_eq!((header >> 10) & 0b11, 2, "expected 16 kHz");
            assert_eq!((header >> 6) & 0b11, 3, "expected mono");
            fs::remove_dir_all(base).unwrap();
        }
    }
}
