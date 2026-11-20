//! Which call apps capture audio now, read from CoreAudio's process objects.
//!
//! Three kinds of pass, the cheapest first; [`Mic::look`] picks one per tick:
//! 1. The gate ([`Gate::open`]), on every tick: whether any audio device with input streams runs
//!    for some process (`kAudioDevicePropertyDeviceIsRunningSomewhere`), so a microphone picked
//!    inside a call app counts as much as the system default. One read per input device. The
//!    list of input devices (`kAudioHardwarePropertyDevices`, kept when
//!    `kAudioDevicePropertyStreams` has input streams) is cached and read again every
//!    [`DEVICE_LIST_REFRESH`], or on the next tick after a read failed (a device was unplugged).
//!    No input device means nothing is in use. A closed gate with no call followed ends the tick
//!    there.
//! 2. The followed pass ([`Scanner::followed`]): only the process objects of the call apps a
//!    full scan saw capturing, each asked whether it captures (`kAudioProcessPropertyIsRunningInput`)
//!    and, for a browser, whether it plays (`…IsRunningOutput`). An object that cannot be read
//!    (its process ended) is dropped and a full scan runs at once.
//! 3. The full scan ([`Scanner::scan`]): the list of CoreAudio process objects
//!    (`kAudioHardwarePropertyProcessObjectList`, one read into a buffer kept from scan to scan)
//!    and for each one whether it captures. For capturing processes only, the process id
//!    (`…PID`) and the bundle id (`…BundleID`), once per process: the table entry it maps to (or
//!    "none") is kept by object id until the object leaves the list, and an object known to be
//!    no call app is not asked again. It runs when the gate opens, then every
//!    [`FULL_SCAN_IDLE`] while the gate is open and no call is followed, and every
//!    [`FULL_SCAN_FOLLOWING`] (14 s) while a call is followed (to notice a second app within
//!    15 s). Never more often, except once after a followed object failed.
//!
//! Budget, from the owner's Mac (macOS 26.3, many audio-capable processes): a full scan took a
//! median of 65 ms idle and 107 ms (worst 211 ms) during a Meet call, one read per process object.
//! The target is a followed pass under 5 ms (a few reads), and at most one full scan per 10 to
//! 15 s. `examples/mic_apps.rs` prints the kind and the time of every pass.
//!
//! No device is opened, no audio is read and macOS asks for no permission. A bundle id that is
//! not in [`crate::apps`] is dropped as soon as it is compared; only table entries are kept or
//! returned. This process is skipped, so the app's own recording never looks like a call.
//!
//! [`AudioProcesses`] is the seam: [`CoreAudio`] on a Mac, a fake in tests. On other platforms
//! [`CoreAudio`] answers [`ScanError::Unsupported`].

use crate::apps::{self, AppId, Kind};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long the gate keeps its list of input devices before it reads the list again.
pub const DEVICE_LIST_REFRESH: Duration = Duration::from_secs(30);
/// The full scan's pace while the gate is open and no call is followed.
pub const FULL_SCAN_IDLE: Duration = Duration::from_secs(10);
/// The full scan's pace while a call is followed: 14 s, so that with the 2 s tick a second app
/// that starts to capture is heard within 15 s, well within [`crate::session::CALL_END`].
pub const FULL_SCAN_FOLLOWING: Duration = Duration::from_secs(14);

