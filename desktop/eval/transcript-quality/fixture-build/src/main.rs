//! Regenerate the small, synthetic A2 smoke fixture (not the A3 evaluation set).
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use sha2::{Digest, Sha256};

type Result<T, E = Box<dyn Error>> = std::result::Result<T, E>;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--output") {
        return Err("usage: transcript-quality-fixture-build --output <directory>".into());
    }
    let output = PathBuf::from(args.next().ok_or("missing output directory")?);
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }
    fs::create_dir_all(&output)?;
    let scratch = tempfile::tempdir()?;
    let wav = scratch.path().join("synthetic-stereo.wav");
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "flite=text='The blue kite is flying today.':voice=slt",
            "-filter_complex", "[0:a]pan=stereo|c0=c0|c1=0*c0[out]",
            "-map", "[out]", "-ar", "16000", "-ac", "2",
            "-c:a", "pcm_f32le", "-f", "wav", "-y"])
        .arg(&wav)
        .status()?;
    if !status.success() {
        return Err(format!("ffmpeg Flite PCM synthesis failed: {status}").into());
    }
    let audio = output.join("audio.mp3");
    // This is the same encoder and stereo bit rate used for recorder segments.
    anlg_mp3::encode_wav(&wav, &audio)?;
    for (name, contents) in [
        ("expected.json", include_str!("../../fixtures/smoke-speech/expected.json")),
        ("spec.json", include_str!("../../fixtures/smoke-speech/spec.json")),
    ] {
        fs::write(output.join(name), contents)?;
    }
    let mut provenance: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/smoke-speech/provenance.json"))?;
    provenance["audioSha256"] = format!("{:x}", Sha256::digest(fs::read(&audio)?)).into();
    let mut bytes = serde_json::to_vec_pretty(&provenance)?;
    bytes.push(b'\n');
    fs::write(output.join("provenance.json"), bytes)?;
    Ok(())
}
