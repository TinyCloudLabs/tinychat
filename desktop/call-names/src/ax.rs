//! The macOS reader: finds the meeting window and reads it through the Accessibility API.
//!
//! Read-only. The reader never performs an action on another app's elements. The one value it
//! writes is Chromium's manual-accessibility flag on a browser's application element, which makes
//! the browser expose its page content. It writes that flag only on an allow-listed browser, only
//! when one of its windows is about to be searched for a Meet page, and only when the flag is off.
//! [`Reader::stop`] (and dropping the reader) turns it off again. Safari and every app outside the
//! allow-list are never touched.
//!
//! A tick has two phases, each on its own clock (see `driver`):
//!
//! 1. Search, at most [`SEARCH_BUDGET`], and only for an app with no known call window, every
//!    [`SEARCH_WAIT_TICKS`] ticks at most.
//!    - Zoom (`us.zoom.xos`): the window list and each window's identifier; the window with the
//!      identifier `zm.meeting.window.main` is the call window.
//!    - Allow-listed Chromium browsers: the window list and each window's title. A title is
//!      compared with [`MEET_WINDOW_TITLE_HINT`] and dropped; it is never kept or logged. Only a
//!      window whose title has the hint is walked, except Arc: its titles do not identify the
//!      selected tab, so every window is searched breadth-first to avoid its large sidebar.
//!      The search reads role and children only, not into toolbars or
//!      tab strips, down to the web areas and never into one. A web area's address is read, and
//!      the first one whose host is exactly `meet.google.com` is the call window. The address
//!      decides; the title only says where to look. Addresses stay in memory and are never logged.
//! 2. Reading, within the tick's own [`Budget`]. Each known call window is checked with one read
//!    (its address or its identifier) and then read by `extract`, with its staged text reads. A
//!    window that is no longer a call window, or whose call has ended, is forgotten.
//!
//! So a normal tick makes one round trip per known call window plus the page itself, however
//! many browsers, windows and tabs are open; and a search never takes time from a reading.
//!
//! Round trips. One per element for its structure (role, subrole, identifier and children
//! together), one for title and description together where a rule needs a label, one for a value
//! where a rule names a name. A web area's address is a read of its own, so that no address is
//! ever asked of an element that is not a page.
//!
//! Speaking (see `speaking`). In a reading that gave names, one `AXDOMClassList` per speaking
//! marker candidate, and `AXMinimized` and the title of the page's window. Between readings,
//! [`Reader::sample`] reads one `AXDOMClassList` per followed marker and nothing else, each marker
//! with a messaging timeout of [`crate::speaking::MARKER_TIMEOUT_SECONDS`], within
//! [`crate::speaking::SAMPLE_BUDGET`]. A class list becomes hashes at once; no class name is kept.
//!
//! Time. Every element gets a messaging timeout of [`MESSAGING_TIMEOUT_SECONDS`]. Each budget is
//! checked before each round trip, not only after it. Apps without a call window are touched only
//! in the search phase, so a browser that hangs there cannot cost the browser with the call its
//! tick; a search that fails or times out is tried again after [`SEARCH_WAIT_TICKS`] ticks. In
//! the reading, one slow answer costs that tick and nothing more: an app rests for
//! [`TIMEOUT_SKIP_TICKS`] ticks only after [`TIMEOUTS_BEFORE_REST`] ticks in a row with a timeout.
//!
//! Failed reads. A call that fails as a whole, or a role or children value that fails, discards
//! the tick ([`call_error`]); only "no value" and "attribute unsupported" mean "nothing here".
//! Other single values (texts, subrole, identifier, an address) use the lenient [`read_error`]:
//! an app that cannot give one has no value there.
//!
//! How to host a [`Reader`]:
//! - Call [`Reader::read`] once per tick. It runs both phases. Nothing else is needed.
//! - Create it, use it, stop it and drop it on one thread. It holds Accessibility elements, which
//!   must not move between threads; the type is not `Send`.
//! - Call [`Reader::stop`] when the recording stops and on the app's exit path. Dropping the
//!   reader does the same, but a process that exits without unwinding drops nothing.
//! - After a crash the flag cannot be put back: the browser keeps its accessibility mode until it
//!   restarts. A browser that has quit is forgotten at the next tick without a write, because its
//!   process id may belong to another process by then.
//! - Take each [`RunningApp`] from the operating system in one lookup; see its documentation.
//!
//! On other platforms this module is a stub: permission is [`Permission::Unsupported`] and every
//! tick returns [`NoNames::Unsupported`].
//!
//! The app list, hosts and bundle ids are code, not rules: a rules file cannot widen them.

use crate::extract::Extraction;
use crate::rules::App;
use crate::session::{Budget, Discard, Skip};
use crate::speaking::{Found, SampleRead};
use crate::tree::{Node, ReadError};
use serde::Serialize;
use std::time::Duration;

