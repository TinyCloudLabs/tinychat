//! Mac check A: which processes capture or play audio, what the call prompt makes of them, and
//! what each of its passes costs.
//!
//! ```text
//! cargo run --release --example mic_apps -- [--seconds N] [--full-every S] [--no-list]
//! ```
//!
//! Once a second for N seconds (20 by default) it runs the app's own look (`Mic::look`, the read
//! the watcher makes every two seconds) and prints one line:
//! - the time;
//! - the gate: whether any input device is in use, how long that took, then each input device's
//!   own answer: its CoreAudio id, `in` or `in+out` (a headset), `yes` or `no`;
//! - the pass that ran and its time: `gate` (nothing else read), `followed` (only the process
//!   objects of the call apps seen capturing) or `full` (every process object), with the number
//!   of process objects it read. As in the app, a full scan runs when the gate opens, then every
//!   10 s with the gate open, every 14 s while a call app is heard; `--full-every S` forces a full
//!   scan every S seconds instead;
//! - the call apps heard;
//! - unless `--no-list`: every process that captures (`in`) or plays (`out`) audio, with its
//!   bundle id, its process id and the table entry it maps to (`-` for none). That list is an
//!   extra read of every process, after the timed pass.
//!
//! No permission is needed and no audio is read.
//!
//! Unlike the app, this lists every audio process with its bundle id, so that the table can be
//! checked: run it through a Meet call (lobby, joined, muted), Zoom, a Slack huddle and a clip,
//! FaceTime, Signal, Teams, Safari and dictation. Its output stays in your terminal.

use call_prompt::apps;
use call_prompt::mic::{self, AudioProcesses, CoreAudio, Mic};
use std::time::{Duration, Instant};

const USAGE: &str = "usage: mic_apps [--seconds N] [--full-every S] [--no-list]";

fn main() {
    let mut seconds: u64 = 20;
    let mut full_every: Option<u64> = None;
    let mut list_all = true;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seconds" => match args.next().and_then(|value| value.parse().ok()) {
                Some(value) => seconds = value,
                None => fail(),
            },
            "--full-every" => match args.next().and_then(|value| value.parse().ok()) {
                Some(value) if value > 0 => full_every = Some(value),
                _ => fail(),
            },
            "--no-list" => list_all = false,
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            _ => fail(),
        }
    }
    if !mic::SUPPORTED {
        eprintln!("mic_apps reads CoreAudio's process objects; it runs on macOS only.");
        std::process::exit(2);
    }

    let own_pid = std::process::id() as i32;
    let mut audio = CoreAudio;
    let mut mic = match full_every {
        Some(every) => Mic::with_full_every(Duration::from_secs(every)),
        None => Mic::new(),
    };
    let mut list = Vec::new();
    let mut following = false;
    println!("# t | gate: an input device in use (time) [each input device: id in|in+out yes|no] | pass: gate|followed|full (time, process objects read) | heard | bundle id, pid, in = captures, out = plays, -> table entry (kind) or -");
    let started = Instant::now();
    for second in 1..=seconds {
        let look = mic.look(&mut audio, own_pid, following, started.elapsed());
        let open = match look.gate {
            Ok(true) => "yes".to_string(),
            Ok(false) => "no".to_string(),
            Err(error) => format!("failed {error:?}"),
        };
        let devices: Vec<String> = mic
            .gate()
            .devices()
            .to_vec()
            .into_iter()
            .map(|device| {
                let streams = if audio.device_plays(device) {
                    "in+out"
                } else {
                    "in"
                };
                let running = match audio.device_running(device) {
                    Ok(true) => "yes".to_string(),
                    Ok(false) => "no".to_string(),
                    Err(error) => format!("failed {error:?}"),
                };
                format!("{device} {streams} {running}")
            })
            .collect();
        let mut line = format!(
            "{second:>4} s | gate {open} ({:.2} ms) [{}] | pass {} ({:.2} ms, {} objects)",
            look.gate_took.as_secs_f64() * 1000.0,
            devices.join(", "),
            look.pass.as_str(),
            look.took.as_secs_f64() * 1000.0,
            look.objects
        );
        match &look.heard {
            Some(heard) => {
                let calls: Vec<&str> = heard
                    .iter()
                    .map(|entry| entry.app.app().bundle_id)
                    .collect();
                line.push_str(&format!(" | heard: {}", list_or_dash(&calls)));
                // As the session would: a heard call app is followed.
                following = !heard.is_empty() || (following && look.pass != mic::Pass::Full);
            }
            None => line.push_str(&format!(" | scan failed: {:?}", look.error)),
        }
        if list_all {
            match everything(&mut audio, own_pid, &mut list) {
                Ok(processes) if processes.is_empty() => {
                    line.push_str(" | no process captures or plays")
                }
                Ok(processes) => {
                    for process in processes {
                        line.push_str(" | ");
                        line.push_str(&process);
                    }
                }
                Err(error) => line.push_str(&format!(" | process list failed: {error:?}")),
            }
        }
        println!("{line}");
        let next = Duration::from_secs(second);
        if let Some(wait) = next.checked_sub(started.elapsed()) {
            std::thread::sleep(wait);
        }
    }
}

/// Every process that captures or plays, as one text each.
fn everything(
    audio: &mut CoreAudio,
    own_pid: i32,
    list: &mut Vec<u32>,
) -> Result<Vec<String>, mic::ScanError> {
    let mut out = Vec::new();
    audio.processes(list)?;
    for &process in list.iter() {
        let capturing = audio.capturing(process) == Some(true);
        let playing = audio.playing(process) == Some(true);
        if !capturing && !playing {
            continue;
        }
        let pid = audio.pid(process);
        let bundle_id = audio.bundle_id(process);
        let entry = bundle_id
            .as_deref()
            .and_then(apps::lookup)
            .map(|app| format!("{} ({})", app.app().bundle_id, app.kind().as_str()))
            .unwrap_or_else(|| "-".into());
        let streams = match (capturing, playing) {
            (true, true) => "in+out",
            (true, false) => "in",
            _ => "out",
        };
        let pid = pid.map_or_else(|| "?".into(), |pid| pid.to_string());
        let own = if audio.pid(process) == Some(own_pid) {
            " (this process)"
        } else {
            ""
        };
        out.push(format!(
            "{} pid {pid}{own} {streams} -> {entry}",
            bundle_id.as_deref().unwrap_or("(no bundle id)")
        ));
    }
    Ok(out)
}

fn list_or_dash(items: &[&str]) -> String {
    if items.is_empty() {
        "-".into()
    } else {
        items.join(", ")
    }
}

fn fail() -> ! {
    eprintln!("{USAGE}");
    std::process::exit(2);
}