/// The CoreAudio reads the watcher needs. Each read of one process may fail on its own (the
/// process may have ended since the list was read); a failed read is `None`.
pub trait AudioProcesses {
    /// The audio devices that have input streams, written over `list`.
    fn input_devices(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError>;
    /// Whether the device runs for any process. A device that is gone is an error.
    fn device_running(&mut self, device: u32) -> Result<bool, ScanError>;
    /// The process objects that CoreAudio knows now, written over `list`.
    fn processes(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError>;
    /// Whether the process captures audio now.
    fn capturing(&mut self, process: u32) -> Option<bool>;
    /// Whether the process plays audio now.
    fn playing(&mut self, process: u32) -> Option<bool>;
    /// The process id.
    fn pid(&mut self, process: u32) -> Option<i32>;
    /// The bundle id. Many system processes have none.
    fn bundle_id(&mut self, process: u32) -> Option<String>;
}

/// Why a read has no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanError {
    /// Not a Mac.
    Unsupported,
    /// CoreAudio returned this status for the process list.
    Failed(i32),
    /// CoreAudio returned this status for the list of input devices or a device's state.
    InputFailed(i32),
}

impl ScanError {
    /// For the app's log.
    pub fn as_str(self) -> &'static str {
        match self {
            ScanError::Unsupported => "unsupported",
            ScanError::Failed(_) => "process_list_failed",
            ScanError::InputFailed(_) => "input_device_failed",
        }
    }
}

/// A call app heard in a scan: one of its processes captures audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Heard {
    pub app: AppId,
    /// One of its capturing processes also plays audio.
    pub playing: bool,
}

/// The gate before a scan, with its cached list of input devices.
#[derive(Debug, Default)]
pub struct Gate {
    devices: Vec<u32>,
    listed_at: Option<Duration>,
    stale: bool,
}

impl Gate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether any input device runs for some process. `now` is the watcher's clock: the list
    /// of devices is read again when it is [`DEVICE_LIST_REFRESH`] old, and on the call after a
    /// read failed. An error means the gate cannot tell; the watcher then scans.
    pub fn open<A: AudioProcesses + ?Sized>(
        &mut self,
        audio: &mut A,
        now: Duration,
    ) -> Result<bool, ScanError> {
        let due = self.stale
            || self
                .listed_at
                .is_none_or(|at| now.saturating_sub(at) >= DEVICE_LIST_REFRESH);
        if due {
            if let Err(error) = audio.input_devices(&mut self.devices) {
                self.devices.clear();
                self.stale = true;
                return Err(error);
            }
            self.listed_at = Some(now);
            self.stale = false;
        }
        let mut failure = None;
        for &device in &self.devices {
            match audio.device_running(device) {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(error) => {
                    self.stale = true;
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(false), Err)
    }

    /// The input devices the gate asks, from its last list.
    pub fn devices(&self) -> &[u32] {
        &self.devices
    }
}

/// The full scan and the followed pass, with what they keep between ticks: the process-list
/// buffer, the table entry of each process object identified so far, and the objects followed.
#[derive(Debug, Default)]
pub struct Scanner {
    list: Vec<u32>,
    /// Object id to table entry; `None`: no call app (or this process), never asked again.
    entries: HashMap<u32, Option<AppId>>,
    /// The objects of call apps a full scan saw capturing, while they stay in the list.
    followed: Vec<(u32, AppId)>,
}

/// Whether a capturing object of `app` also plays, read only where the rule needs it.
fn heard_entry<A: AudioProcesses + ?Sized>(audio: &mut A, object: u32, app: AppId) -> Heard {
    let playing = app.kind() == Kind::Browser && audio.playing(object) == Some(true);
    Heard { app, playing }
}

fn add(heard: &mut Vec<Heard>, entry: Heard) {
    match heard.iter_mut().find(|known| known.app == entry.app) {
        Some(known) => known.playing |= entry.playing,
        None => heard.push(entry),
    }
}

impl Scanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// The process objects followed between full scans.
    pub fn followed_objects(&self) -> usize {
        self.followed.len()
    }

    /// The full scan: the call apps that capture audio now, one entry per app, in table order.
    ///
    /// `own_pid` is this process: it is skipped. A process is asked whether it captures, and
    /// nothing else unless it does; a capturing process is identified once (pid, bundle id) and
    /// its table entry kept until it leaves the list. An object known to be no call app is not
    /// read at all.
    pub fn scan<A: AudioProcesses + ?Sized>(
        &mut self,
        audio: &mut A,
        own_pid: i32,
    ) -> Result<Vec<Heard>, ScanError> {
        if let Err(error) = audio.processes(&mut self.list) {
            self.list.clear();
            return Err(error);
        }
        self.list.sort_unstable();
        let list = &self.list;
        self.entries
            .retain(|object, _| list.binary_search(object).is_ok());
        self.followed
            .retain(|(object, _)| list.binary_search(object).is_ok());
        let mut heard: Vec<Heard> = Vec::new();
        for &object in &self.list {
            let known = self.entries.get(&object).copied();
            if known == Some(None) {
                continue;
            }
            if audio.capturing(object) != Some(true) {
                continue;
            }
            let app = match known {
                Some(Some(app)) => app,
                _ => match identify(audio, object, own_pid) {
                    Some(entry) => {
                        self.entries.insert(object, entry);
                        match entry {
                            Some(app) => app,
                            None => continue,
                        }
                    }
                    // No bundle id this time: asked again on the next full scan.
                    None => continue,
                },
            };
            if !self
                .followed
                .iter()
                .any(|(followed, _)| *followed == object)
            {
                self.followed.push((object, app));
            }
            add(&mut heard, heard_entry(audio, object, app));
        }
        heard.sort_by_key(|entry| entry.app);
        Ok(heard)
    }

    /// The followed pass: only the objects a full scan saw capturing. `Err(())` when one of them
    /// could not be read (its process ended): it is dropped, and the caller runs a full scan.
    #[allow(clippy::result_unit_err)]
    pub fn followed<A: AudioProcesses + ?Sized>(
        &mut self,
        audio: &mut A,
    ) -> Result<Vec<Heard>, ()> {
        let mut heard: Vec<Heard> = Vec::new();
        let mut vanished = false;
        self.followed
            .retain(|&(object, app)| match audio.capturing(object) {
                None => {
                    vanished = true;
                    false
                }
                Some(true) => {
                    add(&mut heard, heard_entry(audio, object, app));
                    true
                }
                Some(false) => true,
            });
        if vanished {
            return Err(());
        }
        heard.sort_by_key(|entry| entry.app);
        Ok(heard)
    }
}

