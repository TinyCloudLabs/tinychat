//! Which call apps capture audio now, read from CoreAudio's process objects.
//!
//! One scan reads:
//! - the list of CoreAudio process objects (`kAudioHardwarePropertyProcessObjectList`), and for
//!   each one whether it captures (`kAudioProcessPropertyIsRunningInput`);
//! - for capturing processes only: the process id (`…PID`), the bundle id (`…BundleID`) and
//!   whether it plays (`…IsRunningOutput`).
//!
//! No device is opened, no audio is read and macOS asks for no permission. A bundle id that is
//! not in [`crate::apps`] is dropped as soon as it is compared; a scan returns table entries
//! only. This process is skipped, so the app's own recording never looks like a call.
//!
//! [`AudioProcesses`] is the seam: [`CoreAudio`] on a Mac, a fake in tests. On other platforms
//! [`CoreAudio`] answers [`ScanError::Unsupported`].

use crate::apps::{self, AppId};

/// The CoreAudio reads one scan needs. Each read of one process may fail on its own (the process
/// may have ended since the list was read); a failed read is `None`.
pub trait AudioProcesses {
    /// The process objects that CoreAudio knows now.
    fn processes(&mut self) -> Result<Vec<u32>, ScanError>;
    /// Whether the process captures audio now.
    fn capturing(&mut self, process: u32) -> Option<bool>;
    /// Whether the process plays audio now.
    fn playing(&mut self, process: u32) -> Option<bool>;
    /// The process id.
    fn pid(&mut self, process: u32) -> Option<i32>;
    /// The bundle id. Many system processes have none.
    fn bundle_id(&mut self, process: u32) -> Option<String>;
}

/// Why a scan has no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanError {
    /// Not a Mac.
    Unsupported,
    /// CoreAudio returned this status for the process list.
    Failed(i32),
}

impl ScanError {
    /// For the app's log.
    pub fn as_str(self) -> &'static str {
        match self {
            ScanError::Unsupported => "unsupported",
            ScanError::Failed(_) => "process_list_failed",
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

/// The call apps that capture audio now, one entry per app, in table order.
///
/// `own_pid` is this process: it is skipped. Processes that do not capture are not asked for
/// anything else.
pub fn scan<A: AudioProcesses + ?Sized>(
    audio: &mut A,
    own_pid: i32,
) -> Result<Vec<Heard>, ScanError> {
    let mut heard: Vec<Heard> = Vec::new();
    for process in audio.processes()? {
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

/// The system's CoreAudio process objects.
#[derive(Clone, Copy, Debug, Default)]
pub struct CoreAudio;

/// True where [`CoreAudio`] can read anything (macOS).
pub const SUPPORTED: bool = cfg!(target_os = "macos");

#[cfg(target_os = "macos")]
impl AudioProcesses for CoreAudio {
    fn processes(&mut self) -> Result<Vec<u32>, ScanError> {
        imp::processes().map_err(ScanError::Failed)
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
    fn processes(&mut self) -> Result<Vec<u32>, ScanError> {
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
    /// Room for processes that appear between reading the list's size and the list.
    const LIST_SLACK: usize = 16;

    fn property(selector: [u8; 4]) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            selector: u32::from_be_bytes(selector),
            scope: GLOBAL,
            element: MAIN,
        }
    }

    pub fn processes() -> Result<Vec<u32>, i32> {
        let address = property(PROCESS_OBJECT_LIST);
        let mut size = 0u32;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size)
        };
        if status != 0 {
            return Err(status);
        }
        let item = std::mem::size_of::<u32>();
        let mut list = vec![0u32; size as usize / item + LIST_SLACK];
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
            return Err(status);
        }
        list.truncate(size as usize / item);
        Ok(list)
    }

    /// A 32-bit property of one process object: a flag or the process id.
    pub fn u32_property(process: u32, selector: [u8; 4]) -> Option<u32> {
        let address = property(selector);
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                process,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                &mut value as *mut u32 as *mut c_void,
            )
        };
        (status == 0 && size as usize == std::mem::size_of::<u32>()).then_some(value)
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
        let result = scan(&mut CoreAudio, std::process::id() as i32);
        assert!(result.is_ok(), "{result:?}");
        eprintln!("one scan took {:?}", started.elapsed());
    }
}