/// Zoom's bundle id.
pub const ZOOM_BUNDLE_ID: &str = "us.zoom.xos";
/// The identifier of Zoom's in-call window.
pub const ZOOM_MEETING_WINDOW: &str = "zm.meeting.window.main";
/// The only page host read in a browser.
pub const MEET_HOST: &str = "meet.google.com";
/// Arc window titles do not identify the selected page. Search their structure instead.
pub const ARC_BUNDLE_ID: &str = "company.thebrowser.Browser";
/// Chromium browsers whose Meet tab may be read.
pub const CHROMIUM_BROWSERS: [&str; 7] = [
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    ARC_BUNDLE_ID,
    "com.vivaldi.Vivaldi",
    "org.chromium.Chromium",
];
/// Never read, whatever a caller passes.
pub const REFUSED_BUNDLE_IDS: [&str; 2] = ["com.apple.Safari", "com.apple.SafariTechnologyPreview"];
/// The Accessibility messaging timeout set on every element: the most one round trip can cost.
pub const MESSAGING_TIMEOUT_SECONDS: f32 = 0.1;
/// An app that rests is not read for this many ticks (30 s at one tick per 5 s).
pub const TIMEOUT_SKIP_TICKS: u32 = 6;
/// An app with a known call window rests only after this many ticks in a row with a timeout while
/// it is read. One slow answer is not enough.
pub const TIMEOUTS_BEFORE_REST: u32 = 2;
/// What a search for the call window may cost. It runs on its own clock, before the tick's
/// reading budget starts, and only when an app has no known call window.
pub const SEARCH_BUDGET: Budget = Budget {
    max_nodes: 3000,
    max_depth: 80,
    max_time: Duration::from_millis(400),
};
/// After a search that found no call window in an app, or that failed or timed out, that app is
/// not searched for this many ticks.
pub const SEARCH_WAIT_TICKS: u32 = 3;
/// A browser window is searched for a Meet page only when its title contains this (a Meet tab is
/// titled "Meet", a dash, and the meeting code or the event name). A hint for where to look,
/// nothing more: what is read is decided by the address of the page.
pub const MEET_WINDOW_TITLE_HINT: &str = "Meet";
/// Containers the page search does not enter: the page is never inside a toolbar or a tab strip.
/// When a window shows no page at all this way, it is walked once more without this list.
pub const PAGE_SEARCH_SKIPPED_CONTAINERS: [&str; 2] = ["AXToolbar", "AXTabGroup"];
/// How deep the search for a page goes inside a browser window.
pub const PAGE_SEARCH_DEPTH: usize = 30;
/// Arc's web area is three levels below its window. Keep its native sidebar search shallow.
pub const ARC_PAGE_SEARCH_DEPTH: usize = 6;
/// Maximum structural nodes inspected in one Arc window before moving to the next.
pub const ARC_PAGE_SEARCH_NODES: usize = 64;
/// Roles whose children are never searched for a page (controls and text).
pub const PAGE_SEARCH_LEAF_ROLES: [&str; 15] = [
    "AXButton",
    "AXRadioButton",
    "AXCheckBox",
    "AXPopUpButton",
    "AXMenuButton",
    "AXTextField",
    "AXTextArea",
    "AXStaticText",
    "AXImage",
    "AXMenuBar",
    "AXMenu",
    "AXMenuItem",
    "AXSlider",
    "AXComboBox",
    "AXIncrementor",
];

/// Accessibility permission for this process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Granted,
    Missing,
    Unsupported,
}

/// A running app: its process id and its bundle id.
///
/// The reader decides from `bundle_id` alone whether it may read the process: Zoom, an
/// allow-listed Chromium browser, or nothing at all (Safari is always refused). It cannot check
/// the pairing itself, so the caller must take both values from the operating system in one
/// lookup, for example `processIdentifier` and `bundleIdentifier` of the same
/// `NSRunningApplication`. Never build one from a process id found elsewhere and a bundle id
/// that is only assumed: the reader would read that process as if it were the named app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunningApp {
    pub pid: i32,
    pub bundle_id: String,
}

/// The kinds of app the reader reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppKind {
    Zoom,
    ChromiumBrowser,
}

/// What the reader does with an app: `None` means it is never touched (Safari, anything else).
pub fn app_kind(bundle_id: &str) -> Option<AppKind> {
    if REFUSED_BUNDLE_IDS.contains(&bundle_id) {
        return None;
    }
    if bundle_id == ZOOM_BUNDLE_ID {
        return Some(AppKind::Zoom);
    }
    CHROMIUM_BROWSERS
        .contains(&bundle_id)
        .then_some(AppKind::ChromiumBrowser)
}

/// True when `url` is an https address whose host is exactly `meet.google.com`.
pub fn is_meet_url(url: &str) -> bool {
    let Some(scheme_end) = url.find("://") else {
        return false;
    };
    if !url[..scheme_end].eq_ignore_ascii_case("https") {
        return false;
    }
    let rest = &url[scheme_end + 3..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|ch| ch.is_ascii_digit()) => host,
        _ => authority,
    };
    let host = host.strip_suffix('.').unwrap_or(host);
    host.eq_ignore_ascii_case(MEET_HOST)
}

/// Accessibility error codes (`AXError`).
pub mod ax_error {
    pub const FAILURE: i32 = -25200;
    pub const ILLEGAL_ARGUMENT: i32 = -25201;
    pub const INVALID_UI_ELEMENT: i32 = -25202;
    pub const CANNOT_COMPLETE: i32 = -25204;
    pub const ATTRIBUTE_UNSUPPORTED: i32 = -25205;
    pub const NOT_IMPLEMENTED: i32 = -25208;
    pub const API_DISABLED: i32 = -25211;
    pub const NO_VALUE: i32 = -25212;
    pub const PARAMETERIZED_ATTRIBUTE_UNSUPPORTED: i32 = -25213;
}