/// The table entry of a capturing object: `Some(None)` for this process or a process that is no
/// call app (kept), `None` when its bundle id could not be read (asked again later). The id is
/// compared and dropped here; only the table entry leaves.
fn identify<A: AudioProcesses + ?Sized>(
    audio: &mut A,
    object: u32,
    own_pid: i32,
) -> Option<Option<AppId>> {
    if audio.pid(object) == Some(own_pid) {
        return Some(None);
    }
    audio.bundle_id(object).map(|id| apps::lookup(&id))
}

/// One full scan with a fresh scanner; see [`Scanner::scan`].
pub fn scan<A: AudioProcesses + ?Sized>(
    audio: &mut A,
    own_pid: i32,
) -> Result<Vec<Heard>, ScanError> {
    Scanner::new().scan(audio, own_pid)
}

/// Which pass a look ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
    /// The gate was closed and no call is followed: nothing else was read.
    GateOnly,
    /// Only the followed objects were read.
    Followed,
    /// Every process object was read.
    Full,
}

impl Pass {
    pub const fn as_str(self) -> &'static str {
        match self {
            Pass::GateOnly => "gate",
            Pass::Followed => "followed",
            Pass::Full => "full",
        }
    }
}

/// What one look found.
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    /// The call apps heard. `None` when the full scan failed.
    pub heard: Option<Vec<Heard>>,
    /// The gate's answer.
    pub gate: Result<bool, ScanError>,
    /// A failure for the log: the full scan's, else the gate's.
    pub error: Option<ScanError>,
    pub pass: Pass,
    /// The time the gate took, and the time the pass took after it.
    pub gate_took: Duration,
    pub took: Duration,
    /// The process objects the pass read: the whole list for a full scan, the followed ones for
    /// a followed pass.
    pub objects: usize,
}

/// The gate, the followed pass and the full scan, with their pace. One [`Mic::look`] per tick.
#[derive(Debug, Default)]
pub struct Mic {
    gate: Gate,
    scanner: Scanner,
    last_full: Option<Duration>,
    full_every: Option<Duration>,
}

