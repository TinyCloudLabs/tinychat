use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anlg_audio_utils::Source;
use axum::http::StatusCode;
use exo_local_transcription::{audio_import::normalize_and_import_at, request::RequestSpec};
use futures_util::StreamExt;
use owhisper_client::WhisperCppAdapter;
use owhisper_interface::{ListenParams, batch_stream::BatchStreamEvent};
use serde_json::json;
use transcribe_whisper_local::TranscribeService;

type Result<T, E = Box<dyn Error>> = std::result::Result<T, E>;
fn system_audio_from_spec(fixture: &Path) -> Result<bool> {
    let spec: serde_json::Value = serde_json::from_slice(&fs::read(fixture.join("spec.json"))?)?;
    spec.get("systemAudio")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "fixture spec.json requires a boolean systemAudio".into())
}

fn model_id(model: &Path) -> Result<&'static str> {
    match model.file_name().and_then(|name| name.to_str()) {
        Some("ggml-small-q8_0.bin") => Ok("QuantizedSmall"),
        Some("ggml-large-v3-turbo-q8_0.bin") => Ok("QuantizedLargeTurbo"),
        _ => Err(format!("unsupported --model filename: {}", model.display()).into()),
    }
}

fn import_mono(source: &Path, scratch: &Path, system_audio: bool) -> Result<PathBuf> {
    let notes = scratch.join("voice-notes/audio");
    let sessions = scratch.join("sessions");
    let segment = sessions.join("rec-eval-smoke");
    fs::create_dir_all(&notes)?;
    fs::create_dir_all(&segment)?;
    let staged = segment.join("audio.mp3");
    fs::copy(source, &staged)?;
    normalize_and_import_at(
        &notes,
        &sessions,
        "eval-smoke",
        "rec-eval-smoke",
        &staged,
        system_audio,
    )
    .map_err(|error| format!("production mono import failed: {error}"))?;
    Ok(notes.join("eval-smoke.mp3"))
}

struct Args {
    fixture: PathBuf,
    model: PathBuf,
    output: PathBuf,
    input: String,
    channels_audio: Option<PathBuf>,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut fixture = None;
        let mut model = None;
        let mut output = None;
        let mut input = None;
        let mut vocabulary = None;
        let mut channels_audio = None;
        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            let value = args.next().ok_or(format!("missing value for {flag}"))?;
            let slot = match flag.as_str() {
                "--fixture" => &mut fixture,
                "--model" => &mut model,
                "--output" => &mut output,
                "--input" => &mut input,
                "--vocabulary" => &mut vocabulary,
                "--channels-audio" => &mut channels_audio,
                _ => return Err(format!("unknown option: {flag}").into()),
            };
            if slot.replace(value).is_some() {
                return Err(format!("duplicate option: {flag}").into());
            }
        }
        if vocabulary.as_deref() != Some("off") {
            return Err("--vocabulary off is required (on is not available until E)".into());
        }
        let input = input.ok_or("required: --input mono|channels")?;
        if input != "mono" && input != "channels" {
            return Err(format!("unsupported input: {input} (expected mono|channels)").into());
        }
        if input == "mono" && channels_audio.is_some() {
            return Err("--channels-audio is only valid with --input channels".into());
        }
        Ok(Self {
            fixture: PathBuf::from(fixture.ok_or("required: --fixture <directory>")?),
            model: PathBuf::from(model.ok_or("required: --model <ggml-model.bin>")?),
            output: PathBuf::from(output.ok_or("required: --output <directory>")?),
            input,
            channels_audio: channels_audio.map(PathBuf::from),
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse()?;
    let fixture = fs::canonicalize(&args.fixture)?;
    let model = fs::canonicalize(&args.model)?;
    let model_id = model_id(&args.model)?;
    let system_audio = system_audio_from_spec(&fixture)?;
    if !model.is_file() || model.metadata()?.len() == 0 {
        return Err("--model must be a non-empty model file".into());
    }
    let source = fixture.join("audio.mp3");
    if !source.is_file() || source.metadata()?.len() == 0 {
        return Err(format!("missing or empty fixture audio: {}", source.display()).into());
    }
    let audio = anlg_audio_utils::source_from_path(&source)?;
    if u16::from(audio.channels()) != 2 || u32::from(audio.sample_rate()) != 16_000 {
        return Err("fixture audio.mp3 must be stereo 16 kHz (recorder segment format)".into());
    }
    let seconds = audio
        .total_duration()
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_else(|| {
            let channels = f64::from(u16::from(audio.channels()));
            audio.count() as f64 / channels / 16_000.0
        });

    // Mono uses exactly the production importer, including the recorder's MP3
    // decoding/re-encoding and its segment markers. Keep all scratch state local
    // to this run; importer deletes the copied session, never the fixture.
    let scratch = tempfile::tempdir()?;
    let selected = if args.input == "mono" {
        import_mono(&source, scratch.path(), system_audio)?
    } else {
        // BR's stereo copy, or an explicitly supplied stereo fixture pending BR.
        // Never mistake the raw recorder segment for BR's encoded copy.
        let channels = match args.channels_audio {
            Some(path) => path,
            None => fixture.join("audio.channels.mp3"),
        };
        if !channels.is_file() || channels.metadata()?.len() == 0 {
            return Err(format!(
                "missing stereo copy {}; pass --channels-audio <stereo-fixture.mp3> until BR",
                channels.display()
            )
            .into());
        }
        let decoded = anlg_audio_utils::source_from_path(&channels)?;
        if u16::from(decoded.channels()) != 2 || u32::from(decoded.sample_rate()) != 16_000 {
            return Err("channels audio must be stereo 16 kHz".into());
        }
        channels
    };

    let RequestSpec {
        languages,
        model: request_model,
        keywords,
    } = RequestSpec::production(model_id);
    let params = ListenParams {
        languages: languages
            .iter()
            .map(|language| language.parse())
            .collect::<std::result::Result<Vec<_>, _>>()?,
        model: Some(request_model.clone()),
        keywords: keywords.clone(),
        channels: if args.input == "channels" { 2 } else { 1 },
        ..Default::default()
    };

    let service = TranscribeService::builder()
        .model_path(model.clone())
        .build()
        .into_router(|error: String| async move { (StatusCode::INTERNAL_SERVER_ERROR, error) });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let server = tokio::spawn(async move { axum::serve(listener, service).await });
    let started = Instant::now();
    let result = transcribe(&base, &params, &selected).await;
    server.abort();
    let (response, max_sse_gap) = result?;
    let elapsed = started.elapsed().as_secs_f64();

    fs::create_dir_all(&args.output)?;
    fs::write(
        args.output.join("response.json"),
        serde_json::to_vec_pretty(&response)?,
    )?;
    fs::write(
        args.output.join("run.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "fixture": fixture.display().to_string(),
            "modelPath": model.display().to_string(),
            "input": args.input,
            "systemAudio": system_audio,
            "vocabulary": "off",
            "request": { "languages": languages, "model": request_model, "keywords": keywords },
            "noteDurationSeconds": seconds,
            "runtime": { "maxSseGapSeconds": max_sse_gap, "realTimeFactor": elapsed / seconds, "elapsedSeconds": elapsed, "peakMemoryBytes": peak_memory_bytes() }
        }))?,
    )?;
    Ok(())
}