/// What an error code means for one attribute value (a text, a subrole, an identifier, an
/// address). `None`: no value here: missing, unsupported, or the app could not give it. `Some`:
/// the read failed, which discards the tick; `NotTrusted` means the permission is missing or was
/// revoked.
pub fn read_error(code: i32) -> Option<ReadError> {
    use ax_error::*;
    match code {
        0
        | NO_VALUE
        | ATTRIBUTE_UNSUPPORTED
        | PARAMETERIZED_ATTRIBUTE_UNSUPPORTED
        | FAILURE
        | ILLEGAL_ARGUMENT
        | NOT_IMPLEMENTED => None,
        API_DISABLED => Some(ReadError::NotTrusted),
        CANNOT_COMPLETE => Some(ReadError::Timeout),
        INVALID_UI_ELEMENT => Some(ReadError::Gone),
        other => Some(ReadError::Failed(other)),
    }
}

/// What an error code means for a whole call, and for the role and the children of a node, which
/// make the tree. Only "no value" and "attribute unsupported" mean an empty answer. Any other
/// code, a plain failure included, is a failed read and discards the tick: treating it as "no
/// children" would return part of a window as if it were all of it.
pub fn call_error(code: i32) -> Option<ReadError> {
    use ax_error::*;
    match code {
        0 | NO_VALUE | ATTRIBUTE_UNSUPPORTED => None,
        API_DISABLED => Some(ReadError::NotTrusted),
        CANNOT_COMPLETE => Some(ReadError::Timeout),
        INVALID_UI_ELEMENT => Some(ReadError::Gone),
        other => Some(ReadError::Failed(other)),
    }
}

/// Why a tick gave no names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoNames {
    /// Not macOS.
    Unsupported,
    /// Accessibility permission is missing or was revoked.
    PermissionMissing,
    Skip(Skip),
}

impl From<Skip> for NoNames {
    fn from(skip: Skip) -> Self {
        match skip {
            Skip::Discarded(Discard::Read(ReadError::NotTrusted)) => NoNames::PermissionMissing,
            other => NoNames::Skip(other),
        }
    }
}

impl From<Discard> for NoNames {
    fn from(discard: Discard) -> Self {
        NoNames::from(Skip::Discarded(discard))
    }
}

/// One tick's result and what its reading cost, for logs (counts only, never names). The search
/// phase is not in here; [`TickStats`] has every phase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TickReport {
    pub outcome: Result<Extraction, NoNames>,
    /// Elements of the call windows that were read.
    pub nodes: usize,
    /// The time of the reading phase.
    pub elapsed: Duration,
}

/// What one phase of a tick cost: round trips to the app, elements visited, time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PhaseCost {
    pub calls: u64,
    pub nodes: usize,
    pub time: Duration,
}

#[cfg(any(target_os = "macos", test))]
impl PhaseCost {
    fn add(&mut self, other: PhaseCost) {
        self.calls += other.calls;
        self.nodes += other.nodes;
        self.time += other.time;
    }
}

/// Where the last tick spent its time. Counts and times only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TickStats {
    /// Search: the window lists, one title or identifier per window, and the one look at (and
    /// write of) a browser's flag.
    pub windows: PhaseCost,
    /// Search: the walk inside candidate windows, down to the page.
    pub search: PhaseCost,
    /// Reading: one check of each known call window.
    pub cached: PhaseCost,
    /// Reading: the structure of the call windows.
    pub page: PhaseCost,
    /// Reading: the in-call test and the rules (text reads).
    pub rules: PhaseCost,
    /// Apps searched in this tick.
    pub apps_searched: usize,
    /// Windows that their title or identifier made candidates.
    pub candidate_windows: usize,
    /// Call windows this tick's search found.
    pub found: usize,
    /// Call windows known from an earlier tick: read without a search.
    pub from_cache: usize,
    /// Known call windows this tick forgot: no longer a call window, or the call has ended.
    pub forgotten: usize,
    /// Why the search of an app stopped early in this tick, if one did: a timeout, a failed read
    /// (with its code), or the search budget.
    pub search_stopped: Option<Discard>,
}

#[cfg(any(target_os = "macos", test))]
mod driver;

