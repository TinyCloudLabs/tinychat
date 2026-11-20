//! The tick itself, over any platform.
//!
//! A tick has two phases, each on its own clock:
//!
//! 1. Search ([`Driver::search`], budget `SEARCH_BUDGET`). Only for an app with no known call
//!    window, and then only every `SEARCH_WAIT_TICKS` ticks. One read for the app's window list
//!    and one per window (a browser window's title, a Zoom window's identifier) pick the candidate
//!    windows. Arc searches all windows breadth-first with small per-window limits; other
//!    browsers use the title hint and a pruned depth-first walk down to the web
//!    areas, never into one, and keeps the first one whose address is on the Meet host. What it
//!    finds is remembered, so a search that runs out of time loses nothing.
//! 2. Reading ([`Driver::read`], the tick's own budget). Each known call window is checked with
//!    one read (its address, or its identifier) and read. A window that is no longer a call
//!    window, or whose call has ended, is forgotten, and its app is searched again later.
//!
//! So a normal tick makes one round trip per known window plus the page read, whatever else is
//! running. Apps without a call window are touched only in the search phase, which cannot take
//! time from the reading.
//!
//! A search that fails or times out is tried again after `SEARCH_WAIT_TICKS` ticks, like one that
//! finds nothing. In the reading, an app rests for `TIMEOUT_SKIP_TICKS` ticks after
//! `TIMEOUTS_BEFORE_REST` ticks in a row with a timeout; one slow answer costs that tick only.
//!
//! Speaking markers. A reading that gives names also finds the speaking markers of that window
//! (see `speaking`), on the same scan and meter, and checks with two reads whether the window is
//! minimised or shows another tab (Arc: only minimised). The markers are kept until the next
//! reading, with the short messaging timeout of a sample, and [`Driver::sample`] reads their class
//! lists in between: nothing else, and nothing while their app rests after timeouts.
//!
//! Only the round trips are the platform's, so all of this is tested with a fake one.

use super::*;
use crate::rules::{App, Rules};
use crate::session::{read_tick_full, Clock, Meter, Target, TickTrace};
use crate::speaking::{Found as SpeakingFound, Markers, SampleRead};
use crate::tree::{Node, Source};
use std::collections::{HashMap, VecDeque};

/// What a tick needs from the platform beyond [`Source`]. Each method except `application` and
/// `calls` is one round trip to the app.
pub(crate) trait Platform: Source {
    /// The application element of a process. No round trip.
    fn application(&mut self, pid: i32) -> Self::Node;
    /// The application's windows, at most `max`.
    fn windows(
        &mut self,
        application: &Self::Node,
        max: usize,
    ) -> Result<Vec<Self::Node>, ReadError>;
    /// A window's identifier.
    fn identifier(&mut self, window: &Self::Node) -> Result<Option<String>, ReadError>;
    /// A window's title. Used once, as a hint for where to search, and dropped.
    fn title(&mut self, window: &Self::Node) -> Result<Option<String>, ReadError>;
    /// Role and at most `max_children` children: all that is read inside a window, outside a page.
    fn role_and_children(
        &mut self,
        node: &Self::Node,
        max_children: usize,
    ) -> Result<(Option<String>, Vec<Self::Node>), ReadError>;
    /// The address of a web area.
    fn url(&mut self, web_area: &Self::Node) -> Result<Option<String>, ReadError>;
    /// Whether a browser's page-content flag is on.
    fn flag(&mut self, application: &Self::Node) -> Result<bool, ReadError>;
    /// Write a browser's page-content flag: the only write there is. `Ok(false)` when the app does
    /// not take it.
    fn set_flag(&mut self, application: &Self::Node, on: bool) -> Result<bool, ReadError>;
    /// Round trips made so far, for diagnostics.
    fn calls(&self) -> u64;
    /// Give a speaking marker the short messaging timeout of a sample. No round trip.
    fn quick(&mut self, node: &Self::Node) {
        let _ = node;
    }
    /// Whether a window is minimised. One round trip; "no value" is not minimised.
    fn minimized(&mut self, window: &Self::Node) -> Result<bool, ReadError> {
        let _ = window;
        Ok(false)
    }
}

/// Call windows, each with the process it belongs to.
type Found<N> = Vec<(i32, Target<N>)>;

/// A browser whose flag has been looked at.
struct Flag<N> {
    application: N,
    /// This reader turned it on, so this reader turns it off.
    turned_on: bool,
}

/// A window that held a call page when it was last looked at: a Meet web area, or Zoom's meeting
/// window.
struct Page<N> {
    app: App,
    root: N,
    /// Found by this tick's search, so not checked again in this tick.
    fresh: bool,
    /// The browser window that shows the page, to tell whether it is hidden. Zoom: none.
    window: Option<N>,
}

/// What is remembered about one running app between ticks.
struct Known<N> {
    kind: AppKind,
    pages: Vec<Page<N>>,
    /// Ticks to wait before the next search.
    wait: u32,
    /// Ticks this app still rests after timeouts.
    rest: u32,
    /// Ticks in a row with a timeout.
    strikes: u32,
    /// In this tick: the app rests; the app is not searched.
    resting: bool,
    waiting: bool,
    /// In this tick: a round trip was made; one timed out.
    touched: bool,
    timed_out: bool,
}

impl<N> Known<N> {
    fn new(kind: AppKind) -> Self {
        Known {
            kind,
            pages: Vec::new(),
            wait: 0,
            rest: 0,
            strikes: 0,
            resting: false,
            waiting: false,
            touched: false,
            timed_out: false,
        }
    }
}

pub(crate) struct Driver<P: Platform> {
    pub(crate) platform: P,
    flags: HashMap<i32, Flag<P::Node>>,
    known: HashMap<i32, Known<P::Node>>,
    /// The search phase of the current tick has run.
    searched: bool,
    /// A read in the search phase said the permission is missing.
    not_trusted: bool,
    stats: TickStats,
    /// Diagnostics: keep a copy of what each tick read.
    pub(crate) keep_trees: bool,
    trees: Vec<(App, Node)>,
    /// The speaking markers of the window that gave names, and the process they belong to.
    markers: Markers<P::Node>,
    marker_pid: Option<i32>,
    /// What the last reading found for speaking, until it is asked for.
    found: Option<SpeakingFound>,
}

impl<P: Platform> Driver<P> {
    pub(crate) fn new(platform: P) -> Self {
        Driver {
            platform,
            flags: HashMap::new(),
            known: HashMap::new(),
            searched: false,
            not_trusted: false,
            stats: TickStats::default(),
            keep_trees: false,
            trees: Vec::new(),
            markers: Markers::new(),
            marker_pid: None,
            found: None,
        }
    }