async fn transcribe(
    base: &str,
    params: &ListenParams,
    audio: &Path,
) -> Result<(owhisper_interface::batch::Response, f64)> {
    let mut last_event = Instant::now();
    let mut stream = WhisperCppAdapter::transcribe_file_streaming(base, params, audio).await?;
    let mut max_gap: f64 = 0.0;
    let mut result = None;
    while let Some(event) = stream.next().await {
        max_gap = max_gap.max(last_event.elapsed().as_secs_f64());
        last_event = Instant::now();
        match event? {
            BatchStreamEvent::Result { response } => {
                if result.replace(response).is_some() {
                    return Err("duplicate final transcription result".into());
                }
            }
            BatchStreamEvent::Error { error_message, .. } => return Err(error_message.into()),
            BatchStreamEvent::Progress { .. }
            | BatchStreamEvent::Segment { .. }
            | BatchStreamEvent::Terminal { .. } => {}
        }
    }
    Ok((
        result.ok_or("transcription stream ended without a result")?,
        max_gap,
    ))
}

#[cfg(unix)]
fn peak_memory_bytes() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // getrusage initializes the entire struct on success. Linux reports KiB;
    // macOS reports bytes.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    let rss = u64::try_from(unsafe { usage.assume_init() }.ru_maxrss).ok()?;
    #[cfg(target_os = "linux")]
    {
        rss.checked_mul(1024)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Some(rss)
    }
}

#[cfg(not(unix))]
fn peak_memory_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_models_match_desktop_whisper_ids() {
        assert_eq!(
            model_id(Path::new("/models/ggml-small-q8_0.bin")).unwrap(),
            "QuantizedSmall"
        );
        assert_eq!(
            model_id(Path::new("/models/ggml-large-v3-turbo-q8_0.bin")).unwrap(),
            "QuantizedLargeTurbo"
        );
        assert!(model_id(Path::new("/models/ggml-medium.bin")).is_err());
    }

    #[test]
    fn fixture_flag_selects_production_import_policy() {
        let fixture = tempfile::tempdir().unwrap();
        let source = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../smoke/audio.mp3"));
        let mut means = Vec::new();
        for flag in [false, true] {
            fs::write(
                fixture.path().join("spec.json"),
                format!(r#"{{"systemAudio":{flag}}}"#),
            )
            .unwrap();
            let selected = system_audio_from_spec(fixture.path()).unwrap();
            assert_eq!(selected, flag);
            let scratch = tempfile::tempdir().unwrap();
            let imported = import_mono(source, scratch.path(), selected).unwrap();
            let samples = anlg_audio_utils::source_from_path(&imported).unwrap();
            let values: Vec<f32> = samples.collect();
            means.push(values.iter().map(|value| value.abs()).sum::<f32>() / values.len() as f32);
        }
        assert!(
            means[0] > means[1] * 1.5,
            "mic-only and mixed imports should differ: {means:?}"
        );

        for invalid in [
            r#"{}"#,
            r#"{"systemAudio":"true"}"#,
            r#"{"systemAudio":null}"#,
        ] {
            fs::write(fixture.path().join("spec.json"), invalid).unwrap();
            assert!(system_audio_from_spec(fixture.path()).is_err());
        }
    }
}
