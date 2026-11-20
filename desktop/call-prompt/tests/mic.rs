//! The app table's mapping and the scan, over a fake CoreAudio.

use call_prompt::apps::{lookup, Kind, APPS};
use call_prompt::mic::{
    scan, AudioProcesses, Gate, Heard, Mic, Pass, ScanError, Scanner, DEVICE_LIST_REFRESH,
    FULL_SCAN_FOLLOWING, FULL_SCAN_IDLE,
};
use std::collections::HashMap;
use std::time::Duration;

const OWN_PID: i32 = 4242;

/// One fake process object.
#[derive(Clone, Default)]
struct Process {
    pid: Option<i32>,
    bundle_id: Option<&'static str>,
    capturing: Option<bool>,
    playing: Option<bool>,
}

fn process(bundle_id: &'static str, pid: i32, capturing: bool, playing: bool) -> Process {
    Process {
        pid: Some(pid),
        bundle_id: Some(bundle_id),
        capturing: Some(capturing),
        playing: Some(playing),
    }
}

/// CoreAudio as a list, counting what is read of each process.
struct Fake {
    list: Result<Vec<Process>, i32>,
    reads: HashMap<(u32, &'static str), usize>,
    lists: usize,
}

impl Fake {
    fn new(list: Vec<Process>) -> Self {
        Fake {
            list: Ok(list),
            reads: HashMap::new(),
            lists: 0,
        }
    }

    /// How many times this was read of the process, since the last call to `reset`.
    fn count(&self, object: u32, what: &'static str) -> usize {
        self.reads.get(&(object, what)).copied().unwrap_or(0)
    }

    /// Every read of a process since the last reset.
    fn total(&self) -> usize {
        self.reads.values().sum()
    }

    fn reset(&mut self) {
        self.reads.clear();
        self.lists = 0;
    }

    fn set(&mut self, object: usize, process: Process) {
        self.list.as_mut().unwrap()[object] = process;
    }

    fn get(&mut self, object: u32, what: &'static str) -> Option<Process> {
        *self.reads.entry((object, what)).or_default() += 1;
        self.list.as_ref().ok()?.get(object as usize).cloned()
    }

