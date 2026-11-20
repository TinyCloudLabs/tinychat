//! Mac check A: which processes capture or play audio, and what the call prompt makes of them.
//!
//! ```text
//! cargo run --release --example mic_apps -- [--seconds N]
//! ```
//!
//! Once a second for N seconds (20 by default) it prints one line:
//! - the time;
//! - the gate: whether any input device is in use, and how long that took (the app asks every
//!   two seconds, and scans only when it is open or a call is being followed), then each input
//!   device's own answer: its CoreAudio id, `in` or `in+out` (a headset), `yes` or `no`;
//! - the app's own scan (`Scanner::scan`, with its buffer kept from line to line): how long it
//!   took and which call apps it heard. Here it runs on every line, whatever the gate says;
//! - every process that captures (`in`) or plays (`out`) audio: its bundle id, its process id
//!   and the table entry it maps to, or `-` for none.
//!
//! No permission is needed and no audio is read.
//!
//! Unlike the app, this lists every audio process with its bundle id, so that the table can be
//! checked: run it through a Meet call (lobby, joined, muted), Zoom, a Slack huddle and a clip,
//! FaceTime, Signal, Teams, Safari and dictation. Its output stays in your terminal.

use call_prompt::apps;
use call_prompt::mic::{self, AudioProcesses, CoreAudio, Gate, Scanner};
use std::time::{Duration, Instant};

const USAGE: &str = "usage: mic_apps [--seconds N]";

fn main() {
    let mut seconds: u64 = 20;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seconds" => match args.next().and_then(|value| value.parse().ok()) {
                Some(value) => seconds = value,
                None => fail(),
            },
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
    let mut gate = Gate::new();
    let mut scanner = Scanner::new();
    let mut list = Vec::new();
    println!("# t | gate: an input device in use (time) [each input device: id in|in+out yes|no] | app scan time | heard | bundle id, pid, in = captures, out = plays, -> table entry (kind) or -");
    let started = Instant::now();
    for second in 1..=seconds {
        let gate_started = Instant::now();
        let open = gate.open(&mut audio, started.elapsed());
        let gate_ms = gate_started.elapsed().as_secs_f64() * 1000.0;
        let open = match open {
            Ok(true) => "yes".to_string(),
            Ok(false) => "no".to_string(),
            Err(error) => format!("failed {error:?}"),
        };
        let devices: Vec<String> = gate
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
        let scan_started = Instant::now();
        let scan = scanner.scan(&mut audio, own_pid);
        let scan_ms = scan_started.elapsed().as_secs_f64() * 1000.0;
        let mut line = format!(
            "{second:>4} s | gate {open} ({gate_ms:.2} ms) [{}] | scan {scan_ms:.2} ms",
            devices.join(", ")
        );
        match &scan {
            Ok(heard) => {
                let calls: Vec<&str> = heard
                    .iter()
                    .map(|entry| entry.app.app().bundle_id)
                    .collect();
                line.push_str(&format!(" | heard: {}", list_or_dash(&calls)));
            }
            Err(error) => line.push_str(&format!(" | scan failed: {error:?}")),
        }
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