    /// True once this tick's search phase has run and its reading has not started.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn searched(&self) -> bool {
        self.searched
    }

    /// Where the last tick spent its time.
    pub(crate) fn stats(&self) -> TickStats {
        self.stats
    }

    /// With `keep_trees`: what the last tick read, window by window.
    pub(crate) fn trees(&self) -> &[(App, Node)] {
        &self.trees
    }

    /// Phase 1. Starts a tick: forgets apps that are gone, counts down waits and rests, then
    /// looks for a call window in each app that has none and is due. `meter` is the search's own.
    pub(crate) fn search(&mut self, apps: &[RunningApp], meter: &mut Meter) {
        self.begin_tick(apps);
        self.searched = true;
        let mut done: Vec<i32> = Vec::new();
        for app in apps {
            // Safari and every app that is not on the list: no element is even made.
            let Some(kind) = app_kind(&app.bundle_id) else {
                continue;
            };
            if done.contains(&app.pid) {
                continue;
            }
            done.push(app.pid);
            let known = self
                .known
                .entry(app.pid)
                .or_insert_with(|| Known::new(kind));
            if known.resting || known.waiting || !known.pages.is_empty() {
                continue;
            }
            if let Err(out_of_time) = meter.check_time() {
                // The apps not reached are searched in the next tick.
                self.stats.search_stopped = Some(out_of_time);
                break;
            }
            self.stats.apps_searched += 1;
            let stopped =
                match self.search_app(app.pid, kind, app.bundle_id == ARC_BUNDLE_ID, meter) {
                    Ok(()) => continue,
                    Err(stopped) => stopped,
                };
            self.stats.search_stopped = Some(stopped);
            match stopped {
                Discard::Read(ReadError::NotTrusted) => {
                    self.not_trusted = true;
                    break;
                }
                // A slow, failed or vanished app: look again later, like an app with no call
                // window. A search cannot take time from a reading, so this app does not rest;
                // the other apps are still searched.
                Discard::Read(_) => self.wait(app.pid),
                // Out of search budget: this app is searched again next tick. What was found
                // is kept.
                _ => break,
            }
        }
    }

    /// Phase 2: check the known call windows, read them, and extract names from the only one in
    /// a call. `meter` is the tick's own; the search does not count against it.
    pub(crate) fn read(
        &mut self,
        rules: &Rules,
        apps: &[RunningApp],
        meter: &mut Meter,
    ) -> Result<Extraction, NoNames> {
        let (pids, targets): (Vec<i32>, Vec<Target<P::Node>>) =
            self.targets(apps, meter)?.into_iter().unzip();
        let mut trace = TickTrace {
            keep_trees: self.keep_trees,
            ..TickTrace::default()
        };
        let calls = self.platform.calls();
        let mut markers = None;
        let result = read_tick_full(
            rules,
            &mut self.platform,
            &targets,
            meter,
            &mut trace,
            Some(&mut markers),
        );
        let calls = self.platform.calls() - calls;
        let text_reads = (trace.text_reads + trace.class_reads) as u64;
        self.stats.page = PhaseCost {
            calls: calls.saturating_sub(text_reads),
            nodes: trace.scan_nodes,
            time: trace.scan_time,
        };
        self.stats.rules = PhaseCost {
            calls: text_reads.min(calls),
            nodes: 0,
            time: trace.rules_time,
        };
        for (index, in_call) in trace.in_call.iter().enumerate() {
            if in_call.is_some() || trace.failed == Some(index) {
                self.touch(pids[index]);
            }
            if *in_call == Some(false) {
                // The call has ended, or has not begun: not worth a read every tick.
                self.forget(pids[index], &targets[index].root, SEARCH_WAIT_TICKS);
            }
        }
        if result == Err(Skip::Discarded(Discard::Read(ReadError::Timeout))) {
            if let Some(index) = trace.failed {
                self.strike(pids[index]);
            }
        }
        self.trees = std::mem::take(&mut trace.trees)
            .into_iter()
            .map(|(index, tree)| (targets[index].app, tree))
            .collect();
        self.speaking_found(&result, markers, &trace, &pids, &targets, apps, meter);
        result.map_err(NoNames::from)
    }

    /// Keep what a reading found for speaking. A reading that gave names and found markers
    /// replaces the markers; one that found the call over drops them; one that failed, or whose
    /// search for markers failed, keeps them for the samples and says it did not look.
    #[allow(clippy::too_many_arguments)]
    fn speaking_found(
        &mut self,
        result: &Result<Extraction, Skip>,
        markers: Option<Vec<crate::speaking::Marker<P::Node>>>,
        trace: &TickTrace,
        pids: &[i32],
        targets: &[Target<P::Node>],
        apps: &[RunningApp],
        meter: &mut Meter,
    ) {
        self.found = None;
        match (result, markers) {
            (Ok(_), Some(found)) => {
                let index = trace
                    .in_call
                    .iter()
                    .position(|in_call| *in_call == Some(true));
                let Some(index) = index else {
                    return;
                };
                for marker in &found {
                    self.platform.quick(&marker.marker);
                }
                let hidden =
                    !found.is_empty() && self.hidden(pids[index], &targets[index], apps, meter);
                let tiles = self.markers.update(&self.platform, found);
                self.marker_pid = Some(pids[index]);
                self.found = Some(SpeakingFound { tiles, hidden });
            }
            (Ok(_), None) | (Err(Skip::Discarded(_)), _) => {}
            (Err(_), _) => {
                // No call window, or more than one: nothing to follow.
                self.markers.clear();
                self.marker_pid = None;
                self.found = Some(SpeakingFound::default());
            }
        }
    }

    /// Whether the window of a Meet page is minimised, or (except in Arc, whose titles do not
    /// say which tab shows) titled for another tab. A read that fails or is out of time says
    /// "not hidden"; the title is compared and dropped.
    fn hidden(
        &mut self,
        pid: i32,
        target: &Target<P::Node>,
        apps: &[RunningApp],
        meter: &mut Meter,
    ) -> bool {
        if target.app != App::GoogleMeet {
            return false;
        }
        let window = self.known.get(&pid).and_then(|known| {
            known
                .pages
                .iter()
                .find(|page| self.platform.same(&page.root, &target.root))
                .and_then(|page| page.window.clone())
        });
        let Some(window) = window else {
            return false;
        };
        if meter.check_time().is_err() {
            return false;
        }
        if self.platform.minimized(&window).unwrap_or(false) {
            return true;
        }
        let arc = apps
            .iter()
            .any(|app| app.pid == pid && app.bundle_id == ARC_BUNDLE_ID);
        if arc || meter.check_time().is_err() {
            return false;
        }
        match self.platform.title(&window) {
            Ok(Some(title)) => !title.contains(MEET_WINDOW_TITLE_HINT),
            _ => false,
        }
    }

    /// What the last reading found for speaking; `None` when it did not look. Once per reading.
    pub(crate) fn speaking(&mut self) -> Option<SpeakingFound> {
        self.found.take()
    }

    /// One speaking sample of the kept markers, within `budget` on `clock`. Nothing is read
    /// while their app rests after timeouts.
    pub(crate) fn sample(
        &mut self,
        slots: &[usize],
        budget: Duration,
        clock: &dyn Clock,
    ) -> SampleRead {
        let resting = self
            .marker_pid
            .and_then(|pid| self.known.get(&pid))
            .is_some_and(|known| known.resting);
        if resting || self.marker_pid.is_none() {
            return SampleRead {
                resting,
                readings: slots
                    .iter()
                    .map(|&slot| (slot, crate::speaking::Reading::Unknown))
                    .collect(),
                ..SampleRead::default()
            };
        }
        self.markers
            .sample(&mut self.platform, slots, budget, clock)
    }

    /// The known call windows that still are call windows, each with its process id. One read
    /// per window; no search.
    pub(crate) fn targets(
        &mut self,
        apps: &[RunningApp],
        meter: &mut Meter,
    ) -> Result<Found<P::Node>, NoNames> {
        self.searched = false;
        if std::mem::take(&mut self.not_trusted) {
            return Err(NoNames::PermissionMissing);
        }
        let began = self.mark(meter);
        let mut targets = Vec::new();
        let mut result = Ok(());
        let mut done: Vec<i32> = Vec::new();
        'apps: for app in apps {
            if done.contains(&app.pid) {
                continue;
            }
            done.push(app.pid);
            let Some(known) = self.known.get(&app.pid) else {
                continue;
            };
            if known.resting {
                continue;
            }
            let pages: Vec<(App, P::Node, bool)> = known
                .pages
                .iter()
                .map(|page| (page.app, page.root.clone(), page.fresh))
                .collect();
            for (page_app, root, fresh) in pages {
                if !fresh {
                    if let Err(discard) = meter.check_time() {
                        result = Err(NoNames::from(discard));
                        break 'apps;
                    }
                    self.touch(app.pid);
                    match self.still_a_call_window(page_app, &root) {
                        Ok(true) => self.stats.from_cache += 1,
                        Err(ReadError::NotTrusted) => {
                            result = Err(NoNames::PermissionMissing);
                            break 'apps;
                        }
                        // One slow answer: keep the window, leave it out of this tick.
                        Err(ReadError::Timeout) => {
                            self.strike(app.pid);
                            continue;
                        }
                        // The page moved on or the window closed: search again next tick.
                        Ok(false) | Err(_) => {
                            self.forget(app.pid, &root, 0);
                            continue;
                        }
                    }
                }
                targets.push((
                    app.pid,
                    Target {
                        app: page_app,
                        root,
                    },
                ));
            }
        }
        let cost = self.spent(began, meter);
        self.stats.cached.add(cost);
        result.map(|()| targets)
    }

    /// Turn off every flag this reader turned on, and forget everything.
    pub(crate) fn stop(&mut self) {
        for (_, flag) in self.flags.drain() {
            if flag.turned_on {
                let _ = self.platform.set_flag(&flag.application, false);
            }
        }
        self.known.clear();
        self.trees.clear();
        self.searched = false;
        self.not_trusted = false;
        self.markers.clear();
        self.marker_pid = None;
        self.found = None;
    }

    /// Forget the apps that are gone, and count down the apps that wait or rest.
    fn begin_tick(&mut self, apps: &[RunningApp]) {
        let kind_of = |pid: i32| {
            apps.iter()
                .find(|app| app.pid == pid)
                .and_then(|app| app_kind(&app.bundle_id))
        };
        // An app that has quit gets no write and no read: its pid may be another process by now.
        self.flags
            .retain(|pid, _| kind_of(*pid) == Some(AppKind::ChromiumBrowser));
        self.known
            .retain(|pid, known| kind_of(*pid) == Some(known.kind));
        for known in self.known.values_mut() {
            if known.touched && !known.timed_out {
                known.strikes = 0;
            }
            known.touched = false;
            known.timed_out = false;
            known.resting = known.rest > 0;
            known.rest = known.rest.saturating_sub(1);
            known.waiting = known.wait > 0;
            known.wait = known.wait.saturating_sub(1);
            for page in &mut known.pages {
                page.fresh = false;
            }
        }
        self.stats = TickStats::default();
        self.trees.clear();
    }

    /// Look for a call window in one app that has none.
    fn search_app(
        &mut self,
        pid: i32,
        kind: AppKind,
        arc: bool,
        meter: &mut Meter,
    ) -> Result<(), Discard> {
        let application = self.platform.application(pid);
        self.touch(pid);

        let began = self.mark(meter);
        let candidates = self.candidate_windows(&application, kind, arc, meter);
        let cost = self.spent(began, meter);
        self.stats.windows.add(cost);
        let candidates = candidates?;
        self.stats.candidate_windows += candidates.len();
        if candidates.is_empty() {
            self.wait(pid);
            return Ok(());
        }
        match kind {
            AppKind::Zoom => {
                // The meeting window is the page.
                for window in candidates {
                    self.keep(pid, App::Zoom, window, None);
                }
                Ok(())
            }
            AppKind::ChromiumBrowser => {
                // Only now may the flag be written: a window of this browser is about to be
                // searched for a Meet page.
                let began = self.mark(meter);
                let turned_on = self.flag_on(pid, &application, meter);
                let cost = self.spent(began, meter);
                self.stats.windows.add(cost);
                if turned_on? {
                    // Just turned on. The browser builds its page tree now; search it next tick.
                    return Ok(());
                }
                let began = self.mark(meter);
                let nodes = meter.nodes();
                let mut result = Ok(());
                for window in candidates {
                    match find_page(&mut self.platform, window.clone(), meter, arc) {
                        Ok(Some(web_area)) => {
                            self.keep(pid, App::GoogleMeet, web_area, Some(window))
                        }
                        Ok(None) => {}
                        Err(discard) => {
                            result = Err(discard);
                            break;
                        }
                    }
                }
                let mut cost = self.spent(began, meter);
                cost.nodes = meter.nodes() - nodes;
                self.stats.search.add(cost);
                let found = self
                    .known
                    .get(&pid)
                    .is_some_and(|known| !known.pages.is_empty());
                if result.is_ok() && !found {
                    self.wait(pid);
                }
                result
            }
        }
    }

    /// The windows worth a closer look. Arc titles do not identify the selected tab, so all
    /// its windows are candidates; the page URL remains the acceptance check.
    fn candidate_windows(
        &mut self,
        application: &P::Node,
        kind: AppKind,
        arc: bool,
        meter: &mut Meter,
    ) -> Result<Vec<P::Node>, Discard> {
        meter.check_time()?;
        let room = meter.remaining_nodes().saturating_add(1);
        let windows = self
            .platform
            .windows(application, room)
            .map_err(Discard::Read)?;
        let mut candidates = Vec::new();
        for window in windows {
            meter.visit(0)?;
            let candidate = match kind {
                AppKind::Zoom => {
                    let identifier = self.platform.identifier(&window).map_err(Discard::Read)?;
                    identifier.as_deref() == Some(ZOOM_MEETING_WINDOW)
                }
                AppKind::ChromiumBrowser if arc => true,
                AppKind::ChromiumBrowser => {
                    // Read, compared and dropped. Only a hint: the address decides what is read.
                    let title = self.platform.title(&window).map_err(Discard::Read)?;
                    title.is_some_and(|title| title.contains(MEET_WINDOW_TITLE_HINT))
                }
            };
            if candidate {
                candidates.push(window);
            }
        }
        Ok(candidates)
    }

    /// One read: is this still a call window?
    fn still_a_call_window(&mut self, app: App, root: &P::Node) -> Result<bool, ReadError> {
        Ok(match app {
            App::GoogleMeet => self
                .platform
                .url(root)?
                .is_some_and(|url| is_meet_url(&url)),
            App::Zoom => self.platform.identifier(root)?.as_deref() == Some(ZOOM_MEETING_WINDOW),
        })
    }

    /// Turn on the page-content flag of a browser, once, unless it is on already. True when this
    /// call turned it on.
    fn flag_on(
        &mut self,
        pid: i32,
        application: &P::Node,
        meter: &mut Meter,
    ) -> Result<bool, Discard> {
        if self.flags.contains_key(&pid) {
            return Ok(false);
        }
        meter.check_time()?;
        let was_on = self.platform.flag(application).map_err(Discard::Read)?;
        meter.check_time()?;
        let turned_on = if was_on {
            // Someone else turned it on (a screen reader): nothing to write, nothing to undo.
            Ok(false)
        } else {
            match self.platform.set_flag(application, true) {
                Ok(taken) => Ok(taken),
                // The write may still arrive: remember to undo it.
                Err(ReadError::Timeout) => Err(ReadError::Timeout),
                Err(other) => return Err(Discard::Read(other)),
            }
        };
        self.flags.insert(
            pid,
            Flag {
                application: application.clone(),
                turned_on: turned_on.unwrap_or(true),
            },
        );
        turned_on.map_err(Discard::Read)
    }

    fn keep(&mut self, pid: i32, app: App, root: P::Node, window: Option<P::Node>) {
        if let Some(known) = self.known.get_mut(&pid) {
            known.pages.push(Page {
                app,
                root,
                fresh: true,
                window,
            });
            self.stats.found += 1;
        }
    }

    /// Drop a window from the known ones. When the app has none left, it is searched again after
    /// `wait` ticks.
    fn forget(&mut self, pid: i32, root: &P::Node, wait: u32) {
        let Some(known) = self.known.get_mut(&pid) else {
            return;
        };
        let platform = &self.platform;
        let before = known.pages.len();
        known.pages.retain(|page| !platform.same(&page.root, root));
        self.stats.forgotten += before - known.pages.len();
        if known.pages.is_empty() {
            known.wait = wait;
        }
    }

    fn wait(&mut self, pid: i32) {
        if let Some(known) = self.known.get_mut(&pid) {
            known.wait = SEARCH_WAIT_TICKS;
        }
    }

    fn touch(&mut self, pid: i32) {
        if let Some(known) = self.known.get_mut(&pid) {
            known.touched = true;
        }
    }

    /// A timeout in this tick. After enough ticks in a row with one, the app rests.
    fn strike(&mut self, pid: i32) {
        let Some(known) = self.known.get_mut(&pid) else {
            return;
        };
        if known.timed_out {
            return;
        }
        known.timed_out = true;
        known.strikes += 1;
        if known.strikes >= TIMEOUTS_BEFORE_REST {
            known.strikes = 0;
            known.rest = TIMEOUT_SKIP_TICKS;
        }
    }

    /// The clock and the round-trip counter now.
    fn mark(&self, meter: &Meter) -> (Duration, u64) {
        (meter.elapsed(), self.platform.calls())
    }

    fn spent(&self, since: (Duration, u64), meter: &Meter) -> PhaseCost {
        PhaseCost {
            calls: self.platform.calls() - since.1,
            nodes: 0,
            time: meter.elapsed().saturating_sub(since.0),
        }
    }
}