impl Mic {
    pub fn new() -> Self {
        Self::default()
    }

    /// A full scan every `every` whatever happens, for `mic_apps --full-every`.
    pub fn with_full_every(every: Duration) -> Self {
        Mic {
            full_every: Some(every),
            ..Self::default()
        }
    }

    pub fn gate(&self) -> &Gate {
        &self.gate
    }

    pub fn followed_objects(&self) -> usize {
        self.scanner.followed_objects()
    }

    /// One tick's look. `following`: the session follows a call app. `now` is the watcher's
    /// clock.
    pub fn look<A: AudioProcesses + ?Sized>(
        &mut self,
        audio: &mut A,
        own_pid: i32,
        following: bool,
        now: Duration,
    ) -> Look {
        let started = Instant::now();
        let gate = self.gate.open(audio, now);
        let gate_took = started.elapsed();
        let mut look = Look {
            heard: Some(Vec::new()),
            gate,
            error: gate.err(),
            pass: Pass::GateOnly,
            gate_took,
            took: Duration::ZERO,
            objects: 0,
        };
        if gate == Ok(false) && !following {
            // The next opening scans at once.
            self.last_full = None;
            return look;
        }
        let every = self.full_every.unwrap_or(if following {
            FULL_SCAN_FOLLOWING
        } else {
            FULL_SCAN_IDLE
        });
        let due = self
            .last_full
            .is_none_or(|at| now.saturating_sub(at) >= every);
        let started = Instant::now();
        if !due {
            look.objects = self.scanner.followed_objects();
            if let Ok(heard) = self.scanner.followed(audio) {
                look.pass = Pass::Followed;
                look.heard = Some(heard);
                look.took = started.elapsed();
                return look;
            }
        }
        self.last_full = Some(now);
        look.pass = Pass::Full;
        match self.scanner.scan(audio, own_pid) {
            Ok(heard) => look.heard = Some(heard),
            Err(error) => {
                look.heard = None;
                look.error = Some(error);
            }
        }
        look.objects = self.scanner.list.len();
        look.took = started.elapsed();
        look
    }
}

/// The system's CoreAudio process objects.
#[derive(Clone, Copy, Debug, Default)]
pub struct CoreAudio;

/// True where [`CoreAudio`] can read anything (macOS).
pub const SUPPORTED: bool = cfg!(target_os = "macos");

impl CoreAudio {
    /// Whether the device also has output streams (a headset), for `mic_apps`. `false` off a
    /// Mac.
    pub fn device_plays(&self, device: u32) -> bool {
        #[cfg(target_os = "macos")]
        return imp::has_streams(device, imp::OUTPUT_SCOPE);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = device;
            false
        }
    }
}

#[cfg(target_os = "macos")]
impl AudioProcesses for CoreAudio {
    fn input_devices(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError> {
        imp::input_devices(list).map_err(ScanError::InputFailed)
    }

    fn device_running(&mut self, device: u32) -> Result<bool, ScanError> {
        imp::device_running(device).map_err(ScanError::InputFailed)
    }

    fn processes(&mut self, list: &mut Vec<u32>) -> Result<(), ScanError> {
        imp::processes(list).map_err(ScanError::Failed)
    }

    fn capturing(&mut self, process: u32) -> Option<bool> {
        imp::u32_property(process, imp::IS_RUNNING_INPUT).map(|value| value != 0)
    }

    fn playing(&mut self, process: u32) -> Option<bool> {
        imp::u32_property(process, imp::IS_RUNNING_OUTPUT).map(|value| value != 0)
    }

    fn pid(&mut self, process: u32) -> Option<i32> {
        imp::u32_property(process, imp::PID).map(|value| value as i32)
    }

    fn bundle_id(&mut self, process: u32) -> Option<String> {
        imp::bundle_id(process)
    }
}

#[cfg(not(target_os = "macos"))]
impl AudioProcesses for CoreAudio {
    fn input_devices(&mut self, _list: &mut Vec<u32>) -> Result<(), ScanError> {
        Err(ScanError::Unsupported)
    }

