//! Which call apps capture audio now, read from CoreAudio's process objects.
//!
//! Two reads, the cheap one first:
//! 1. The gate ([`Gate::open`]): whether any audio device with input streams runs for some
//!    process (`kAudioDevicePropertyDeviceIsRunningSomewhere`), so a microphone picked inside a
//!    call app counts as much as the system default. One read per input device. The list of
//!    input devices (`kAudioHardwarePropertyDevices`, kept when `kAudioDevicePropertyStreams` has
//!    input streams) is cached and read again every [`DEVICE_LIST_REFRESH`], or on the next tick
//!    after a read failed (a device was unplugged). No input device means nothing is in use.
//!    A device that also plays (a USB headset) opens the gate when it only plays; the watcher
//!    then scans less often (`service`).
//! 2. The scan ([`Scanner::scan`]), only when the gate is open or a call is being followed (the
//!    watcher decides, `service`): the list of CoreAudio process objects
//!    (`kAudioHardwarePropertyProcessObjectList`) and for each one whether it captures
//!    (`kAudioProcessPropertyIsRunningInput`); for capturing processes only, the process id
//!    (`…PID`), the bundle id (`…BundleID`) and whether it plays (`…IsRunningOutput`). The list
//!    is read into a buffer kept from scan to scan.
//!
//! No device is opened, no audio is read and macOS asks for no permission. A bundle id that is
//! not in [`crate::apps`] is dropped as soon as it is compared; a scan returns table entries
//! only. This process is skipped, so the app's own recording never looks like a call.
//!
//! [`AudioProcesses`] is the seam: [`CoreAudio`] on a Mac, a fake in tests. On other platforms
//! [`CoreAudio`] answers [`ScanError::Unsupported`].

use crate::apps::{self, AppId};
use std::time::Duration;

/// How long the gate keeps its list of input devices before it reads the list again.
pub const DEVICE_LIST_REFRESH: Duration = Duration::from_secs(30);

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

/// Scans with one process-list buffer, kept from scan to scan.
#[derive(Debug, Default)]
pub struct Scanner {
    list: Vec<u32>,
}

impl Scanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// The call apps that capture audio now, one entry per app, in table order.
    ///
    /// `own_pid` is this process: it is skipped. Processes that do not capture are not asked for
    /// anything else.
    pub fn scan<A: AudioProcesses + ?Sized>(
        &mut self,
        audio: &mut A,
        own_pid: i32,
    ) -> Result<Vec<Heard>, ScanError> {
        audio.processes(&mut self.list)?;
        let mut heard: Vec<Heard> = Vec::new();
        for &process in &self.list {
            if audio.capturing(process) != Some(true) {
                continue;
            }
            if audio.pid(process) == Some(own_pid) {
                continue;
            }
            // The id is compared and dropped here; only the table entry leaves this block.
            let Some(app) = audio.bundle_id(process).and_then(|id| apps::lookup(&id)) else {
                continue;
            };
            let playing = audio.playing(process) == Some(true);
            match heard.iter_mut().find(|entry| entry.app == app) {
                Some(entry) => entry.playing |= playing,
                None => heard.push(Heard { app, playing }),
            }
        }
        heard.sort_by_key(|entry| entry.app);
        Ok(heard)
    }
}

/// One scan with a fresh buffer; see [`Scanner::scan`].
pub fn scan<A: AudioProcesses + ?Sized>(
    audio: &mut A,
    own_pid: i32,
) -> Result<Vec<Heard>, ScanError> {
    Scanner::new().scan(audio, own_pid)
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
            eprintln!("one scan took {:?}", started.elapsed());
        }
    }
}