    fn read(&self, object: u32, what: &'static str) -> bool {
        self.reads.contains_key(&(object, what))
    }
}

impl AudioProcesses for Fake {
    fn input_devices(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError> {
        list.clear();
        list.push(1);
        Ok(())
    }

    fn device_running(&mut self, _device: u32) -> Result<bool, ScanError> {
        Ok(true)
    }

    fn processes(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError> {
        self.lists += 1;
        list.clear();
        match &self.list {
            Ok(processes) => {
                list.extend(0..processes.len() as u32);
                Ok(())
            }
            Err(status) => Err(ScanError::Failed(*status)),
        }
    }

    fn capturing(&mut self, process: u32) -> Option<bool> {
        self.get(process, "capturing")?.capturing
    }

    fn playing(&mut self, process: u32) -> Option<bool> {
        self.get(process, "playing")?.playing
    }

    fn pid(&mut self, process: u32) -> Option<i32> {
        self.get(process, "pid")?.pid
    }

    fn bundle_id(&mut self, process: u32) -> Option<String> {
        self.get(process, "bundle_id")?.bundle_id.map(str::to_owned)
    }
}

fn entry(bundle_id: &str, playing: bool) -> Heard {
    Heard {
        app: lookup(bundle_id).unwrap(),
        playing,
    }
}

#[test]
fn helpers_map_to_their_app_by_a_dot_prefix() {
    assert_eq!(
        lookup("com.google.Chrome.helper"),
        lookup("com.google.Chrome")
    );
    assert_eq!(
        lookup("com.google.Chrome.helper.Renderer"),
        lookup("com.google.Chrome")
    );
    assert_eq!(
        lookup("com.tinyspeck.slackmacgap.helper"),
        lookup("com.tinyspeck.slackmacgap")
    );
    assert_eq!(
        lookup("com.apple.TelephonyUtilities.callservicesd"),
        lookup("com.apple.TelephonyUtilities")
    );
    // Not a dot: another app.
    assert_eq!(lookup("com.google.Chromeish"), None);
    assert_eq!(lookup("us.zoom.xosx"), None);
    // A prefix of an entry is not the entry.
    assert_eq!(lookup("com.google"), None);
}

#[test]
fn the_longest_entry_wins() {
    let beta = lookup("com.google.Chrome.beta").unwrap();
    assert_eq!(beta.app().bundle_id, "com.google.Chrome.beta");
    let beta_helper = lookup("com.google.Chrome.beta.helper").unwrap();
    assert_eq!(beta_helper, beta);
    // Teams: the old and the new app are two entries, not a prefix of each other.
    assert_eq!(
        lookup("com.microsoft.teams2").unwrap().app().bundle_id,
        "com.microsoft.teams2"
    );
    assert_eq!(
        lookup("com.microsoft.teams").unwrap().app().bundle_id,
        "com.microsoft.teams"
    );
}

#[test]
fn case_does_not_matter() {
    assert_eq!(lookup("COM.GOOGLE.CHROME"), lookup("com.google.Chrome"));
    assert_eq!(
        lookup("company.thebrowser.browser.helper"),
        lookup("company.thebrowser.Browser")
    );
    assert_eq!(lookup("Us.Zoom.Xos"), lookup("us.zoom.xos"));
}

#[test]
fn unknown_and_odd_ids_map_to_nothing() {
    for id in [
        "",
        ".",
        "com.apple.dictation",
        "com.apple.VoiceMemos",
        "com.apple.WebKit.GPU",
        "xyz.tinycloud.exo",
        "com.example.Robin-Sample",
        "ünïcödé.zoom",
        "us.zoom.xos\u{0}",
    ] {
        assert_eq!(lookup(id), None, "{id:?}");
    }
}

#[test]
fn the_rules_are_eight_and_fifteen_seconds() {
    assert_eq!(lookup("us.zoom.xos").unwrap().kind(), Kind::Native);
    assert_eq!(lookup("com.apple.Safari").unwrap().kind(), Kind::Browser);
    assert_eq!(Kind::Native.sustain().as_secs(), 8);
    assert_eq!(Kind::Browser.sustain().as_secs(), 15);
    assert!(APPS.iter().any(|app| app.kind == Kind::Native));
}

#[test]
fn a_scan_returns_listed_apps_that_capture() {
    let mut fake = Fake::new(vec![
        process("us.zoom.xos", 100, true, true),
        process("com.google.Chrome.helper", 200, true, false),
        process("com.google.Chrome.helper", 201, true, true),
        process("com.apple.WebKit.GPU", 300, true, true),
        process("com.tinyspeck.slackmacgap", 400, false, true),
    ]);
    let heard = scan(&mut fake, OWN_PID).unwrap();
    // Zoom's output is not read: its rule needs capturing only.
    assert_eq!(
        heard,
        [
            entry("us.zoom.xos", false),
            entry("com.google.Chrome", true)
        ]
    );
}

#[test]
fn only_capturing_processes_are_asked_for_anything_else() {
    let mut fake = Fake::new(vec![
        process("com.tinyspeck.slackmacgap", 400, false, true),
        process("com.example.player", 500, false, true),
        process("com.google.Chrome", 100, true, false),
    ]);
    scan(&mut fake, OWN_PID).unwrap();
    for object in [0, 1] {
        assert!(fake.read(object, "capturing"));
        for what in ["pid", "bundle_id", "playing"] {
            assert!(
                !fake.read(object, what),
                "process {object} was asked for its {what}"
            );
        }
    }
    for what in ["capturing", "pid", "bundle_id", "playing"] {
        assert!(fake.read(2, what));
    }
}

#[test]
fn this_process_is_skipped() {
    // As if the app's own id were in the table: its pid still keeps it out.
    let mut fake = Fake::new(vec![process("us.zoom.xos", OWN_PID, true, true)]);
    assert!(scan(&mut fake, OWN_PID).unwrap().is_empty());
    assert!(!fake.read(0, "bundle_id"), "its id is not even read");
}

#[test]
fn a_process_without_an_id_or_with_failed_reads_is_skipped() {
    let mut fake = Fake::new(vec![
        Process {
            pid: Some(1),
            capturing: Some(true),
            ..Process::default()
        },
        Process {
            pid: Some(2),
            bundle_id: Some("us.zoom.xos"),
            capturing: None,
            playing: Some(true),
        },
        Process {
            pid: None,
            bundle_id: Some("com.hnc.Discord.helper"),
            capturing: Some(true),
            playing: None,
        },
    ]);
    // The last one has no pid: it cannot be this process, and it is Discord, not playing.
    assert_eq!(
        scan(&mut fake, OWN_PID).unwrap(),
        [entry("com.hnc.Discord", false)]
    );
}

#[test]
fn a_failed_process_list_is_an_error() {
    let mut fake = Fake {
        list: Err(-50),
        reads: HashMap::new(),
        lists: 0,
    };
    assert_eq!(scan(&mut fake, OWN_PID), Err(ScanError::Failed(-50)));
}

#[test]
fn unknown_ids_never_leave_the_scan() {
    // `Heard` holds a table entry and a flag: nothing of an unknown process can be kept.
    let mut fake = Fake::new(vec![
        process("com.example.dictation", 10, true, false),
        process("com.example.Alex-Example-recorder", 11, true, true),
    ]);
    assert!(scan(&mut fake, OWN_PID).unwrap().is_empty());
    let size = std::mem::size_of::<Heard>();
    assert!(
        size <= 2,
        "Heard grew to {size} bytes: does it hold more than an entry and a flag?"
    );
}

#[test]
fn a_scanner_keeps_its_buffer_and_leaves_no_stale_entries() {
    let mut scanner = Scanner::new();
    let mut fake = Fake::new(vec![
        process("com.example.player", 1, false, true),
        process("com.example.player", 2, false, true),
        process("com.example.player", 3, false, true),
        process("us.zoom.xos", 4, true, false),
    ]);
    assert_eq!(
        scanner.scan(&mut fake, OWN_PID).unwrap(),
        [entry("us.zoom.xos", false)]
    );
    // Fewer processes on the next scan: Zoom has quit.
    let mut fake = Fake::new(vec![process("com.example.player", 1, false, true)]);
    assert!(scanner.scan(&mut fake, OWN_PID).unwrap().is_empty());
    assert!(
        !fake.read(3, "capturing"),
        "an old entry of the buffer was read"
    );
}

/// Input devices only: each one runs, idles, fails or is gone. Counts the reads.
#[derive(Default)]
struct Devices {
    /// (device, its answer); `None` fails the read.
    devices: Vec<(u32, Option<bool>)>,
    list_fails: bool,
    lists: usize,
    reads: Vec<u32>,
}

impl AudioProcesses for Devices {
    fn input_devices(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError> {
        self.lists += 1;
        list.clear();
        if self.list_fails {
            return Err(ScanError::InputFailed(-3));
        }
        list.extend(self.devices.iter().map(|(device, _)| *device));
        Ok(())
    }

    fn device_running(&mut self, device: u32) -> Result<bool, ScanError> {
        self.reads.push(device);
        match self.devices.iter().find(|(id, _)| *id == device) {
            Some((_, Some(running))) => Ok(*running),
            _ => Err(ScanError::InputFailed(-4)),
        }
    }

    fn processes(&mut self, _list: &mut Vec<u32>) -> Result<(), ScanError> {
        unreachable!("the gate never scans")
    }

    fn capturing(&mut self, _process: u32) -> Option<bool> {
        None
    }

    fn playing(&mut self, _process: u32) -> Option<bool> {
        None
    }

    fn pid(&mut self, _process: u32) -> Option<i32> {
        None
    }

    fn bundle_id(&mut self, _process: u32) -> Option<String> {
        None
    }
}

const T0: Duration = Duration::from_secs(100);

#[test]
fn any_input_device_opens_the_gate_not_only_the_default() {
    // The built-in microphone (the default) idles; a USB microphone picked in the call app runs.
    let mut audio = Devices {
        devices: vec![(40, Some(false)), (73, Some(true))],
        ..Devices::default()
    };
    let mut gate = Gate::new();
    assert_eq!(gate.open(&mut audio, T0), Ok(true));
    assert_eq!(gate.devices(), [40, 73]);
    audio.devices[1].1 = Some(false);
    assert_eq!(
        gate.open(&mut audio, T0 + Duration::from_secs(2)),
        Ok(false)
    );
}

#[test]
fn no_input_device_means_a_closed_gate() {
    let mut audio = Devices::default();
    assert_eq!(Gate::new().open(&mut audio, T0), Ok(false));
}

#[test]
fn the_device_list_is_read_again_every_30_s() {
    let mut audio = Devices {
        devices: vec![(40, Some(false))],
        ..Devices::default()
    };
    let mut gate = Gate::new();
    let mut now = T0;
    while now < T0 + DEVICE_LIST_REFRESH {
        gate.open(&mut audio, now).unwrap();
        now += Duration::from_secs(2);
    }
    assert_eq!(audio.lists, 1, "one list for 30 s of ticks");
    assert_eq!(audio.reads.len(), 15, "one read per device per tick");
    // A headset plugged in: seen once the list is read again.
    audio.devices.push((90, Some(true)));
    assert_eq!(gate.open(&mut audio, now), Ok(true));
    assert_eq!(audio.lists, 2);
}

#[test]
fn a_failed_read_says_so_and_reads_the_list_again_next_time() {
    let mut audio = Devices {
        devices: vec![(40, Some(false)), (73, None)],
        ..Devices::default()
    };
    let mut gate = Gate::new();
    assert_eq!(gate.open(&mut audio, T0), Err(ScanError::InputFailed(-4)));
    assert_eq!(audio.lists, 1);
    // The device was unplugged: the next call reads the list again and the gate answers.
    audio.devices.pop();
    assert_eq!(
        gate.open(&mut audio, T0 + Duration::from_secs(2)),
        Ok(false)
    );
    assert_eq!(audio.lists, 2);
    assert_eq!(
        gate.open(&mut audio, T0 + Duration::from_secs(4)),
        Ok(false)
    );
    assert_eq!(audio.lists, 2);
}

#[test]
fn a_running_device_wins_over_a_failed_one() {
    let mut audio = Devices {
        devices: vec![(73, None), (40, Some(true))],
        ..Devices::default()
    };
    assert_eq!(Gate::new().open(&mut audio, T0), Ok(true));
}

#[test]
fn a_failed_device_list_is_an_error_and_is_tried_again() {
    let mut audio = Devices {
        devices: vec![(40, Some(true))],
        list_fails: true,
        ..Devices::default()
    };
    let mut gate = Gate::new();
    assert_eq!(gate.open(&mut audio, T0), Err(ScanError::InputFailed(-3)));
    audio.list_fails = false;
    assert_eq!(gate.open(&mut audio, T0 + Duration::from_secs(2)), Ok(true));
    assert_eq!(audio.lists, 2);
}

/// A Mac with many audio processes: unlisted players, a dictation tool, and the call apps at
/// fixed places (Zoom at 10, Slack at 11, Chrome's audio helper at 12).
fn busy_mac() -> Fake {
    let mut list: Vec<Process> = (0..10)
        .map(|n| process("com.example.player", 500 + n, false, true))
        .collect();
    list.push(process("us.zoom.xos", 100, false, false));
    list.push(process("com.tinyspeck.slackmacgap", 101, false, false));
    list.push(process("com.google.Chrome.helper", 102, false, false));
    list.push(process("com.example.dictation", 103, false, false));
    Fake::new(list)
}

const ZOOM_OBJECT: usize = 10;
const SLACK_OBJECT: usize = 11;
const DICTATION_OBJECT: usize = 13;

fn capturing(bundle_id: &'static str, pid: i32) -> Process {
    process(bundle_id, pid, true, false)
}

#[test]
fn a_followed_call_reads_only_its_own_objects_between_full_scans() {
    let mut fake = busy_mac();
    fake.set(ZOOM_OBJECT, capturing("us.zoom.xos", 100));
    let mut mic = Mic::new();
    let look = mic.look(&mut fake, OWN_PID, false, T0);
    assert_eq!(look.pass, Pass::Full, "the gate opened");
    assert_eq!(look.objects, 14);
    assert_eq!(look.heard, Some(vec![entry("us.zoom.xos", false)]));
    assert_eq!(mic.followed_objects(), 1);
    // The session follows the call now: each tick reads Zoom's one object.
    let mut now = T0;
    for _ in 0..6 {
        now += Duration::from_secs(2);
        fake.reset();
        let look = mic.look(&mut fake, OWN_PID, true, now);
        assert_eq!(look.pass, Pass::Followed, "at {now:?}");
        assert_eq!(look.heard, Some(vec![entry("us.zoom.xos", false)]));
        assert_eq!(fake.lists, 0);
        assert_eq!(fake.total(), 1, "one read: Zoom's input flag");
        assert_eq!(fake.count(ZOOM_OBJECT as u32, "capturing"), 1);
    }
    // At the full scan's pace after the last one, a full one.
    now = T0 + FULL_SCAN_FOLLOWING;
    let look = mic.look(&mut fake, OWN_PID, true, now);
    assert_eq!(look.pass, Pass::Full);
}

#[test]
fn full_scans_come_every_10_s_with_the_gate_open_and_every_15_s_while_a_call_is_followed() {
    let count_full = |following: bool, seconds: u64| {
        let mut fake = busy_mac();
        if following {
            fake.set(ZOOM_OBJECT, capturing("us.zoom.xos", 100));
        }
        let mut mic = Mic::new();
        let mut full = 0;
        let mut now = T0;
        while now < T0 + Duration::from_secs(seconds) {
            if mic.look(&mut fake, OWN_PID, following, now).pass == Pass::Full {
                full += 1;
            }
            now += Duration::from_secs(2);
        }
        full
    };
    assert_eq!(count_full(false, 60), 6, "one per 10 s");
    assert_eq!(count_full(true, 60), 5, "one per 14 s");
    assert_eq!(FULL_SCAN_IDLE.as_secs(), 10);
}

#[test]
fn a_followed_object_that_disappears_is_dropped_and_a_full_scan_runs_at_once() {
    let mut fake = busy_mac();
    fake.set(ZOOM_OBJECT, capturing("us.zoom.xos", 100));
    let mut mic = Mic::new();
    mic.look(&mut fake, OWN_PID, false, T0);
    // Zoom quits: its object can no longer be read.
    fake.set(ZOOM_OBJECT, Process::default());
    let look = mic.look(&mut fake, OWN_PID, true, T0 + Duration::from_secs(2));
    assert_eq!(look.pass, Pass::Full);
    assert_eq!(look.heard, Some(Vec::new()));
    assert_eq!(mic.followed_objects(), 0);
    // The next tick does not scan again.
    let look = mic.look(&mut fake, OWN_PID, true, T0 + Duration::from_secs(4));
    assert_eq!(look.pass, Pass::Followed);
}

#[test]
fn a_second_app_that_starts_capturing_is_heard_within_15_s() {
    let mut fake = busy_mac();
    fake.set(ZOOM_OBJECT, capturing("us.zoom.xos", 100));
    let mut mic = Mic::new();
    mic.look(&mut fake, OWN_PID, false, T0);
    fake.set(SLACK_OBJECT, capturing("com.tinyspeck.slackmacgap", 101));
    let mut now = T0;
    let heard_at = loop {
        now += Duration::from_secs(2);
        let look = mic.look(&mut fake, OWN_PID, true, now);
        if look
            .heard
            .unwrap()
            .contains(&entry("com.tinyspeck.slackmacgap", false))
        {
            break now;
        }
        assert!(now < T0 + Duration::from_secs(60));
    };
    assert!(
        heard_at - T0 <= Duration::from_secs(15),
        "{:?}",
        heard_at - T0
    );
    assert_eq!(mic.followed_objects(), 2);
}

#[test]
fn a_process_known_to_be_no_call_app_is_not_read_again() {
    let mut fake = busy_mac();
    fake.set(DICTATION_OBJECT, capturing("com.example.dictation", 103));
    let mut mic = Mic::new();
    mic.look(&mut fake, OWN_PID, false, T0);
    assert_eq!(fake.count(DICTATION_OBJECT as u32, "bundle_id"), 1);
    fake.reset();
    let look = mic.look(&mut fake, OWN_PID, false, T0 + FULL_SCAN_IDLE);
    assert_eq!(look.pass, Pass::Full);
    assert_eq!(fake.count(DICTATION_OBJECT as u32, "capturing"), 0);
    assert_eq!(fake.count(DICTATION_OBJECT as u32, "bundle_id"), 0);
    // One read per other object: the input flag.
    assert_eq!(fake.total(), 13);
}

#[test]
fn an_identified_call_app_is_not_identified_again() {
    let mut fake = busy_mac();
    fake.set(ZOOM_OBJECT, capturing("us.zoom.xos", 100));
    let mut mic = Mic::with_full_every(Duration::from_secs(2));
    mic.look(&mut fake, OWN_PID, false, T0);
    fake.reset();
    let look = mic.look(&mut fake, OWN_PID, true, T0 + Duration::from_secs(2));
    assert_eq!(look.pass, Pass::Full);
    assert_eq!(fake.count(ZOOM_OBJECT as u32, "bundle_id"), 0);
    assert_eq!(fake.count(ZOOM_OBJECT as u32, "pid"), 0);
    assert_eq!(look.heard, Some(vec![entry("us.zoom.xos", false)]));
}

#[test]
fn a_closed_gate_with_no_call_reads_no_process() {
    let mut audio = Devices {
        devices: vec![(40, Some(false))],
        ..Devices::default()
    };
    let mut mic = Mic::new();
    for n in 0..10 {
        let look = mic.look(&mut audio, OWN_PID, false, T0 + Duration::from_secs(2 * n));
        assert_eq!(look.pass, Pass::GateOnly);
    }
    assert_eq!(
        audio.reads.len(),
        10,
        "one device read per tick, nothing else"
    );
}