/// The Meet page of one browser window, if it shows one.
///
/// The first pass does not enter the containers that never hold a page (toolbar, tab strip). If
/// it meets no page of any kind, the browser is laid out differently, and a second pass skips only
/// controls. Arc instead uses one shallow, capped breadth-first pass that skips only controls.
fn find_page<P: Platform>(
    platform: &mut P,
    window: P::Node,
    meter: &mut Meter,
    breadth_first: bool,
) -> Result<Option<P::Node>, Discard> {
    let mut saw_a_page = false;
    // Arc's native containers differ from Chrome's. A single shallow pass includes toolbar
    // and tab-group containers without the repeated fallback walk of non-page windows.
    if breadth_first {
        return walk_to_page(platform, window, meter, false, &mut saw_a_page, true);
    }
    let found = walk_to_page(
        platform,
        window.clone(),
        meter,
        true,
        &mut saw_a_page,
        breadth_first,
    )?;
    if found.is_some() || saw_a_page {
        return Ok(found);
    }
    walk_to_page(
        platform,
        window,
        meter,
        false,
        &mut saw_a_page,
        breadth_first,
    )
}

/// Through one window, reading only role and children, down to the web areas and never
/// into one. Stops at the first web area on the Meet host. An element met twice is skipped:
/// counted, but not read again. Arc uses breadth-first order to reach its shallow content area
/// before its large sidebar; other browsers retain the depth-first traversal.
fn walk_to_page<P: Platform>(
    platform: &mut P,
    window: P::Node,
    meter: &mut Meter,
    skip_containers: bool,
    saw_a_page: &mut bool,
    breadth_first: bool,
) -> Result<Option<P::Node>, Discard> {
    let started_nodes = meter.nodes();
    let mut seen: HashMap<u64, Vec<P::Node>> = HashMap::new();
    let mut stack: VecDeque<(P::Node, usize)> = VecDeque::from([(window, 0)]);
    while let Some((node, depth)) = if breadth_first {
        stack.pop_front()
    } else {
        stack.pop_back()
    } {
        if breadth_first && meter.nodes() - started_nodes >= ARC_PAGE_SEARCH_NODES {
            return Ok(None);
        }
        meter.visit(0)?;
        let earlier = seen.entry(platform.identity_hash(&node)).or_default();
        if earlier.iter().any(|other| platform.same(other, &node)) {
            continue;
        }
        earlier.push(node.clone());
        let room = meter.remaining_nodes().saturating_add(1);
        let (role, children) = platform
            .role_and_children(&node, room)
            .map_err(Discard::Read)?;
        let role = role.as_deref();
        if role == Some("AXWebArea") {
            *saw_a_page = true;
            meter.check_time()?;
            let url = platform.url(&node).map_err(Discard::Read)?;
            if url.is_some_and(|url| is_meet_url(&url)) {
                return Ok(Some(node));
            }
            // Another page (a side panel, another site): never entered.
            continue;
        }
        let skipped = role.is_some_and(|role| {
            PAGE_SEARCH_LEAF_ROLES.contains(&role)
                || (skip_containers && PAGE_SEARCH_SKIPPED_CONTAINERS.contains(&role))
        });
        let max_depth = if breadth_first {
            ARC_PAGE_SEARCH_DEPTH
        } else {
            PAGE_SEARCH_DEPTH
        };
        if depth >= max_depth || skipped {
            continue;
        }
        if breadth_first {
            stack.extend(children.into_iter().map(|child| (child, depth + 1)));
        } else {
            stack.extend(children.into_iter().rev().map(|child| (child, depth + 1)));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Budget;
    use crate::tree::{ClassSet, Structure, TextAttr};
    use std::cell::Cell;
    use std::collections::HashSet;
    use std::rc::Rc;

    #[derive(Clone, Default)]
    struct FakeNode {
        pid: i32,
        role: Option<String>,
        subrole: Option<String>,
        identifier: Option<String>,
        title: Option<String>,
        description: Option<String>,
        value: Option<String>,
        url: Option<String>,
        children: Vec<usize>,
    }

    /// Every call on the platform, in order.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Op {
        Application(i32),
        Windows(usize),
        Identifier(usize),
        Title(usize),
        Search(usize),
        Url(usize),
        Flag(usize),
        SetFlag(usize, bool),
        Structure(usize),
        Texts(usize),
        ClassList(usize),
        Minimized(usize),
        Quick(usize),
    }

    impl Op {
        fn node(self) -> Option<usize> {
            match self {
                Op::Application(_) => None,
                Op::Windows(node)
                | Op::Identifier(node)
                | Op::Title(node)
                | Op::Search(node)
                | Op::Url(node)
                | Op::Flag(node)
                | Op::SetFlag(node, _)
                | Op::Structure(node)
                | Op::Texts(node) => Some(node),
                Op::ClassList(node) | Op::Minimized(node) | Op::Quick(node) => Some(node),
            }
        }

        /// A call the search phase makes inside or about windows.
        fn is_search(self) -> bool {
            matches!(self, Op::Windows(_) | Op::Title(_) | Op::Search(_))
        }
    }

    /// Apps as numbered elements, a clock that every round trip moves, and a log.
    #[derive(Default)]
    struct Fake {
        nodes: Vec<FakeNode>,
        apps: HashMap<i32, usize>,
        now: Rc<Cell<Duration>>,
        /// Apps that do not answer: every round trip costs a full timeout and fails.
        hung: HashSet<i32>,
        /// Apps whose windows hang only while their content is read.
        hung_inside: HashSet<i32>,
        /// What one round trip to an app costs, when not a millisecond.
        cost: HashMap<i32, Duration>,
        /// The same, for the reads inside a call window only.
        cost_inside: HashMap<i32, Duration>,
        flags_on: HashSet<usize>,
        /// The next flag write hangs.
        write_hangs: bool,
        ops: Vec<Op>,
        /// The child limit of every call that takes one.
        limits: Vec<usize>,
        calls: u64,
        /// Class lists, by element.
        classes: HashMap<usize, Vec<&'static str>>,
        /// Windows that are minimised.
        minimized: HashSet<usize>,
    }

    impl Fake {
        fn add(&mut self, node: FakeNode) -> usize {
            self.nodes.push(node);
            self.nodes.len() - 1
        }

        fn trip(&mut self, node: usize, op: Op) -> Result<(), ReadError> {
            self.ops.push(op);
            self.calls += 1;
            let pid = self.nodes[node].pid;
            let inside = matches!(op, Op::Structure(_) | Op::Texts(_));
            if self.hung.contains(&pid) || (inside && self.hung_inside.contains(&pid)) {
                self.now.set(self.now.get() + Duration::from_millis(100));
                return Err(ReadError::Timeout);
            }
            let slow = self.cost_inside.get(&pid).filter(|_| inside);
            let cost = slow
                .or(self.cost.get(&pid))
                .copied()
                .unwrap_or(Duration::from_millis(1));
            self.now.set(self.now.get() + cost);
            Ok(())
        }

        /// The calls that went to one app.
        fn ops_of(&self, pid: i32) -> Vec<Op> {
            let of = |op: &Op| match op {
                Op::Application(app) => *app == pid,
                other => other.node().is_some_and(|node| self.nodes[node].pid == pid),
            };
            self.ops.iter().copied().filter(of).collect()
        }

        fn writes(&self) -> Vec<Op> {
            let write = |op: &Op| matches!(op, Op::SetFlag(..));
            self.ops.iter().copied().filter(write).collect()
        }

        fn count(&self, wanted: impl Fn(Op) -> bool) -> usize {
            self.ops.iter().filter(|op| wanted(**op)).count()
        }
    }

    impl Source for Fake {
        type Node = usize;

        fn structure(&mut self, node: &usize) -> Result<(Structure, Vec<usize>), ReadError> {
            self.structure_capped(node, usize::MAX)
        }

        fn structure_capped(
            &mut self,
            node: &usize,
            max_children: usize,
        ) -> Result<(Structure, Vec<usize>), ReadError> {
            self.trip(*node, Op::Structure(*node))?;
            self.limits.push(max_children);
            let found = &self.nodes[*node];
            let structure = Structure {
                role: found.role.clone(),
                subrole: found.subrole.clone(),
                identifier: found.identifier.clone(),
            };
            let children = found.children.iter().copied().take(max_children);
            Ok((structure, children.collect()))
        }

        fn texts(
            &mut self,
            node: &usize,
            attrs: &[TextAttr],
        ) -> Result<Vec<Option<String>>, ReadError> {
            self.trip(*node, Op::Texts(*node))?;
            let found = &self.nodes[*node];
            let text = |attr: &TextAttr| match attr {
                TextAttr::Title => found.title.clone(),
                TextAttr::Description => found.description.clone(),
                TextAttr::Value => found.value.clone(),
            };
            Ok(attrs.iter().map(text).collect())
        }

        fn class_list(&mut self, node: &usize) -> Result<Option<ClassSet>, ReadError> {
            self.trip(*node, Op::ClassList(*node))?;
            Ok(self
                .classes
                .get(node)
                .and_then(|classes| ClassSet::from_tokens(classes.iter().copied())))
        }

        fn identity_hash(&self, node: &usize) -> u64 {
            *node as u64 % 3
        }

        fn same(&self, a: &usize, b: &usize) -> bool {
            a == b
        }
    }

    impl Platform for Fake {
        fn application(&mut self, pid: i32) -> usize {
            self.ops.push(Op::Application(pid));
            self.apps[&pid]
        }

        fn windows(&mut self, application: &usize, max: usize) -> Result<Vec<usize>, ReadError> {
            self.trip(*application, Op::Windows(*application))?;
            self.limits.push(max);
            let windows = self.nodes[*application].children.iter().copied();
            Ok(windows.take(max).collect())
        }

        fn identifier(&mut self, window: &usize) -> Result<Option<String>, ReadError> {
            self.trip(*window, Op::Identifier(*window))?;
            Ok(self.nodes[*window].identifier.clone())
        }

        fn title(&mut self, window: &usize) -> Result<Option<String>, ReadError> {
            self.trip(*window, Op::Title(*window))?;
            Ok(self.nodes[*window].title.clone())
        }

        fn role_and_children(
            &mut self,
            node: &usize,
            max_children: usize,
        ) -> Result<(Option<String>, Vec<usize>), ReadError> {
            self.trip(*node, Op::Search(*node))?;
            self.limits.push(max_children);
            let found = &self.nodes[*node];
            let children = found.children.iter().copied().take(max_children);
            Ok((found.role.clone(), children.collect()))
        }

        fn url(&mut self, web_area: &usize) -> Result<Option<String>, ReadError> {
            self.trip(*web_area, Op::Url(*web_area))?;
            Ok(self.nodes[*web_area].url.clone())
        }

        fn flag(&mut self, application: &usize) -> Result<bool, ReadError> {
            self.trip(*application, Op::Flag(*application))?;
            Ok(self.flags_on.contains(application))
        }

        fn set_flag(&mut self, application: &usize, on: bool) -> Result<bool, ReadError> {
            self.trip(*application, Op::SetFlag(*application, on))?;
            if std::mem::take(&mut self.write_hangs) {
                return Err(ReadError::Timeout);
            }
            if on {
                self.flags_on.insert(*application);
            } else {
                self.flags_on.remove(application);
            }
            Ok(true)
        }

        fn calls(&self) -> u64 {
            self.calls
        }

        fn quick(&mut self, node: &usize) {
            self.ops.push(Op::Quick(*node));
        }

        fn minimized(&mut self, window: &usize) -> Result<bool, ReadError> {
            self.trip(*window, Op::Minimized(*window))?;
            Ok(self.minimized.contains(window))
        }
    }

    fn node(pid: i32, role: &str, children: &[usize]) -> FakeNode {
        FakeNode {
            pid,
            role: Some(role.into()),
            children: children.to_vec(),
            ..FakeNode::default()
        }
    }

    /// Zoom in a call: a meeting window with one tile, "Alex Example". Returns the window.
    fn zoom(fake: &mut Fake, pid: i32) -> usize {
        let button = fake.add(FakeNode {
            description: Some("Alex Example".into()),
            ..node(pid, "AXButton", &[])
        });
        let tab = fake.add(FakeNode {
            description: Some("Alex Example, Computer audio muted".into()),
            ..node(pid, "AXTabGroup", &[button])
        });
        let window = fake.add(FakeNode {
            identifier: Some(ZOOM_MEETING_WINDOW.into()),
            ..node(pid, "AXWindow", &[tab])
        });
        let application = fake.add(node(pid, "AXApplication", &[window]));
        fake.apps.insert(pid, application);
        window
    }

    struct Window {
        window: usize,
        /// Toolbar and tab strip, and what is inside them.
        toolbar: usize,
        tab_strip: usize,
        inside_bars: Vec<usize>,
        /// The group that holds the page.
        content: usize,
        web_area: usize,
        /// The "Leave call" button of the page.
        leave: usize,
        /// The elements of the page, below the web area.
        page: Vec<usize>,
    }

    /// A browser window: a tab strip with three tabs, a toolbar, and a page at `url` that looks
    /// like a Meet call with one tile, "Robin Sample".
    fn window(fake: &mut Fake, pid: i32, title: &str, url: &str) -> Window {
        let leave = fake.add(FakeNode {
            title: Some("Leave call".into()),
            ..node(pid, "AXButton", &[])
        });
        let controls = fake.add(FakeNode {
            subrole: Some("AXLandmarkRegion".into()),
            title: Some("Call controls".into()),
            ..node(pid, "AXGroup", &[leave])
        });
        let name = fake.add(FakeNode {
            value: Some("Robin Sample".into()),
            ..node(pid, "AXStaticText", &[])
        });
        let main = fake.add(FakeNode {
            subrole: Some("AXLandmarkMain".into()),
            ..node(pid, "AXGroup", &[name])
        });
        let web_area = fake.add(FakeNode {
            url: Some(url.into()),
            ..node(pid, "AXWebArea", &[controls, main])
        });
        let content = fake.add(node(pid, "AXGroup", &[web_area]));
        let tabs: Vec<usize> = (0..3)
            .map(|_| fake.add(node(pid, "AXRadioButton", &[])))
            .collect();
        let tab_strip = fake.add(node(pid, "AXTabGroup", &tabs));
        let reload = fake.add(node(pid, "AXButton", &[]));
        let address = fake.add(node(pid, "AXTextField", &[]));
        let toolbar = fake.add(node(pid, "AXToolbar", &[reload, address]));
        let window = fake.add(FakeNode {
            title: Some(title.into()),
            ..node(pid, "AXWindow", &[tab_strip, toolbar, content])
        });
        let mut inside_bars = tabs;
        inside_bars.extend([reload, address]);
        Window {
            window,
            toolbar,
            tab_strip,
            inside_bars,
            content,
            web_area,
            leave,
            page: vec![leave, controls, name, main],
        }
    }

    const MEET: &str = "https://meet.google.com/abc-defg-hij";
    const MEET_TITLE: &str = "Meet - abc-defg-hij - Google Chrome";
    const CHROME: &str = "com.google.Chrome";

    /// A browser with the given windows. Returns its application element.
    fn browser(fake: &mut Fake, pid: i32, windows: &[usize]) -> usize {
        let application = fake.add(node(pid, "AXApplication", windows));
        fake.apps.insert(pid, application);
        application
    }

    /// A browser with one window that shows a Meet call, and its page tree already on.
    fn meet_browser(fake: &mut Fake, pid: i32) -> (usize, Window) {
        let call = window(fake, pid, MEET_TITLE, MEET);
        let application = browser(fake, pid, &[call.window]);
        fake.flags_on.insert(application);
        (application, call)
    }

    fn app(pid: i32, bundle_id: &str) -> RunningApp {
        RunningApp {
            pid,
            bundle_id: bundle_id.into(),
        }
    }

    struct Ticked {
        outcome: Result<Extraction, NoNames>,
        /// Time on the fake clock: the search phase, and the reading.
        search: Duration,
        reading: Duration,
        /// The calls of this tick.
        ops: Vec<Op>,
        stats: TickStats,
    }

    /// One tick as the reader runs it: the search on its own clock, then the reading.
    fn tick_with(
        driver: &mut Driver<Fake>,
        apps: &[RunningApp],
        search_budget: Budget,
        budget: Budget,
    ) -> Ticked {
        let before = driver.platform.ops.len();
        let now = driver.platform.now.clone();
        let start = now.get();
        {
            let now = now.clone();
            let clock = move || now.get() - start;
            let mut meter = Meter::new(search_budget, &clock);
            driver.search(apps, &mut meter);
        }
        let middle = now.get();
        let outcome = {
            let now = now.clone();
            let clock = move || now.get() - middle;
            let mut meter = Meter::new(budget, &clock);
            driver.read(&Rules::embedded().unwrap(), apps, &mut meter)
        };
        Ticked {
            outcome,
            search: middle - start,
            reading: now.get() - middle,
            ops: driver.platform.ops[before..].to_vec(),
            stats: driver.stats(),
        }
    }

    fn tick(driver: &mut Driver<Fake>, apps: &[RunningApp]) -> Ticked {
        tick_with(driver, apps, SEARCH_BUDGET, Budget::DEFAULT)
    }

    fn names(outcome: &Result<Extraction, NoNames>, source: &str) -> Vec<String> {
        let extraction = outcome.as_ref().expect("names");
        let entries = &extraction.source(source).unwrap().entries;
        entries
            .iter()
            .map(|entry| entry.name.as_str().to_owned())
            .collect()
    }

    fn discarded(discard: Discard) -> Result<Extraction, NoNames> {
        Err(NoNames::Skip(Skip::Discarded(discard)))
    }

    const NO_TARGET: Result<Extraction, NoNames> = Err(NoNames::Skip(Skip::NoTarget));
    const NOT_IN_CALL: Result<Extraction, NoNames> = Err(NoNames::Skip(Skip::NotInCall));

    #[test]
    fn arc_finds_an_untitled_call_before_walking_a_large_sidebar() {
        let mut fake = Fake::default();
        let call = window(&mut fake, 10, "", MEET);
        let leaves: Vec<_> = (0..450)
            .map(|_| fake.add(node(10, "AXGroup", &[])))
            .collect();
        let mut sidebar = fake.add(node(10, "AXGroup", &leaves));
        for _ in 0..5 {
            sidebar = fake.add(node(10, "AXGroup", &[sidebar]));
        }
        fake.nodes[call.window].children = vec![sidebar, call.content];
        let application = browser(&mut fake, 10, &[call.window]);
        fake.flags_on.insert(application);
        let apps = [app(10, ARC_BUNDLE_ID)];
        let mut driver = Driver::new(fake);
        let first = tick(&mut driver, &apps);
        assert_eq!(names(&first.outcome, "meet-tiles"), ["Robin Sample"]);
        assert!(first.search < Duration::from_millis(30));
        assert!(!first.ops.iter().any(|op| matches!(op, Op::Title(_))));
        assert!(!first
            .ops
            .iter()
            .any(|op| matches!(op, Op::Search(n) if leaves.contains(n))));
        let second = tick(&mut driver, &apps);
        assert_eq!(names(&second.outcome, "meet-tiles"), ["Robin Sample"]);
        assert_eq!(second.stats.from_cache, 1);
        assert_eq!(second.search, Duration::ZERO);
    }

    #[test]
    fn arc_caps_each_non_call_window_and_continues_to_the_call() {
        let mut fake = Fake::default();
        let sidebar: Vec<_> = (0..500)
            .map(|_| fake.add(node(10, "AXGroup", &[])))
            .collect();
        let other = fake.add(node(10, "AXWindow", &sidebar));
        let call = window(&mut fake, 10, "", MEET);
        let application = browser(&mut fake, 10, &[other, call.window]);
        fake.flags_on.insert(application);
        let mut driver = Driver::new(fake);
        let result = tick(&mut driver, &[app(10, ARC_BUNDLE_ID)]);
        assert_eq!(names(&result.outcome, "meet-tiles"), ["Robin Sample"]);
        let non_call_visits = result
            .ops
            .iter()
            .filter(|op| matches!(op, Op::Search(n) if *n == other || sidebar.contains(n)))
            .count();
        assert_eq!(non_call_visits, ARC_PAGE_SEARCH_NODES);
        assert!(result.search < Duration::from_millis(100));
    }

    #[test]
    fn arc_never_enters_a_page_on_another_host_even_without_the_title_filter() {
        let mut fake = Fake::default();
        let other = window(&mut fake, 10, "", "https://meet.google.com.example.org/");
        let call = window(&mut fake, 10, "", MEET);
        let application = browser(&mut fake, 10, &[other.window, call.window]);
        fake.flags_on.insert(application);
        let mut driver = Driver::new(fake);
        let result = tick(&mut driver, &[app(10, ARC_BUNDLE_ID)]);
        assert_eq!(names(&result.outcome, "meet-tiles"), ["Robin Sample"]);
        assert!(result.ops.contains(&Op::Url(other.web_area)));
        assert!(!result.ops.contains(&Op::Structure(other.web_area)));
        assert!(!result
            .ops
            .iter()
            .filter_map(|op| op.node())
            .any(|n| other.page.contains(&n)));
    }

    #[test]
    fn a_meet_page_is_found_once_and_then_read_from_the_cache() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        let apps = [app(10, CHROME)];
        let mut driver = Driver::new(fake);

        // Tick 1 searches, finds the page and reads it in the same tick.
        let first = tick(&mut driver, &apps);
        assert_eq!(names(&first.outcome, "meet-tiles"), ["Robin Sample"]);
        assert_eq!(first.stats.apps_searched, 1);
        assert_eq!(first.stats.candidate_windows, 1);
        assert_eq!((first.stats.found, first.stats.from_cache), (1, 0));
        assert_eq!(
            first.stats.windows.calls, 3,
            "the window list, one title, and one look at the flag"
        );
        assert!(first.stats.search.nodes > 0 && first.stats.search.calls > 0);

        // Tick 2 does not search: one read checks the page, then the page is read.
        let second = tick(&mut driver, &apps);
        assert_eq!(names(&second.outcome, "meet-tiles"), ["Robin Sample"]);
        assert!(
            !second.ops.iter().any(|op| op.is_search()),
            "{:?}",
            second.ops
        );
        assert_eq!(second.ops[0], Op::Url(call.web_area), "one check, first");
        let checks = second.ops.iter().filter(|op| matches!(op, Op::Url(_)));
        assert_eq!(checks.count(), 1);
        assert_eq!((second.stats.found, second.stats.from_cache), (0, 1));
        assert_eq!(second.stats.apps_searched, 0);
        assert_eq!(second.stats.cached.calls, 1);
        assert_eq!(second.stats.windows, PhaseCost::default());
        assert_eq!(second.stats.search, PhaseCost::default());
        // The page costs one round trip per element; the rules a few text reads.
        assert_eq!(second.stats.page.calls, 5);
        assert_eq!(second.stats.page.nodes, 5);
        assert!(second.stats.rules.calls >= 3);
        assert_eq!(second.search, Duration::ZERO);
    }

    #[test]
    fn zoom_is_found_once_and_then_read_from_the_cache() {
        let mut fake = Fake::default();
        let window = zoom(&mut fake, 20);
        let apps = [app(20, ZOOM_BUNDLE_ID)];
        let mut driver = Driver::new(fake);
        let first = tick(&mut driver, &apps);
        assert_eq!(names(&first.outcome, "zoom-tiles"), ["Alex Example"]);
        assert_eq!(first.stats.found, 1);
        let second = tick(&mut driver, &apps);
        assert_eq!(names(&second.outcome, "zoom-tiles"), ["Alex Example"]);
        assert!(!second.ops.iter().any(|op| op.is_search()));
        assert_eq!(second.ops[0], Op::Identifier(window));
        assert_eq!(second.stats.from_cache, 1);
    }

    #[test]
    fn the_cache_is_dropped_when_the_address_changes() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        let apps = [app(10, CHROME)];
        let mut driver = Driver::new(fake);
        tick(&mut driver, &apps).outcome.unwrap();

        // The tab moves on to another site.
        driver.platform.nodes[call.web_area].url = Some("https://mail.example.org/inbox".into());
        driver.platform.nodes[call.window].title = Some("Inbox - Mail".into());
        let moved = tick(&mut driver, &apps);
        assert_eq!(moved.outcome, NO_TARGET);
        assert_eq!(moved.stats.forgotten, 1);
        assert_eq!(
            moved.ops,
            [Op::Url(call.web_area)],
            "one check; the page is not read"
        );

        // The next tick searches again at once, and finds no candidate window.
        let again = tick(&mut driver, &apps);
        assert_eq!(again.outcome, NO_TARGET);
        assert!(again.ops.contains(&Op::Title(call.window)));
        assert!(!again
            .ops
            .iter()
            .any(|op| matches!(op, Op::Search(_) | Op::Url(_))));
    }

    #[test]
    fn the_cache_is_dropped_when_the_page_is_gone() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        let apps = [app(10, CHROME)];
        let mut driver = Driver::new(fake);
        tick(&mut driver, &apps).outcome.unwrap();
        // The page reloads: the old element answers with no address.
        driver.platform.nodes[call.web_area].url = None;
        assert_eq!(tick(&mut driver, &apps).outcome, NO_TARGET);
        // A new page element takes its place and is found by the next search.
        driver.platform.nodes[call.web_area].url = Some(MEET.into());
        let found = tick(&mut driver, &apps);
        assert_eq!(names(&found.outcome, "meet-tiles"), ["Robin Sample"]);
        assert_eq!(found.stats.found, 1);
    }

    #[test]
    fn the_cache_is_dropped_when_the_call_ends() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        let apps = [app(10, CHROME)];
        let mut driver = Driver::new(fake);
        tick(&mut driver, &apps).outcome.unwrap();

        // The user leaves: the page stays on Meet but has no "Leave call" any more.
        driver.platform.nodes[call.leave].title = Some("Rejoin".into());
        let ended = tick(&mut driver, &apps);
        assert_eq!(ended.outcome, NOT_IN_CALL);
        assert_eq!(ended.stats.forgotten, 1);
        // The page is not read again every tick: nothing at all for a few ticks.
        for _ in 0..SEARCH_WAIT_TICKS {
            let quiet = tick(&mut driver, &apps);
            assert_eq!(quiet.outcome, NO_TARGET);
            assert!(quiet.ops.is_empty(), "{:?}", quiet.ops);
        }
        // Then one search and one read, to see whether a call has begun.
        let look = tick(&mut driver, &apps);
        assert_eq!(look.outcome, NOT_IN_CALL);
        assert!(look.ops.contains(&Op::Windows(driver.platform.apps[&10])));
        // A call that begins is picked up by the next look.
        driver.platform.nodes[call.leave].title = Some("Leave call".into());
        for _ in 0..SEARCH_WAIT_TICKS {
            tick(&mut driver, &apps);
        }
        assert_eq!(
            names(&tick(&mut driver, &apps).outcome, "meet-tiles"),
            ["Robin Sample"]
        );
    }

    #[test]
    fn the_title_hint_picks_the_window_among_many() {
        let mut fake = Fake::default();
        let mut windows = Vec::new();
        let mut others = Vec::new();
        for index in 0..30 {
            let other = window(
                &mut fake,
                10,
                &format!("Inbox ({index}) - Mail"),
                "https://mail.example.org/inbox",
            );
            windows.push(other.window);
            others.push(other);
        }
        let call = window(&mut fake, 10, MEET_TITLE, MEET);
        windows.insert(17, call.window);
        let application = browser(&mut fake, 10, &windows);
        fake.flags_on.insert(application);
        let apps = [app(10, CHROME)];
        let mut driver = Driver::new(fake);

        let first = tick(&mut driver, &apps);
        assert_eq!(names(&first.outcome, "meet-tiles"), ["Robin Sample"]);
        assert_eq!(
            first.stats.windows.calls, 33,
            "the window list, 31 titles, and one look at the flag"
        );
        assert_eq!(first.stats.candidate_windows, 1);
        // Inside windows, only the Meet window was walked: its window, three bars or groups, the
        // page element.
        let walked: Vec<usize> = first
            .ops
            .iter()
            .filter(|op| matches!(op, Op::Search(_)))
            .filter_map(|op| op.node())
            .collect();
        assert_eq!(
            walked,
            [
                call.window,
                call.tab_strip,
                call.toolbar,
                call.content,
                call.web_area
            ]
        );
        for other in &others {
            let touched = first.ops.iter().filter_map(|op| op.node());
            let inside = |node: usize| {
                node == other.web_area || node == other.content || other.page.contains(&node)
            };
            assert_eq!(touched.filter(|node| inside(*node)).count(), 0);
        }
        assert_eq!(first.stats.search.calls, 6, "five elements and one address");
    }

    #[test]
    fn bars_are_not_entered_and_another_page_is_skipped() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        // A side panel with its own page comes before the content.
        let side_page = fake.add(FakeNode {
            url: Some("https://panel.example.org/".into()),
            ..node(10, "AXWebArea", &[call.leave])
        });
        fake.nodes[call.window].children.insert(0, side_page);
        let mut driver = Driver::new(fake);
        let first = tick(&mut driver, &[app(10, CHROME)]);
        assert_eq!(names(&first.outcome, "meet-tiles"), ["Robin Sample"]);
        let searched = |node: usize| first.ops.contains(&Op::Search(node));
        assert!(
            searched(call.toolbar) && searched(call.tab_strip),
            "their role is read"
        );
        for inside in &call.inside_bars {
            assert!(!searched(*inside), "a toolbar or tab strip is not entered");
        }
        // The side panel: its role and its address, and nothing below it.
        assert!(first.ops.contains(&Op::Url(side_page)));
        assert!(!first.ops.contains(&Op::Structure(side_page)));
    }

    #[test]
    fn a_browser_laid_out_differently_is_walked_again_without_the_container_skip() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        // The page sits inside what reports itself as a tab group.
        fake.nodes[call.content].role = Some("AXTabGroup".into());
        let mut driver = Driver::new(fake);
        let first = tick(&mut driver, &[app(10, CHROME)]);
        assert_eq!(names(&first.outcome, "meet-tiles"), ["Robin Sample"]);
    }

    #[test]
    fn a_window_that_only_sounds_like_meet_is_never_read() {
        let mut fake = Fake::default();
        let notes = window(
            &mut fake,
            10,
            "Meeting notes - Docs",
            "https://docs.example.org/d/1",
        );
        let lookalike = window(
            &mut fake,
            10,
            "Meet - abc",
            "https://accounts.example.org/?next=https://meet.google.com/abc",
        );
        let application = browser(&mut fake, 10, &[notes.window, lookalike.window]);
        fake.flags_on.insert(application);
        let apps = [app(10, CHROME)];
        let mut driver = Driver::new(fake);
        let first = tick(&mut driver, &apps);
        assert_eq!(first.outcome, NO_TARGET);
        assert_eq!(first.stats.candidate_windows, 2);
        for found in [&notes, &lookalike] {
            // The page element: its role and its address. Below it: nothing at all.
            assert!(first.ops.contains(&Op::Url(found.web_area)));
            let touched = first.ops.iter().filter_map(|op| op.node());
            assert_eq!(touched.filter(|node| found.page.contains(node)).count(), 0);
        }
        assert!(!first
            .ops
            .iter()
            .any(|op| matches!(op, Op::Structure(_) | Op::Texts(_))));
        // And it is not walked again every tick.
        for _ in 0..SEARCH_WAIT_TICKS {
            assert!(tick(&mut driver, &apps).ops.is_empty());
        }
        assert!(!tick(&mut driver, &apps).ops.is_empty());
    }

    #[test]
    fn an_app_without_a_candidate_window_is_looked_at_only_now_and_then() {
        let mut fake = Fake::default();
        let mail = window(
            &mut fake,
            10,
            "Inbox - Mail",
            "https://mail.example.org/inbox",
        );
        let application = browser(&mut fake, 10, &[mail.window]);
        let apps = [app(10, CHROME)];
        let mut driver = Driver::new(fake);
        let look = [
            Op::Application(10),
            Op::Windows(application),
            Op::Title(mail.window),
        ];

        let first = tick(&mut driver, &apps);
        assert_eq!(first.outcome, NO_TARGET);
        assert_eq!(
            first.ops, look,
            "the window list and one title; nothing inside"
        );
        for _ in 0..SEARCH_WAIT_TICKS {
            assert!(tick(&mut driver, &apps).ops.is_empty());
        }
        assert_eq!(tick(&mut driver, &apps).ops, look);
        // No Meet window was ever seen, so the flag was neither read nor written.
        assert_eq!(
            driver
                .platform
                .count(|op| matches!(op, Op::Flag(_) | Op::SetFlag(..))),
            0
        );
    }

    #[test]
    fn a_long_search_does_not_cost_the_reading_its_budget() {
        let mut fake = Fake::default();
        let mut windows = Vec::new();
        for index in 0..60 {
            let other = window(
                &mut fake,
                10,
                &format!("Inbox ({index}) - Mail"),
                "https://mail.example.org/",
            );
            windows.push(other.window);
        }
        let call = window(&mut fake, 10, MEET_TITLE, MEET);
        windows.push(call.window);
        let application = browser(&mut fake, 10, &windows);
        fake.flags_on.insert(application);
        // Every answer takes 5 ms: the search alone takes longer than a tick may.
        fake.cost.insert(10, Duration::from_millis(5));
        let apps = [app(10, CHROME)];
        let mut driver = Driver::new(fake);

        let first = tick(&mut driver, &apps);
        assert!(
            first.search > Budget::DEFAULT.max_time,
            "{:?}",
            first.search
        );
        assert!(first.search <= SEARCH_BUDGET.max_time, "{:?}", first.search);
        // The reading starts its own clock after the search, so the same tick still has names.
        assert_eq!(names(&first.outcome, "meet-tiles"), ["Robin Sample"]);
        assert!(
            first.reading < Budget::DEFAULT.max_time,
            "{:?}",
            first.reading
        );
        // Later ticks cost only the page.
        let second = tick(&mut driver, &apps);
        assert_eq!(second.search, Duration::ZERO);
        assert_eq!(names(&second.outcome, "meet-tiles"), ["Robin Sample"]);
    }

    #[test]
    fn a_found_page_survives_a_tick_that_runs_out_of_time() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        let apps = [app(10, CHROME)];
        // The page is found at once, but in this tick reading it takes too long.
        fake.cost_inside.insert(10, Duration::from_millis(60));
        let mut driver = Driver::new(fake);
        let first = tick(&mut driver, &apps);
        assert_eq!(first.outcome, discarded(Discard::Time));
        assert_eq!(first.stats.found, 1);

        // The next tick does not search again: it reads the page that was found.
        driver.platform.cost_inside.clear();
        let second = tick(&mut driver, &apps);
        assert_eq!(names(&second.outcome, "meet-tiles"), ["Robin Sample"]);
        assert!(!second.ops.iter().any(|op| op.is_search()));
        assert_eq!(second.ops[0], Op::Url(call.web_area));
    }

    #[test]
    fn a_search_that_runs_out_of_time_keeps_what_it_found() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        // A second browser with many windows answers slowly: the search runs out inside it.
        let mut windows = Vec::new();
        for index in 0..40 {
            let other = window(
                &mut fake,
                11,
                &format!("Tab {index}"),
                "https://mail.example.org/",
            );
            windows.push(other.window);
        }
        browser(&mut fake, 11, &windows);
        fake.cost.insert(11, Duration::from_millis(50));
        let apps = [app(10, CHROME), app(11, "com.brave.Browser")];
        let mut driver = Driver::new(fake);

        let first = tick(&mut driver, &apps);
        assert_eq!(first.stats.search_stopped, Some(Discard::Time));
        assert!(first.search >= SEARCH_BUDGET.max_time);
        assert!(first.search < SEARCH_BUDGET.max_time + Duration::from_millis(60));
        assert_eq!(names(&first.outcome, "meet-tiles"), ["Robin Sample"]);
        // The slow browser is searched again in the next tick; the call is read from the cache.
        let second = tick(&mut driver, &apps);
        assert_eq!(names(&second.outcome, "meet-tiles"), ["Robin Sample"]);
        assert_eq!(second.stats.from_cache, 1);
        assert!(!driver.platform.ops_of(11).is_empty());
        let chrome_searches = second.ops.iter().filter(|op| op.is_search());
        assert!(chrome_searches
            .filter_map(|op| op.node())
            .all(|node| driver.platform.nodes[node].pid == 11));
        let _ = call;
    }

    #[test]
    fn one_slow_answer_does_not_rest_an_app_but_two_ticks_in_a_row_do() {
        let mut fake = Fake::default();
        zoom(&mut fake, 20);
        let apps = [app(20, ZOOM_BUNDLE_ID)];
        let mut driver = Driver::new(fake);
        tick(&mut driver, &apps).outcome.unwrap();

        // One tick with a timeout inside the window: that tick is lost, the next one reads.
        driver.platform.hung_inside.insert(20);
        let slow = tick(&mut driver, &apps);
        assert_eq!(slow.outcome, discarded(Discard::Read(ReadError::Timeout)));
        driver.platform.hung_inside.clear();
        let next = tick(&mut driver, &apps);
        assert_eq!(names(&next.outcome, "zoom-tiles"), ["Alex Example"]);

        // A good tick in between clears the count: timeout, good, timeout does not rest.
        driver.platform.hung_inside.insert(20);
        tick(&mut driver, &apps).outcome.unwrap_err();
        driver.platform.hung_inside.clear();
        tick(&mut driver, &apps).outcome.unwrap();
        driver.platform.hung_inside.insert(20);
        tick(&mut driver, &apps).outcome.unwrap_err();
        driver.platform.hung_inside.clear();
        assert_eq!(
            names(&tick(&mut driver, &apps).outcome, "zoom-tiles"),
            ["Alex Example"]
        );

        // Two ticks in a row with a timeout: the app rests.
        driver.platform.hung_inside.insert(20);
        tick(&mut driver, &apps).outcome.unwrap_err();
        tick(&mut driver, &apps).outcome.unwrap_err();
        for _ in 0..TIMEOUT_SKIP_TICKS {
            let resting = tick(&mut driver, &apps);
            assert_eq!(resting.outcome, NO_TARGET);
            assert!(resting.ops.is_empty(), "{:?}", resting.ops);
        }
        // After the rest it is read again, from the cache.
        driver.platform.hung_inside.clear();
        let back = tick(&mut driver, &apps);
        assert_eq!(names(&back.outcome, "zoom-tiles"), ["Alex Example"]);
        assert_eq!(back.stats.from_cache, 1);
    }

    #[test]
    fn a_hung_browser_never_costs_the_browser_with_the_call_its_tick() {
        let mut fake = Fake::default();
        meet_browser(&mut fake, 10);
        let other = window(&mut fake, 11, "Inbox - Mail", "https://mail.example.org/");
        browser(&mut fake, 11, &[other.window]);
        let second = window(&mut fake, 12, "Inbox - Mail", "https://mail.example.org/");
        browser(&mut fake, 12, &[second.window]);
        // The two browsers without a call hang, and they come first in the list.
        fake.hung.extend([11, 12]);
        let apps = [
            app(11, "company.thebrowser.Browser"),
            app(12, CHROME),
            app(10, CHROME),
        ];
        let mut driver = Driver::new(fake);

        for round in 0..12 {
            let ticked = tick(&mut driver, &apps);
            assert_eq!(
                names(&ticked.outcome, "meet-tiles"),
                ["Robin Sample"],
                "tick {round}"
            );
            // The reading never waits for them: it costs the page and nothing else.
            assert!(
                ticked.reading < Duration::from_millis(20),
                "{:?}",
                ticked.reading
            );
            assert!(
                ticked.search <= Duration::from_millis(210),
                "{:?}",
                ticked.search
            );
        }
        // Each hung browser was tried, left alone for a few ticks, and tried again: three times
        // in twelve ticks, one timed-out read each time.
        for pid in [11, 12] {
            let tries = driver.platform.ops_of(pid);
            let timeouts = tries
                .iter()
                .filter(|op| matches!(op, Op::Windows(_)))
                .count();
            assert_eq!(timeouts, 3);
        }
    }

    #[test]
    fn the_flag_is_written_only_before_a_candidate_window_is_searched_and_undone_on_stop() {
        let mut fake = Fake::default();
        // Chrome shows a Meet call and its page tree is off.
        let call = window(&mut fake, 10, MEET_TITLE, MEET);
        let chrome = browser(&mut fake, 10, &[call.window]);
        // A browser with no window, and one with no Meet window.
        let edge = browser(&mut fake, 11, &[]);
        let mail = window(&mut fake, 13, "Inbox - Mail", "https://mail.example.org/");
        let vivaldi = browser(&mut fake, 13, &[mail.window]);
        // A browser with a Meet-like window whose flag is on already, as a screen reader leaves it.
        let docs = window(
            &mut fake,
            12,
            "Meeting notes",
            "https://docs.example.org/d/1",
        );
        let brave = browser(&mut fake, 12, &[docs.window]);
        fake.flags_on.insert(brave);
        zoom(&mut fake, 20);
        // Apps the reader must never touch. Registered, so a touch would show in the log.
        let safari = window(&mut fake, 30, MEET_TITLE, MEET);
        browser(&mut fake, 30, &[safari.window]);
        let firefox = window(&mut fake, 31, MEET_TITLE, MEET);
        browser(&mut fake, 31, &[firefox.window]);
        let apps = [
            app(10, CHROME),
            app(11, "com.microsoft.edgemac"),
            app(12, "com.brave.Browser"),
            app(13, "com.vivaldi.Vivaldi"),
            app(20, ZOOM_BUNDLE_ID),
            app(30, "com.apple.Safari"),
            app(31, "org.mozilla.firefox"),
        ];
        let mut driver = Driver::new(fake);

        // Tick 1: the flag is turned on, and the window is not walked yet.
        let first = tick(&mut driver, &apps);
        assert_eq!(names(&first.outcome, "zoom-tiles"), ["Alex Example"]);
        assert_eq!(driver.platform.writes(), [Op::SetFlag(chrome, true)]);
        assert!(!first.ops.contains(&Op::Search(call.window)));
        assert!(
            driver.platform.ops_of(30).is_empty(),
            "Safari is never touched"
        );
        assert!(driver.platform.ops_of(31).is_empty());
        let flag_reads = |driver: &Driver<Fake>, application| {
            driver.platform.count(|op| op == Op::Flag(application))
        };
        assert_eq!(flag_reads(&driver, edge), 0, "no window: no flag");
        assert_eq!(flag_reads(&driver, vivaldi), 0, "no Meet window: no flag");
        assert_eq!(
            flag_reads(&driver, brave),
            1,
            "read once, and left as it is"
        );

        // Tick 2: the page is found. Meet and Zoom are now both in a call.
        let second = tick(&mut driver, &apps);
        assert_eq!(second.outcome, Err(NoNames::Skip(Skip::SeveralInCall(2))));
        assert!(second.ops.contains(&Op::Search(call.window)));
        assert_eq!(driver.platform.writes().len(), 1);
        assert_eq!(flag_reads(&driver, chrome), 1);

        // Stop undoes exactly what this reader did.
        driver.stop();
        assert_eq!(
            driver.platform.writes(),
            [Op::SetFlag(chrome, true), Op::SetFlag(chrome, false)]
        );
        assert!(driver.platform.flags_on.contains(&brave));
        driver.stop();
        assert_eq!(driver.platform.writes().len(), 2);
    }

    #[test]
    fn a_browser_that_has_quit_is_forgotten_without_a_write_or_a_read() {
        let mut fake = Fake::default();
        let call = window(&mut fake, 10, MEET_TITLE, MEET);
        let chrome = browser(&mut fake, 10, &[call.window]);
        let mut driver = Driver::new(fake);
        tick(&mut driver, &[app(10, CHROME)]);
        tick(&mut driver, &[app(10, CHROME)]).outcome.unwrap();
        assert_eq!(driver.platform.writes(), [Op::SetFlag(chrome, true)]);

        // The browser quits. A later tick sees the same pid under another app.
        let later = tick(&mut driver, &[app(10, "com.example.other")]);
        assert_eq!(later.outcome, NO_TARGET);
        assert!(
            later.ops.is_empty(),
            "the cached page of the old process is not read"
        );
        driver.stop();
        assert_eq!(
            driver.platform.writes(),
            [Op::SetFlag(chrome, true)],
            "stop must not write to a pid that is no longer that browser"
        );
    }

    #[test]
    fn a_write_that_timed_out_is_still_undone() {
        let mut fake = Fake::default();
        let call = window(&mut fake, 10, MEET_TITLE, MEET);
        let chrome = browser(&mut fake, 10, &[call.window]);
        // The app hangs just as the flag is written. The write may still arrive.
        fake.write_hangs = true;
        let mut driver = Driver::new(fake);
        let apps = [app(10, CHROME)];
        let first = tick(&mut driver, &apps);
        assert_eq!(first.outcome, NO_TARGET);
        assert_eq!(
            first.stats.search_stopped,
            Some(Discard::Read(ReadError::Timeout))
        );
        // The app is left alone for a few ticks, then searched; the flag is not written twice.
        for _ in 0..SEARCH_WAIT_TICKS {
            assert!(tick(&mut driver, &apps).ops.is_empty());
        }
        let later = tick(&mut driver, &apps);
        assert_eq!(names(&later.outcome, "meet-tiles"), ["Robin Sample"]);
        driver.stop();
        assert_eq!(
            driver.platform.writes(),
            [Op::SetFlag(chrome, true), Op::SetFlag(chrome, false)]
        );
    }

    #[test]
    fn a_repeated_element_in_the_search_is_skipped_and_the_page_is_found() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        // The content group leads back to its window, and the window lists it twice.
        fake.nodes[call.content].children.insert(0, call.window);
        fake.nodes[call.window].children.push(call.content);
        let mut driver = Driver::new(fake);
        let first = tick(&mut driver, &[app(10, CHROME)]);
        assert_eq!(names(&first.outcome, "meet-tiles"), ["Robin Sample"]);
        let searched = |node| {
            first
                .ops
                .iter()
                .filter(|op| **op == Op::Search(node))
                .count()
        };
        assert_eq!(searched(call.window), 1);
        assert_eq!(searched(call.content), 1);
    }

    #[test]
    fn a_tick_that_is_out_of_time_does_not_check_the_next_window() {
        let mut fake = Fake::default();
        zoom(&mut fake, 20);
        meet_browser(&mut fake, 10);
        let apps = [app(20, ZOOM_BUNDLE_ID), app(10, CHROME)];
        let mut driver = Driver::new(fake);
        assert_eq!(
            tick(&mut driver, &apps).outcome,
            Err(NoNames::Skip(Skip::SeveralInCall(2)))
        );
        // Zoom answers, but one answer now takes longer than the whole budget.
        driver.platform.cost.insert(20, Duration::from_millis(300));
        let slow = tick(&mut driver, &apps);
        assert_eq!(slow.outcome, discarded(Discard::Time));
        assert_eq!(
            slow.reading,
            Duration::from_millis(300),
            "one round trip, then no more"
        );
        assert!(slow.ops.iter().all(|op| op
            .node()
            .is_some_and(|node| driver.platform.nodes[node].pid == 20)));
    }

    #[test]
    fn no_call_asks_for_more_children_than_the_node_budget_has_room_for() {
        let mut fake = Fake::default();
        let (_, call) = meet_browser(&mut fake, 10);
        // A window with a hundred thousand children.
        let filler = fake.add(node(10, "AXGroup", &[]));
        fake.nodes[call.window].children = vec![filler; 100_000];
        let tight = Budget {
            max_nodes: 100,
            ..SEARCH_BUDGET
        };
        let mut driver = Driver::new(fake);
        let ticked = tick_with(&mut driver, &[app(10, CHROME)], tight, Budget::DEFAULT);
        assert_eq!(ticked.outcome, NO_TARGET);
        let limits = &driver.platform.limits;
        assert!(limits.iter().all(|&limit| limit <= 101), "{limits:?}");
        assert_eq!(
            limits[0], 101,
            "the windows: all the room, plus one to overrun it"
        );
        assert!(driver.platform.count(|op| matches!(op, Op::Search(_))) <= 100);
    }

    #[test]
    fn one_process_listed_twice_is_read_once() {
        let mut fake = Fake::default();
        zoom(&mut fake, 20);
        let mut driver = Driver::new(fake);
        let apps = [app(20, ZOOM_BUNDLE_ID), app(20, ZOOM_BUNDLE_ID)];
        assert_eq!(
            names(&tick(&mut driver, &apps).outcome, "zoom-tiles"),
            ["Alex Example"]
        );
        assert_eq!(
            names(&tick(&mut driver, &apps).outcome, "zoom-tiles"),
            ["Alex Example"]
        );
    }

    #[test]
    fn what_a_tick_read_is_kept_only_on_request() {
        let mut fake = Fake::default();
        zoom(&mut fake, 20);
        let apps = [app(20, ZOOM_BUNDLE_ID)];
        let mut driver = Driver::new(fake);
        tick(&mut driver, &apps).outcome.unwrap();
        assert!(driver.trees().is_empty());
        driver.keep_trees = true;
        tick(&mut driver, &apps).outcome.unwrap();
        let trees = driver.trees();
        assert_eq!(trees.len(), 1);
        assert_eq!(trees[0].0, App::Zoom);
        assert_eq!(trees[0].1.descendants().len(), 3);
    }

    /// The Meet classes of the embedded speaking rule: a quiet marker, and a speaking one.
    const QUIET: [&str; 3] = ["DYfzY", "cYKTje", "gjg47c"];
    const SPEAKING: [&str; 3] = ["DYfzY", "cYKTje", "Oaajhc"];

    /// A Meet window with three tiles as the speaking rule expects them. Returns the window and
    /// each tile's marker.
    fn speaking_window(fake: &mut Fake, pid: i32, title: &str) -> (usize, Vec<usize>) {
        let leave = fake.add(FakeNode {
            title: Some("Leave call".into()),
            ..node(pid, "AXButton", &[])
        });
        let controls = fake.add(FakeNode {
            subrole: Some("AXLandmarkRegion".into()),
            title: Some("Call controls".into()),
            ..node(pid, "AXGroup", &[leave])
        });
        let mut tiles = Vec::new();
        let mut markers = Vec::new();
        for name in ["Alex Example", "Robin Sample", "Test Guest A"] {
            let empty = |fake: &mut Fake, children: &[usize]| {
                fake.add(FakeNode {
                    subrole: Some("AXEmptyGroup".into()),
                    ..node(pid, "AXGroup", children)
                })
            };
            let marker = empty(fake, &[]);
            fake.classes.insert(marker, QUIET.to_vec());
            let holder = fake.add(node(pid, "AXGroup", &[marker]));
            let leaf = empty(fake, &[]);
            let ring = fake.add(node(pid, "AXGroup", &[leaf, holder]));
            let avatar = fake.add(node(pid, "AXGroup", &[ring]));
            let text = fake.add(FakeNode {
                value: Some(name.into()),
                ..node(pid, "AXStaticText", &[])
            });
            let label = fake.add(node(pid, "AXGroup", &[text]));
            let inner = fake.add(node(pid, "AXGroup", &[avatar, label]));
            tiles.push(fake.add(node(pid, "AXGroup", &[inner])));
            markers.push(marker);
        }
        let main = fake.add(FakeNode {
            subrole: Some("AXLandmarkMain".into()),
            ..node(pid, "AXGroup", &tiles)
        });
        let web_area = fake.add(FakeNode {
            url: Some(MEET.into()),
            ..node(pid, "AXWebArea", &[controls, main])
        });
        let window = fake.add(FakeNode {
            title: Some(title.into()),
            ..node(pid, "AXWindow", &[web_area])
        });
        (window, markers)
    }

    fn speaking_driver(title: &str) -> (Driver<Fake>, Vec<usize>, usize, [RunningApp; 1]) {
        let mut fake = Fake::default();
        let (window, markers) = speaking_window(&mut fake, 10, title);
        let application = browser(&mut fake, 10, &[window]);
        fake.flags_on.insert(application);
        (Driver::new(fake), markers, window, [app(10, CHROME)])
    }

    fn sample(driver: &mut Driver<Fake>, slots: &[usize]) -> (SampleRead, Vec<Op>) {
        let before = driver.platform.ops.len();
        let clock = || Duration::ZERO;
        let read = driver.sample(slots, crate::speaking::SAMPLE_BUDGET, &clock);
        (read, driver.platform.ops[before..].to_vec())
    }

    #[test]
    fn a_reading_finds_each_tiles_marker_and_gives_it_the_short_timeout() {
        let (mut driver, markers, _, apps) = speaking_driver(MEET_TITLE);
        let first = tick(&mut driver, &apps);
        assert!(first.outcome.is_ok());
        let found = driver.speaking().expect("the reading looked");
        let names: Vec<&str> = found.tiles.iter().map(|tile| tile.name.as_str()).collect();
        assert_eq!(names, ["Alex Example", "Robin Sample", "Test Guest A"]);
        assert!(found.tiles.iter().all(|tile| tile.rules_ok && tile.single));
        assert!(found.tiles.iter().all(|tile| tile.previous.is_none()));
        assert!(!found.hidden);
        // One class list per candidate, and the short timeout on each marker.
        let class_reads: Vec<usize> = first
            .ops
            .iter()
            .filter_map(|op| match op {
                Op::ClassList(node) => Some(*node),
                _ => None,
            })
            .collect();
        assert_eq!(class_reads, markers);
        for marker in &markers {
            assert!(first.ops.contains(&Op::Quick(*marker)));
        }
        assert_eq!(driver.speaking(), None, "once per reading");

        // A sample reads the class lists of the markers and nothing else.
        driver
            .platform
            .classes
            .insert(markers[1], SPEAKING.to_vec());
        let (read, ops) = sample(&mut driver, &[0, 1, 2]);
        assert_eq!(
            ops,
            markers
                .iter()
                .map(|marker| Op::ClassList(*marker))
                .collect::<Vec<_>>()
        );
        assert_eq!(read.calls, 3);
        let tokens = crate::speaking::Tokens::of(
            Rules::embedded()
                .unwrap()
                .app(App::GoogleMeet)
                .unwrap()
                .speaking[0]
                .classes
                .as_ref()
                .unwrap(),
        );
        let marks: Vec<crate::speaking::Mark> = read
            .readings
            .iter()
            .map(|(_, reading)| match reading {
                crate::speaking::Reading::Classes(set) => tokens.classify(set),
                _ => crate::speaking::Mark::Unknown,
            })
            .collect();
        use crate::speaking::Mark::{Quiet, Speaking};
        assert_eq!(marks, [Quiet, Speaking, Quiet]);

        // The next reading knows each tile again.
        tick(&mut driver, &apps);
        let again = driver.speaking().unwrap();
        let previous: Vec<Option<usize>> = again.tiles.iter().map(|tile| tile.previous).collect();
        assert_eq!(previous, [Some(0), Some(1), Some(2)]);
    }

    #[test]
    fn a_minimised_window_or_another_tab_is_hidden() {
        let (mut driver, _, window, apps) = speaking_driver(MEET_TITLE);
        tick(&mut driver, &apps);
        assert!(!driver.speaking().unwrap().hidden);
        driver.platform.minimized.insert(window);
        tick(&mut driver, &apps);
        assert!(driver.speaking().unwrap().hidden);
        driver.platform.minimized.clear();
        // Another tab in front: the window's title no longer has the hint.
        driver.platform.nodes[window].title = Some("Inbox - Google Chrome".into());
        tick(&mut driver, &apps);
        assert!(driver.speaking().unwrap().hidden);
    }

    #[test]
    fn nothing_is_sampled_while_the_app_rests_and_the_markers_go_with_the_call() {
        let (mut driver, markers, _, apps) = speaking_driver(MEET_TITLE);
        tick(&mut driver, &apps);
        assert_eq!(driver.speaking().unwrap().tiles.len(), 3);
        // Two readings in a row time out: the app rests, and a sample reads nothing.
        driver.platform.hung_inside.insert(10);
        tick(&mut driver, &apps);
        assert_eq!(driver.speaking(), None, "a failed reading did not look");
        tick(&mut driver, &apps);
        assert_eq!(driver.speaking(), None);
        // Resting, the app has no call window to read: nothing is followed until it is read again.
        let resting = tick(&mut driver, &apps);
        assert_eq!(resting.outcome, NO_TARGET);
        assert_eq!(driver.speaking().unwrap().tiles, []);
        let (read, ops) = sample(&mut driver, &[0, 1, 2]);
        assert!(ops.is_empty());
        assert_eq!(read.calls, 0);
        assert!(read
            .readings
            .iter()
            .all(|(_, reading)| *reading == crate::speaking::Reading::Unknown));

        // The call ends: nothing is followed any more.
        let (mut driver, markers_again, _, apps) = speaking_driver(MEET_TITLE);
        assert_eq!(markers_again.len(), markers.len());
        tick(&mut driver, &apps);
        driver.speaking();
        let controls_gone = driver
            .platform
            .nodes
            .iter()
            .position(|node| node.title.as_deref() == Some("Call controls"));
        driver.platform.nodes[controls_gone.unwrap()].title = None;
        tick(&mut driver, &apps);
        assert_eq!(driver.speaking().unwrap().tiles, []);
        let (_, ops) = sample(&mut driver, &[0, 1, 2]);
        assert!(ops.is_empty());

        // Stopping forgets the markers.
        let (mut driver, _, _, apps) = speaking_driver(MEET_TITLE);
        tick(&mut driver, &apps);
        driver.stop();
        let (_, ops) = sample(&mut driver, &[0]);
        assert!(!ops.iter().any(|op| matches!(op, Op::ClassList(_))));
    }
}