pub use imp::*;

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod imp {
    use super::driver::{Driver, Platform};
    use super::*;
    use crate::rules::Rules;
    use crate::session::{Meter, Stopwatch, Target};
    use crate::speaking::{MARKER_TIMEOUT_SECONDS, SAMPLE_BUDGET};
    use crate::tree::{ClassSet, Source, Structure, TextAttr, MAX_CLASSES};
    use core_foundation::array::{CFArray, CFArrayGetValueAtIndex, CFArrayRef};
    use core_foundation::base::{
        CFEqual, CFGetTypeID, CFHash, CFIndex, CFNullGetTypeID, CFType, CFTypeID, CFTypeRef,
        TCFType,
    };
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::{CFURLGetString, CFURL};
    use core_foundation::{declare_TCFType, impl_TCFType};
    use std::cell::Cell;
    use std::ffi::c_void;

    thread_local! {
        /// Round trips to other apps made on this thread, for diagnostics. A reader lives on one
        /// thread, so the difference between two readings is what the calls in between cost.
        static ROUND_TRIPS: Cell<u64> = const { Cell::new(0) };
    }

    /// Count one round trip. Called by every function that sends a message to another app.
    fn round_trip() {
        ROUND_TRIPS.with(|count| count.set(count.get() + 1));
    }

    #[repr(C)]
    pub struct __AXUIElement(c_void);
    pub type AXUIElementRef = *const __AXUIElement;

    /// `kAXValueTypeAXError`: an attribute in a multiple-attribute read that failed.
    const AX_VALUE_TYPE_AX_ERROR: u32 = 5;
    /// Chromium's flag that makes a browser expose its page content to Accessibility.
    const MANUAL_ACCESSIBILITY: &str = "AXManualAccessibility";

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementGetTypeID() -> CFTypeID;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementCopyMultipleAttributeValues(
            element: AXUIElementRef,
            attributes: CFArrayRef,
            options: u32,
            values: *mut CFArrayRef,
        ) -> i32;
        fn AXUIElementSetAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: CFTypeRef,
        ) -> i32;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_in_seconds: f32) -> i32;
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
        fn AXValueGetTypeID() -> CFTypeID;
        fn AXValueGetType(value: CFTypeRef) -> u32;
        fn AXValueGetValue(value: CFTypeRef, value_type: u32, value_ptr: *mut c_void) -> u8;
    }

    declare_TCFType!(
        /// One Accessibility element of another app.
        AXUIElement,
        AXUIElementRef
    );
    impl_TCFType!(AXUIElement, AXUIElementRef, AXUIElementGetTypeID);

    /// Whether this process may use Accessibility. Never prompts.
    pub fn permission() -> Permission {
        if unsafe { AXIsProcessTrusted() } != 0 {
            Permission::Granted
        } else {
            Permission::Missing
        }
    }

    /// Ask macOS to show its Accessibility prompt (and list this app in System Settings) when the
    /// permission is missing. Returns the permission as it is now.
    pub fn request_permission() -> Permission {
        let options = CFDictionary::from_CFType_pairs(&[(
            CFString::from_static_string("AXTrustedCheckOptionPrompt"),
            CFBoolean::true_value(),
        )]);
        if unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) } != 0 {
            Permission::Granted
        } else {
            Permission::Missing
        }
    }

    /// The application element of a process, with the messaging timeout set.
    fn application(pid: i32) -> AXUIElement {
        let element =
            unsafe { AXUIElement::wrap_under_create_rule(AXUIElementCreateApplication(pid)) };
        with_timeout(element)
    }

    fn with_timeout(element: AXUIElement) -> AXUIElement {
        unsafe {
            AXUIElementSetMessagingTimeout(element.as_concrete_TypeRef(), MESSAGING_TIMEOUT_SECONDS)
        };
        element
    }

    /// The attribute names a reading uses.
    struct Names {
        structure: CFArray<CFString>,
        page_search: CFArray<CFString>,
        title: CFString,
        description: CFString,
        value: CFString,
        identifier: CFString,
        windows: CFString,
        url: CFString,
        class_list: CFString,
        minimized: CFString,
    }

    impl Names {
        fn new() -> Self {
            let name = CFString::from_static_string;
            Names {
                structure: CFArray::from_CFTypes(&[
                    name("AXRole"),
                    name("AXSubrole"),
                    name("AXIdentifier"),
                    name("AXChildren"),
                ]),
                page_search: CFArray::from_CFTypes(&[name("AXRole"), name("AXChildren")]),
                title: name("AXTitle"),
                description: name("AXDescription"),
                value: name("AXValue"),
                identifier: name("AXIdentifier"),
                windows: name("AXWindows"),
                url: name("AXURL"),
                class_list: name("AXDOMClassList"),
                minimized: name("AXMinimized"),
            }
        }

        fn text(&self, attr: TextAttr) -> CFString {
            match attr {
                TextAttr::Title => self.title.clone(),
                TextAttr::Description => self.description.clone(),
                TextAttr::Value => self.value.clone(),
            }
        }
    }

    /// `Ok(())` when an error code only means "nothing here"; otherwise the failed read. Strict
    /// is for a whole call and for the values that make the tree ([`call_error`]); lenient is for
    /// any other single value ([`read_error`]).
    fn nothing_there(code: i32, strict: bool) -> Result<(), ReadError> {
        let error = if strict {
            call_error(code)
        } else {
            read_error(code)
        };
        error.map_or(Ok(()), Err)
    }

    /// One attribute. `Ok(None)` when it has no value.
    fn copy(
        element: &AXUIElement,
        attribute: &CFString,
        strict: bool,
    ) -> Result<Option<CFType>, ReadError> {
        let mut value: CFTypeRef = std::ptr::null();
        round_trip();
        let code = unsafe {
            AXUIElementCopyAttributeValue(
                element.as_concrete_TypeRef(),
                attribute.as_concrete_TypeRef(),
                &mut value,
            )
        };
        if code != 0 {
            return nothing_there(code, strict).map(|()| None);
        }
        if value.is_null() {
            return Ok(None);
        }
        let value = unsafe { CFType::wrap_under_create_rule(value) };
        present(value, strict)
    }

    /// Several attributes in one round trip, in the order asked. The call as a whole is judged
    /// strictly; `strict` says the same for each value.
    fn copy_many(
        element: &AXUIElement,
        attributes: &CFArray<CFString>,
        strict: &[bool],
    ) -> Result<Vec<Option<CFType>>, ReadError> {
        let count = attributes.len() as usize;
        let mut values: CFArrayRef = std::ptr::null();
        round_trip();
        let code = unsafe {
            AXUIElementCopyMultipleAttributeValues(
                element.as_concrete_TypeRef(),
                attributes.as_concrete_TypeRef(),
                0,
                &mut values,
            )
        };
        if code != 0 {
            return nothing_there(code, true).map(|()| vec![None; count]);
        }
        if values.is_null() {
            return Ok(vec![None; count]);
        }
        let values: CFArray = unsafe { CFArray::wrap_under_create_rule(values) };
        let mut items = values.get_all_values().into_iter();
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            let strict = strict.get(index).copied().unwrap_or(true);
            out.push(match items.next() {
                Some(item) if !item.is_null() => {
                    present(unsafe { CFType::wrap_under_get_rule(item) }, strict)?
                }
                _ => None,
            });
        }
        Ok(out)
    }

    /// `kCFNull` and per-attribute errors become "no value" or a failed read.
    fn present(value: CFType, strict: bool) -> Result<Option<CFType>, ReadError> {
        let type_id = value.type_of();
        if type_id == unsafe { CFNullGetTypeID() } {
            return Ok(None);
        }
        if type_id == unsafe { AXValueGetTypeID() }
            && unsafe { AXValueGetType(value.as_CFTypeRef()) } == AX_VALUE_TYPE_AX_ERROR
        {
            let mut code: i32 = ax_error::FAILURE;
            unsafe {
                AXValueGetValue(
                    value.as_CFTypeRef(),
                    AX_VALUE_TYPE_AX_ERROR,
                    &mut code as *mut i32 as *mut c_void,
                )
            };
            return nothing_there(code, strict).map(|()| None);
        }
        Ok(Some(value))
    }

    fn string(value: &Option<CFType>) -> Option<String> {
        value
            .as_ref()?
            .downcast::<CFString>()
            .map(|text| text.to_string())
    }

    /// The text of an address. The string is taken with the get rule and checked before it is
    /// wrapped; nothing here asks CoreFoundation for a new URL, which can come back NULL.
    fn url_string(value: &Option<CFType>) -> Option<String> {
        let value = value.as_ref()?;
        if let Some(url) = value.downcast::<CFURL>() {
            let text = unsafe { CFURLGetString(url.as_concrete_TypeRef()) };
            if text.is_null() {
                return None;
            }
            return Some(unsafe { CFString::wrap_under_get_rule(text) }.to_string());
        }
        value.downcast::<CFString>().map(|text| text.to_string())
    }

    /// At most `max` elements of an array value. Items past `max` are not even looked at, so a
    /// huge child list costs nothing before the node budget stops the tick.
    fn elements(value: &Option<CFType>, max: usize) -> Vec<AXUIElement> {
        let Some(array) = value.as_ref().and_then(|value| value.downcast::<CFArray>()) else {
            return Vec::new();
        };
        let element_type = unsafe { AXUIElementGetTypeID() };
        let count = usize::try_from(array.len()).unwrap_or(0).min(max);
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            let item =
                unsafe { CFArrayGetValueAtIndex(array.as_concrete_TypeRef(), index as CFIndex) };
            if !item.is_null() && unsafe { CFGetTypeID(item) } == element_type {
                out.push(with_timeout(unsafe {
                    AXUIElement::wrap_under_get_rule(item as AXUIElementRef)
                }));
            }
        }
        out
    }

    /// The live window as a [`Source`] for `session` and `extract`.
    pub struct AxSource {
        names: Names,
    }

    impl AxSource {
        pub fn new() -> Self {
            AxSource {
                names: Names::new(),
            }
        }

        /// Round trips to other apps made on this thread so far, for diagnostics.
        pub fn calls(&self) -> u64 {
            ROUND_TRIPS.with(Cell::get)
        }
    }

    impl Default for AxSource {
        fn default() -> Self {
            AxSource::new()
        }
    }

    impl Source for AxSource {
        type Node = AXUIElement;

        fn structure(
            &mut self,
            node: &AXUIElement,
        ) -> Result<(Structure, Vec<AXUIElement>), ReadError> {
            self.structure_capped(node, usize::MAX)
        }

        fn structure_capped(
            &mut self,
            node: &AXUIElement,
            max_children: usize,
        ) -> Result<(Structure, Vec<AXUIElement>), ReadError> {
            // Role and children make the tree: a failure there fails the read. Subrole and
            // identifier are single values.
            let values = copy_many(node, &self.names.structure, &[true, false, false, true])?;
            let structure = Structure {
                role: string(&values[0]),
                subrole: string(&values[1]),
                identifier: string(&values[2]),
            };
            Ok((structure, elements(&values[3], max_children)))
        }

        fn texts(
            &mut self,
            node: &AXUIElement,
            attrs: &[TextAttr],
        ) -> Result<Vec<Option<String>>, ReadError> {
            let names: Vec<CFString> = attrs.iter().map(|attr| self.names.text(*attr)).collect();
            let lenient = vec![false; attrs.len()];
            let values = copy_many(node, &CFArray::from_CFTypes(&names), &lenient)?;
            Ok(values.iter().map(string).collect())
        }

        fn class_list(&mut self, node: &AXUIElement) -> Result<Option<ClassSet>, ReadError> {
            // A single value: an element without a class list has no value there.
            let value = copy(node, &self.names.class_list, false)?;
            Ok(class_set(&value))
        }

        fn identity_hash(&self, node: &AXUIElement) -> u64 {
            unsafe { CFHash(node.as_CFTypeRef()) as u64 }
        }

        fn same(&self, a: &AXUIElement, b: &AXUIElement) -> bool {
            unsafe { CFEqual(a.as_CFTypeRef(), b.as_CFTypeRef()) != 0 }
        }
    }

    impl Platform for AxSource {
        fn application(&mut self, pid: i32) -> AXUIElement {
            application(pid)
        }

        fn windows(
            &mut self,
            application: &AXUIElement,
            max: usize,
        ) -> Result<Vec<AXUIElement>, ReadError> {
            Ok(elements(
                &copy(application, &self.names.windows, true)?,
                max,
            ))
        }

        fn identifier(&mut self, window: &AXUIElement) -> Result<Option<String>, ReadError> {
            Ok(string(&copy(window, &self.names.identifier, false)?))
        }

        fn role_and_children(
            &mut self,
            node: &AXUIElement,
            max_children: usize,
        ) -> Result<(Option<String>, Vec<AXUIElement>), ReadError> {
            let values = copy_many(node, &self.names.page_search, &[true, true])?;
            Ok((string(&values[0]), elements(&values[1], max_children)))
        }

        fn url(&mut self, web_area: &AXUIElement) -> Result<Option<String>, ReadError> {
            Ok(url_string(&copy(web_area, &self.names.url, false)?))
        }

        fn flag(&mut self, application: &AXUIElement) -> Result<bool, ReadError> {
            let name = CFString::from_static_string(MANUAL_ACCESSIBILITY);
            Ok(copy(application, &name, false)?
                .and_then(|value| value.downcast::<CFBoolean>())
                .map(bool::from)
                .unwrap_or(false))
        }

        fn set_flag(&mut self, application: &AXUIElement, on: bool) -> Result<bool, ReadError> {
            set_manual_accessibility(application, on)
        }

        fn title(&mut self, window: &AXUIElement) -> Result<Option<String>, ReadError> {
            Ok(string(&copy(window, &self.names.title, false)?))
        }

        fn calls(&self) -> u64 {
            AxSource::calls(self)
        }

        fn quick(&mut self, node: &AXUIElement) {
            unsafe {
                AXUIElementSetMessagingTimeout(node.as_concrete_TypeRef(), MARKER_TIMEOUT_SECONDS)
            };
        }

        fn minimized(&mut self, window: &AXUIElement) -> Result<bool, ReadError> {
            Ok(copy(window, &self.names.minimized, false)?
                .and_then(|value| value.downcast::<CFBoolean>())
                .map(bool::from)
                .unwrap_or(false))
        }
    }

    /// The class list of an element as a [`ClassSet`]: each string is hashed and dropped at once.
    /// `None` when there is no array of strings, or more than [`MAX_CLASSES`] items; items that
    /// are not strings are left out.
    fn class_set(value: &Option<CFType>) -> Option<ClassSet> {
        let array = value.as_ref()?.downcast::<CFArray>()?;
        let count = usize::try_from(array.len()).ok()?;
        if count > MAX_CLASSES {
            return None;
        }
        let string_type = CFString::type_id();
        let mut tokens: Vec<String> = Vec::with_capacity(count);
        for index in 0..count {
            let item =
                unsafe { CFArrayGetValueAtIndex(array.as_concrete_TypeRef(), index as CFIndex) };
            if !item.is_null() && unsafe { CFGetTypeID(item) } == string_type {
                let text = unsafe { CFString::wrap_under_get_rule(item as CFStringRef) };
                tokens.push(text.to_string());
            }
        }
        ClassSet::from_tokens(tokens.iter().map(String::as_str))
    }

    /// Reads the meeting window once per tick, for the length of one recording. See the module
    /// documentation for how to host one: `read` once per tick, one thread, and `stop` on every
    /// way out.
    pub struct Reader {
        driver: Driver<AxSource>,
    }

    impl Default for Reader {
        fn default() -> Self {
            Reader::new()
        }
    }

    impl Reader {
        pub fn new() -> Self {
            Reader {
                driver: Driver::new(AxSource::new()),
            }
        }

        /// One tick over the given running apps: the search phase when an app is due for one,
        /// on its own clock, then the reading within `budget`.
        pub fn read(&mut self, rules: &Rules, apps: &[RunningApp], budget: Budget) -> TickReport {
            if permission() != Permission::Granted {
                return TickReport {
                    outcome: Err(NoNames::PermissionMissing),
                    nodes: 0,
                    elapsed: Duration::ZERO,
                };
            }
            self.search(apps);
            let clock = Stopwatch::start();
            let mut meter = Meter::new(budget, &clock);
            let outcome = self.driver.read(rules, apps, &mut meter);
            TickReport {
                outcome,
                nodes: meter.nodes(),
                elapsed: meter.elapsed(),
            }
        }

        /// The search phase of a tick, within [`SEARCH_BUDGET`]: starts the tick, forgets apps
        /// that have quit, and looks for a call window in each app that has none and is due.
        /// [`Reader::read`] and [`Reader::targets`] run it themselves when it has not run in this
        /// tick; call it first only to keep it off a clock of your own.
        pub fn search(&mut self, apps: &[RunningApp]) {
            if self.driver.searched() {
                return;
            }
            let clock = Stopwatch::start();
            let mut meter = Meter::new(SEARCH_BUDGET, &clock);
            self.driver.search(apps, &mut meter);
        }

        /// The known call windows, each checked with one read. Call it once per tick. It runs the
        /// search phase first when [`Reader::search`] has not run in this tick; that search has
        /// its own budget, but the clock of `meter` runs on while it lasts.
        pub fn targets(
            &mut self,
            apps: &[RunningApp],
            meter: &mut Meter,
        ) -> Result<Vec<Target<AXUIElement>>, NoNames> {
            self.search(apps);
            let found = self.driver.targets(apps, meter)?;
            Ok(found.into_iter().map(|(_, target)| target).collect())
        }

        /// The source the targets belong to.
        pub fn source(&mut self) -> &mut AxSource {
            &mut self.driver.platform
        }

        /// Where the last tick spent its time, phase by phase. Counts and times only.
        pub fn stats(&self) -> TickStats {
            self.driver.stats()
        }

        /// What the last `read` found for speaking: the followed tiles with their names, and
        /// whether the call window is hidden. `None` when it did not look. Once per `read`.
        pub fn speaking(&mut self) -> Option<Found> {
            self.driver.speaking()
        }

        /// One speaking sample: the class list of the marker of each tile asked for (by its
        /// index in the last [`Reader::speaking`]), within [`SAMPLE_BUDGET`]. Nothing else is read.
        pub fn sample(&mut self, slots: &[usize]) -> SampleRead {
            let clock = Stopwatch::start();
            self.driver.sample(slots, SAMPLE_BUDGET, &clock)
        }

        /// Diagnostics on a developer's own call: keep a copy of what each `read` reads, with
        /// its texts, until the next tick. Off unless asked for.
        pub fn keep_trees(&mut self, keep: bool) {
            self.driver.keep_trees = keep;
        }

        /// With [`Reader::keep_trees`]: the windows the last `read` read.
        pub fn last_trees(&self) -> &[(App, Node)] {
            self.driver.trees()
        }

        /// Turn off every browser flag this reader turned on. Call it when the recording stops
        /// and on the app's exit path.
        pub fn stop(&mut self) {
            self.driver.stop();
        }
    }

    impl Drop for Reader {
        fn drop(&mut self) {
            self.stop();
        }
    }

    /// The only write: Chromium's manual-accessibility flag on a browser's application element.
    /// `Ok(false)` when the app does not take the attribute.
    fn set_manual_accessibility(application: &AXUIElement, on: bool) -> Result<bool, ReadError> {
        let attribute = CFString::from_static_string(MANUAL_ACCESSIBILITY);
        let value = CFBoolean::from(on);
        round_trip();
        let code = unsafe {
            AXUIElementSetAttributeValue(
                application.as_concrete_TypeRef(),
                attribute.as_concrete_TypeRef(),
                value.as_CFTypeRef(),
            )
        };
        if code == 0 {
            return Ok(true);
        }
        nothing_there(code, false).map(|()| false)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn without_apps_a_tick_touches_nothing() {
            let rules = Rules::embedded().unwrap();
            let report = Reader::new().read(&rules, &[], Budget::DEFAULT);
            match permission() {
                Permission::Granted => {
                    assert_eq!(report.outcome, Err(NoNames::Skip(Skip::NoTarget)))
                }
                _ => assert_eq!(report.outcome, Err(NoNames::PermissionMissing)),
            }
            assert_eq!(report.nodes, 0);
        }

        #[test]
        fn reading_an_element_returns_cleanly_with_or_without_access() {
            // This test process's own application element. Whether it reads or fails depends on
            // the runner's permission; it must return within the messaging timeout either way.
            let mut source = AxSource::new();
            let element = application(std::process::id() as i32);
            let started = std::time::Instant::now();
            let _ = source.structure(&element);
            let _ = source.texts(&element, &[TextAttr::Title, TextAttr::Description]);
            let _ = source.windows(&element, 4);
            let _ = source.title(&element);
            assert!(source.calls() >= 4);
            assert!(started.elapsed() < std::time::Duration::from_secs(2));
            assert!(source.same(&element, &element.clone()));
            assert_eq!(
                source.identity_hash(&element),
                source.identity_hash(&element.clone())
            );
        }

        #[test]
        fn safari_is_never_touched() {
            let rules = Rules::embedded().unwrap();
            let mut reader = Reader::new();
            let apps = [RunningApp {
                pid: std::process::id() as i32,
                bundle_id: "com.apple.Safari".into(),
            }];
            let report = reader.read(&rules, &apps, Budget::DEFAULT);
            assert_eq!(report.nodes, 0);
            assert!(matches!(
                report.outcome,
                Err(NoNames::PermissionMissing) | Err(NoNames::Skip(Skip::NoTarget))
            ));
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;
    use crate::rules::Rules;

    pub fn permission() -> Permission {
        Permission::Unsupported
    }

    pub fn request_permission() -> Permission {
        Permission::Unsupported
    }

    /// Not macOS: every tick is [`NoNames::Unsupported`].
    #[derive(Debug, Default)]
    pub struct Reader;

    impl Reader {
        pub fn new() -> Self {
            Reader
        }

        pub fn read(
            &mut self,
            _rules: &Rules,
            _apps: &[RunningApp],
            _budget: Budget,
        ) -> TickReport {
            TickReport {
                outcome: Err(NoNames::Unsupported),
                nodes: 0,
                elapsed: Duration::ZERO,
            }
        }

        pub fn search(&mut self, _apps: &[RunningApp]) {}

        pub fn speaking(&mut self) -> Option<Found> {
            None
        }

        pub fn sample(&mut self, _slots: &[usize]) -> SampleRead {
            SampleRead::default()
        }

        pub fn stats(&self) -> TickStats {
            TickStats::default()
        }

        pub fn keep_trees(&mut self, _keep: bool) {}

        pub fn last_trees(&self) -> &[(App, Node)] {
            &[]
        }

        pub fn stop(&mut self) {}
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn other_platforms_are_unsupported() {
            assert_eq!(permission(), Permission::Unsupported);
            assert_eq!(request_permission(), Permission::Unsupported);
            let report = Reader::new().read(&Rules::embedded().unwrap(), &[], Budget::DEFAULT);
            assert_eq!(report.outcome, Err(NoNames::Unsupported));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_zoom_and_allow_listed_chromium_browsers_are_read() {
        assert_eq!(app_kind("us.zoom.xos"), Some(AppKind::Zoom));
        for browser in CHROMIUM_BROWSERS {
            assert_eq!(
                app_kind(browser),
                Some(AppKind::ChromiumBrowser),
                "{browser}"
            );
        }
        for other in [
            "com.apple.Safari",
            "com.apple.SafariTechnologyPreview",
            "org.mozilla.firefox",
            "com.microsoft.teams2",
            "com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan",
            "",
        ] {
            assert_eq!(app_kind(other), None, "{other}");
        }
    }

    #[test]
    fn meet_urls_need_the_exact_host_over_https() {
        for yes in [
            "https://meet.google.com/abc-defg-hij",
            "https://meet.google.com",
            "https://MEET.google.com/x?authuser=0",
            "https://meet.google.com:443/x",
            "https://meet.google.com./x",
            "HTTPS://meet.google.com/x",
        ] {
            assert!(is_meet_url(yes), "{yes}");
        }
        for no in [
            "http://meet.google.com/abc-defg-hij",
            "https://accounts.google.com/signin?continue=https://meet.google.com/abc",
            "https://meet.google.com.example.org/x",
            "https://example.org/meet.google.com",
            "https://user@meet.google.com/x",
            "https://notmeet.google.com/x",
            "https://meet.google.com:x/",
            "meet.google.com/abc",
            "/abc-defg-hij",
            "",
        ] {
            assert!(!is_meet_url(no), "{no}");
        }
    }

    #[test]
    fn a_single_value_that_fails_softly_is_no_value() {
        assert_eq!(read_error(0), None);
        for soft in [
            ax_error::NO_VALUE,
            ax_error::ATTRIBUTE_UNSUPPORTED,
            ax_error::FAILURE,
            ax_error::ILLEGAL_ARGUMENT,
            ax_error::NOT_IMPLEMENTED,
        ] {
            assert_eq!(read_error(soft), None, "{soft}");
        }
        assert_eq!(
            read_error(ax_error::API_DISABLED),
            Some(ReadError::NotTrusted)
        );
        assert_eq!(
            read_error(ax_error::CANNOT_COMPLETE),
            Some(ReadError::Timeout)
        );
        assert_eq!(
            read_error(ax_error::INVALID_UI_ELEMENT),
            Some(ReadError::Gone)
        );
        assert_eq!(read_error(-25209), Some(ReadError::Failed(-25209)));
    }

    #[test]
    fn a_whole_call_is_empty_only_for_no_value_and_unsupported() {
        assert_eq!(call_error(0), None);
        assert_eq!(call_error(ax_error::NO_VALUE), None);
        assert_eq!(call_error(ax_error::ATTRIBUTE_UNSUPPORTED), None);
        for hard in [
            ax_error::FAILURE,
            ax_error::ILLEGAL_ARGUMENT,
            ax_error::NOT_IMPLEMENTED,
            ax_error::PARAMETERIZED_ATTRIBUTE_UNSUPPORTED,
        ] {
            assert_eq!(call_error(hard), Some(ReadError::Failed(hard)), "{hard}");
        }
        assert_eq!(
            call_error(ax_error::API_DISABLED),
            Some(ReadError::NotTrusted)
        );
        assert_eq!(
            call_error(ax_error::CANNOT_COMPLETE),
            Some(ReadError::Timeout)
        );
        assert_eq!(
            call_error(ax_error::INVALID_UI_ELEMENT),
            Some(ReadError::Gone)
        );
    }

    #[test]
    fn revoked_access_reads_as_permission_missing() {
        assert_eq!(
            NoNames::from(Skip::Discarded(Discard::Read(ReadError::NotTrusted))),
            NoNames::PermissionMissing
        );
        assert_eq!(
            NoNames::from(Discard::Time),
            NoNames::Skip(Skip::Discarded(Discard::Time))
        );
        assert_eq!(
            NoNames::from(Skip::NotInCall),
            NoNames::Skip(Skip::NotInCall)
        );
    }

    #[test]
    fn permission_serializes_for_the_frontend() {
        assert_eq!(
            serde_json::to_string(&Permission::Granted).unwrap(),
            "\"granted\""
        );
        assert_eq!(
            serde_json::to_string(&Permission::Missing).unwrap(),
            "\"missing\""
        );
        assert_eq!(
            serde_json::to_string(&Permission::Unsupported).unwrap(),
            "\"unsupported\""
        );
    }

    #[test]
    fn one_round_trip_fits_the_default_tick_budget() {
        let timeout = Duration::from_secs_f32(MESSAGING_TIMEOUT_SECONDS);
        assert!(timeout * 2 <= crate::session::Budget::DEFAULT.max_time);
    }
}