    fn device_running(&mut self, _device: u32) -> Result<bool, ScanError> {
        Err(ScanError::Unsupported)
    }

    fn processes(&mut self, _list: &mut Vec<u32>) -> Result<(), ScanError> {
        Err(ScanError::Unsupported)
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

/// The CoreAudio and CoreFoundation functions, declared by hand as the recorder's engine does
/// (`desktop/src-tauri/src/recorder/engine.rs`, `core_audio_inputs`).
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod imp {
    use std::ffi::{c_void, CStr};

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object_id: u32,
            address: *const AudioObjectPropertyAddress,
            qualifier_data_size: u32,
            qualifier_data: *const c_void,
            data_size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            object_id: u32,
            address: *const AudioObjectPropertyAddress,
            qualifier_data_size: u32,
            qualifier_data: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringGetCString(
            value: *const c_void,
            buffer: *mut i8,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(value: *const c_void);
    }

    /// `kAudioObjectSystemObject`.
    const SYSTEM_OBJECT: u32 = 1;
    /// `kAudioObjectPropertyScopeGlobal`.
    const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    /// `kAudioObjectPropertyElementMain`.
    const MAIN: u32 = 0;
    /// `kCFStringEncodingUTF8`.
    const UTF8: u32 = 0x0800_0100;
    /// `kAudioObjectPropertyScopeInput`.
    const INPUT_SCOPE: u32 = u32::from_be_bytes(*b"inpt");
    /// `kAudioObjectPropertyScopeOutput`.
    pub const OUTPUT_SCOPE: u32 = u32::from_be_bytes(*b"outp");
    /// `kAudioHardwarePropertyDevices`.
    const DEVICES: [u8; 4] = *b"dev#";
    /// `kAudioDevicePropertyStreams`.
    const STREAMS: [u8; 4] = *b"stm#";
    /// `kAudioDevicePropertyDeviceIsRunningSomewhere`.
    const RUNNING_SOMEWHERE: [u8; 4] = *b"gone";
    /// `kAudioHardwarePropertyProcessObjectList`.
    const PROCESS_OBJECT_LIST: [u8; 4] = *b"prs#";
    /// `kAudioProcessPropertyPID`.
    pub const PID: [u8; 4] = *b"ppid";
    /// `kAudioProcessPropertyBundleID`.
    const BUNDLE_ID: [u8; 4] = *b"pbid";
    /// `kAudioProcessPropertyIsRunningInput`.
    pub const IS_RUNNING_INPUT: [u8; 4] = *b"piri";
    /// `kAudioProcessPropertyIsRunningOutput`.
    pub const IS_RUNNING_OUTPUT: [u8; 4] = *b"piro";
    /// Room kept in the list buffer for processes that appear between two scans.
    const LIST_SLACK: usize = 32;

    fn property(selector: [u8; 4]) -> AudioObjectPropertyAddress {
        property_in(selector, GLOBAL)
    }

    fn property_in(selector: [u8; 4], scope: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            selector: u32::from_be_bytes(selector),
            scope,
            element: MAIN,
        }
    }

    /// The audio devices with input streams, written over `list`.
    pub fn input_devices(list: &mut Vec<u32>) -> Result<(), i32> {
        list.clear();
        let address = property(DEVICES);
        let mut size = 0u32;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size)
        };
        if status != 0 {
            return Err(status);
        }
        let item = std::mem::size_of::<u32>();
        let mut devices = vec![0u32; size as usize / item];
        let mut size = (devices.len() * item) as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                devices.as_mut_ptr() as *mut c_void,
            )
        };
        if status != 0 {
            return Err(status);
        }
        devices.truncate(size as usize / item);
        list.extend(
            devices
                .into_iter()
                .filter(|&device| has_streams(device, INPUT_SCOPE)),
        );
        Ok(())
    }

    /// Whether the device has streams in this scope (input or output).
    pub fn has_streams(device: u32, scope: u32) -> bool {
        let address = property_in(STREAMS, scope);
        let mut size = 0u32;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(device, &address, 0, std::ptr::null(), &mut size)
        };
        status == 0 && size > 0
    }

    /// Whether the device runs for some process.
    pub fn device_running(device: u32) -> Result<bool, i32> {
        Ok(u32_value(device, RUNNING_SOMEWHERE)? != 0)
    }

    /// The process list, written over `list`. One read when the buffer from the last scan is big
    /// enough; otherwise the size, then the list.
    pub fn processes(list: &mut Vec<u32>) -> Result<(), i32> {
        let item = std::mem::size_of::<u32>();
        let address = property(PROCESS_OBJECT_LIST);
        let capacity = list.capacity().max(LIST_SLACK);
        list.clear();
        list.resize(capacity, 0);
        let mut size = (list.len() * item) as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                list.as_mut_ptr() as *mut c_void,
            )
        };
        if status == 0 && (size as usize) < list.len() * item {
            list.truncate(size as usize / item);
            return Ok(());
        }
        // A full buffer may have cut the list short: read its size and read it again.
        let mut needed = 0u32;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                &mut needed,
            )
        };
        if status != 0 {
            list.clear();
            return Err(status);
        }
        list.clear();
        list.resize(needed as usize / item + LIST_SLACK, 0);
        let mut size = (list.len() * item) as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                list.as_mut_ptr() as *mut c_void,
            )
        };
        if status != 0 {
            list.clear();
            return Err(status);
        }
        list.truncate(size as usize / item);
        Ok(())
    }

    /// A 32-bit property of any object, with its status.
    fn u32_value(object: u32, selector: [u8; 4]) -> Result<u32, i32> {
        let address = property(selector);
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                &mut value as *mut u32 as *mut c_void,
            )
        };
        if status != 0 {
            return Err(status);
        }
        Ok(value)
    }

    /// A 32-bit property of one process object: a flag or the process id.
    pub fn u32_property(process: u32, selector: [u8; 4]) -> Option<u32> {
        u32_value(process, selector).ok()
    }

    /// The bundle id of one process object. CoreAudio returns a retained string; it is released
    /// here.
    pub fn bundle_id(process: u32) -> Option<String> {
        let address = property(BUNDLE_ID);
        let mut value: *const c_void = std::ptr::null();
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                process,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                &mut value as *mut *const c_void as *mut c_void,
            )
        };
        if status != 0 || value.is_null() {
            return None;
        }
        let mut buffer = [0i8; 512];
        let converted =
            unsafe { CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
        unsafe { CFRelease(value) };
        if converted == 0 {
            return None;
        }
        unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_str()
            .ok()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod mac_tests {
    use super::*;

    /// The macOS CI job: the functions link and one real scan answers. The runner has no call
    /// app, so the answer itself is not checked.
    #[test]
    fn a_real_scan_answers() {
        let started = std::time::Instant::now();
        let gate = Gate::new().open(&mut CoreAudio, Duration::ZERO);
        eprintln!("the gate took {:?}: {gate:?}", started.elapsed());
        assert!(gate.is_ok(), "{gate:?}");
        let mut scanner = Scanner::new();
        for _ in 0..2 {
            let started = std::time::Instant::now();
            let result = scanner.scan(&mut CoreAudio, std::process::id() as i32);
            assert!(result.is_ok(), "{result:?}");
            eprintln!("one full scan took {:?}", started.elapsed());
        }
        let mut mic = Mic::new();
        for second in 0..3 {
            let look = mic.look(
                &mut CoreAudio,
                std::process::id() as i32,
                true,
                Duration::from_secs(2 * second),
            );
            assert!(look.heard.is_some(), "{look:?}");
            eprintln!(
                "look: {} pass in {:?}, {} objects",
                look.pass.as_str(),
                look.took,
                look.objects
            );
        }
    }
}
