//! The call apps the offer knows, and how a process's bundle id maps to one of them.
//!
//! The table is code, not data: nothing at run time can widen it. An app that is not in it never
//! makes an offer, so dictation tools, voice memos and games are ignored.
//!
//! Two rules tell a call from other microphone use:
//! - [`Kind::Native`] (Zoom, Teams, Slack, FaceTime's call services, Signal, Discord, Webex,
//!   WhatsApp): the app captures audio for [`NATIVE_SUSTAIN`].
//! - [`Kind::Browser`]: the browser captures and plays audio for [`BROWSER_SUSTAIN`]. Dictation
//!   in a browser captures without playing.
//!
//! A helper process maps to its app by a case-insensitive prefix that ends at a dot:
//! `com.google.Chrome.helper` is Chrome, `com.google.Chromeish` is nothing. When two entries
//! match, the longer one wins (`com.google.Chrome.beta` is Chrome Beta, not Chrome).

use std::time::Duration;

/// How long a native call app must capture before the offer shows.
pub const NATIVE_SUSTAIN: Duration = Duration::from_secs(8);
/// How long a browser must capture and play before the offer shows.
pub const BROWSER_SUSTAIN: Duration = Duration::from_secs(15);

/// Which rule tells that an app is in a call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// A call app: capturing is enough.
    Native,
    /// A browser: capturing and playing.
    Browser,
}

impl Kind {
    /// How long the rule must hold before the offer shows.
    pub const fn sustain(self) -> Duration {
        match self {
            Kind::Native => NATIVE_SUSTAIN,
            Kind::Browser => BROWSER_SUSTAIN,
        }
    }

    /// The kind as the app's log writes it. Logs carry the kind, never a bundle id.
    pub const fn as_str(self) -> &'static str {
        match self {
            Kind::Native => "native",
            Kind::Browser => "browser",
        }
    }
}

/// One entry of the table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct App {
    /// The app's bundle id. Its helpers' ids start with it and a dot.
    pub bundle_id: &'static str,
    pub kind: Kind,
}

const fn native(bundle_id: &'static str) -> App {
    App {
        bundle_id,
        kind: Kind::Native,
    }
}

const fn browser(bundle_id: &'static str) -> App {
    App {
        bundle_id,
        kind: Kind::Browser,
    }
}

/// The call apps. Mac check A (`examples/mic_apps.rs` through real calls) confirms or corrects
/// these ids.
pub const APPS: [App; 25] = [
    // Native call apps.
    native("us.zoom.xos"),
    native("com.microsoft.teams2"),
    native("com.microsoft.teams"),
    native("com.tinyspeck.slackmacgap"),
    native("com.apple.FaceTime"),
    // FaceTime and iPhone calls on the Mac capture in these system services, not in the app.
    native("com.apple.avconferenced"),
    native("com.apple.TelephonyUtilities"),
    native("org.whispersystems.signal-desktop"),
    native("com.hnc.Discord"),
    native("Cisco-Systems.Spark"),
    native("com.webex.meetingmanager"),
    native("net.whatsapp.WhatsApp"),
    native("desktop.WhatsApp"),
    // Browsers: the Chromium browsers whose Meet tab the names reader knows
    // (call-names `ax::CHROMIUM_BROWSERS`), Chrome's other channels, Safari and Firefox.
    browser("com.google.Chrome"),
    browser("com.google.Chrome.beta"),
    browser("com.google.Chrome.dev"),
    browser("com.google.Chrome.canary"),
    browser("com.microsoft.edgemac"),
    browser("com.brave.Browser"),
    browser("company.thebrowser.Browser"),
    browser("com.vivaldi.Vivaldi"),
    browser("org.chromium.Chromium"),
    browser("com.operasoftware.Opera"),
    browser("com.apple.Safari"),
    browser("org.mozilla.firefox"),
];

/// A table entry, by its place in [`APPS`]. It is all the offer keeps of a process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AppId(u8);

impl AppId {
    /// The entry.
    pub fn app(self) -> &'static App {
        &APPS[self.0 as usize]
    }

    /// The entry's rule.
    pub fn kind(self) -> Kind {
        self.app().kind
    }

    /// Every entry, in table order.
    pub fn all() -> impl Iterator<Item = AppId> {
        (0..APPS.len()).map(|index| AppId(index as u8))
    }
}

/// The table entry of a process with this bundle id, or `None` for any other process.
///
/// The id matches an entry when it equals the entry's id or starts with it and a dot, ignoring
/// ASCII case. The longest matching entry wins.
pub fn lookup(bundle_id: &str) -> Option<AppId> {
    let id = bundle_id.as_bytes();
    let mut best: Option<(usize, AppId)> = None;
    for app in AppId::all() {
        let entry = app.app().bundle_id.as_bytes();
        if id.len() < entry.len() || !id[..entry.len()].eq_ignore_ascii_case(entry) {
            continue;
        }
        let rest = &id[entry.len()..];
        if !(rest.is_empty() || rest[0] == b'.') {
            continue;
        }
        match best {
            Some((length, _)) if length >= entry.len() => {}
            _ => best = Some((entry.len(), app)),
        }
    }
    best.map(|(_, app)| app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_has_no_duplicates_and_fits_its_id() {
        assert!(APPS.len() <= u8::MAX as usize);
        for (index, app) in APPS.iter().enumerate() {
            for other in &APPS[index + 1..] {
                assert!(
                    !app.bundle_id.eq_ignore_ascii_case(other.bundle_id),
                    "{} is listed twice",
                    app.bundle_id
                );
            }
        }
    }

    #[test]
    fn every_entry_maps_to_itself() {
        for app in AppId::all() {
            assert_eq!(lookup(app.app().bundle_id), Some(app));
        }
    }
}
