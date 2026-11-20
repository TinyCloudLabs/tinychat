//! Run the call-names reader on a live call, and print what it read and where its time went.
//!
//! ```text
//! cargo run --release --example snapshot -- --app meet|zoom [--pid N --bundle ID] [--ticks N]
//!                                           [--every S] [--budget-ms MS] [--show-names]
//! cargo run --release --example snapshot -- --speaking [--hz 5] [--seconds S] [--show-names]
//!                                           [--pid N --bundle ID]
//! ```
//!
//! `--speaking` runs the app's own service on the Meet call, as a recording would: a names tick
//! every 5 s and a speaking sample `--hz` times a second in between (default 5), for `--seconds`
//! (default 600) or until Ctrl-C. Output, JSON lines on stdout:
//! - `meta`: the options and `startedWall` (seconds since 1970 when it started; the recording
//!   clock of the samples and the timeline starts there);
//! - per names tick, `tick`: the outcome, elements, time;
//! - per sample, `sample`: for each tile read its index, person id and `on`/`off`/`unknown` (a
//!   preliminary mark: the timeline keeps a sample once the next names tick confirms it), the
//!   round trips and the microseconds;
//! - at the end, `roster` (ids, names only with `--show-names`), `timeline` (the file the app
//!   would keep) and `cost` (p50 and p95 of a sample's time and round trips).
//!
//! No class name is ever shown. `tools/speaking-check.py` compares this output with the tester's
//! timed events.
//!
//! It runs the code the app runs: `Reader::read` once per tick. The terminal needs Accessibility
//! permission (System Settings > Privacy & Security > Accessibility). Output goes to stdout as
//! JSON lines:
//! - `meta`: the apps found and the options;
//! - per tick, `timing`: for each phase the round trips to the app, the elements and the time
//!   (search: window lists and titles, then the walk to the page; reading: the check of the known
//!   window, the page, the rules), and whether the page came from the cache;
//! - per tick, `full`: every node the reader scanned (role, subrole, identifier) and only the
//!   texts it actually read, in the ax-probe format, so `tools/scrub.py` can make a fixture of it;
//! - per tick, `result`: the outcome and what each source found;
//! - at the end, `roster`: the people as the app would save them.
//!
//! A line per tick with the same numbers also goes to stderr. Every text that is not an interface
//! label from the rules is shown as «length:hash» (the probe's hash) unless `--show-names` is
//! given; use that only in your own test calls. Ctrl-C stops after the current tick and puts back
//! the browser's accessibility flag.

#[cfg(target_os = "macos")]
fn main() {
    mac::main();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The snapshot example reads macOS Accessibility; it runs on macOS only.");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
mod mac {
    use call_names::ax::{
        app_kind, permission, NoNames, Permission, PhaseCost, Reader, RunningApp, TickStats,
        CHROMIUM_BROWSERS, SEARCH_BUDGET, ZOOM_BUNDLE_ID,
    };
    use call_names::extract::Extraction;
    use call_names::roster::Roster;
    use call_names::rules::{App, Rules};
    use call_names::session::{Budget, Skip};
    use call_names::tree::{flat, Node};
    use serde_json::{json, Value};
    use std::collections::HashSet;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    const USAGE: &str = "usage: snapshot --app meet|zoom [--pid N --bundle ID] [--ticks N] [--every S] [--budget-ms MS] [--show-names]\n       snapshot --speaking [--hz 5] [--seconds S] [--show-names] [--pid N --bundle ID]";

    /// App bundle names and executables, to find running processes with pgrep.
    const PROCESSES: [(&str, &str, &str); 8] = [
        ("Google Chrome", "Google Chrome", "com.google.Chrome"),
        (
            "Google Chrome Beta",
            "Google Chrome Beta",
            "com.google.Chrome.beta",
        ),
        ("Microsoft Edge", "Microsoft Edge", "com.microsoft.edgemac"),
        ("Brave Browser", "Brave Browser", "com.brave.Browser"),
        ("Arc", "Arc", "company.thebrowser.Browser"),
        ("Vivaldi", "Vivaldi", "com.vivaldi.Vivaldi"),
        ("Chromium", "Chromium", "org.chromium.Chromium"),
        ("zoom.us", "zoom.us", ZOOM_BUNDLE_ID),
    ];

    static STOP: AtomicBool = AtomicBool::new(false);

    extern "C" fn on_signal(_signal: i32) {
        STOP.store(true, Ordering::SeqCst);
    }

    unsafe extern "C" {
        fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
    }

    struct Options {
        app: App,
        pid: Option<i32>,
        bundle: Option<String>,
        ticks: usize,
        every: f64,
        budget: Budget,
        show_names: bool,
        speaking: bool,
        hz: f64,
        seconds: f64,
    }

    fn parse() -> Result<Options, String> {
        let mut options = Options {
            app: App::GoogleMeet,
            pid: None,
            bundle: None,
            ticks: 1,
            every: 5.0,
            budget: Budget::DEFAULT,
            show_names: false,
            speaking: false,
            hz: 5.0,
            seconds: 600.0,
        };
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
            match arg.as_str() {
                "--app" => {
                    options.app = match value()?.as_str() {
                        "meet" => App::GoogleMeet,
                        "zoom" => App::Zoom,
                        other => return Err(format!("unknown app {other}")),
                    }
                }
                "--pid" => options.pid = Some(value()?.parse().map_err(|_| "bad --pid")?),
                "--bundle" => options.bundle = Some(value()?),
                "--ticks" => options.ticks = value()?.parse().map_err(|_| "bad --ticks")?,
                "--every" => {
                    options.every = value()?.parse::<f64>().map_err(|_| "bad --every")?.max(0.5)
                }
                "--budget-ms" => {
                    options.budget.max_time =
                        Duration::from_millis(value()?.parse().map_err(|_| "bad --budget-ms")?)
                }
                "--show-names" => options.show_names = true,
                "--speaking" => options.speaking = true,
                "--hz" => {
                    options.hz = value()?
                        .parse::<f64>()
                        .map_err(|_| "bad --hz")?
                        .clamp(0.2, 10.0)
                }
                "--seconds" => {
                    options.seconds = value()?
                        .parse::<f64>()
                        .map_err(|_| "bad --seconds")?
                        .max(5.0)
                }
                other => return Err(format!("unknown option {other}")),
            }
        }
        if options.pid.is_some() != options.bundle.is_some() {
            return Err("--pid and --bundle go together".into());
        }
        Ok(options)
    }

    fn running_apps(options: &Options) -> Vec<RunningApp> {
        if let (Some(pid), Some(bundle)) = (options.pid, &options.bundle) {
            return vec![RunningApp {
                pid,
                bundle_id: bundle.clone(),
            }];
        }
        let wanted = |bundle: &str| match options.app {
            App::Zoom => bundle == ZOOM_BUNDLE_ID,
            App::GoogleMeet => CHROMIUM_BROWSERS.contains(&bundle),
        };
        let mut apps = Vec::new();
        for (app, executable, bundle) in PROCESSES
            .into_iter()
            .filter(|(_, _, bundle)| wanted(bundle))
        {
            let pattern = format!("{app}.app/Contents/MacOS/{executable}( |$)");
            let Ok(output) = Command::new("pgrep").args(["-f", &pattern]).output() else {
                continue;
            };
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Ok(pid) = line.trim().parse() {
                    apps.push(RunningApp {
                        pid,
                        bundle_id: bundle.to_owned(),
                    });
                }
            }
        }
        apps
    }

    /// Interface labels from the rules: shown as is.
    fn labels(rules: &Rules) -> HashSet<String> {
        let mut out = HashSet::new();
        for app in &rules.apps {
            let steps = app
                .in_call
                .iter()
                .chain(app.sources.iter().flat_map(|source| source.path.iter()));
            let matchers = app.prune.iter().chain(
                steps.flat_map(|step| std::iter::once(&step.matcher).chain(step.skip.iter())),
            );
            for matcher in matchers {
                out.extend(matcher.label.iter().flatten().cloned());
            }
            for source in &app.sources {
                out.extend(source.name.ignore.iter().cloned());
                if let Some(tags) = &source.name.suffix_tags {
                    out.extend(tags.tags.iter().cloned());
                }
                if let Some(marker) = &source.self_marker {
                    out.extend(marker.value.iter().cloned());
                }
            }
        }
        out
    }

    fn fnv(text: &str) -> u32 {
        text.bytes().fold(2_166_136_261u32, |hash, byte| {
            (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
        })
    }

    struct Shown<'a> {
        clear: &'a HashSet<String>,
        show_names: bool,
    }

    impl Shown<'_> {
        fn text(&self, text: &str) -> String {
            let count = text.chars().count();
            if self.show_names
                || self.clear.contains(text)
                || count <= 2
                || text.parse::<f64>().is_ok()
            {
                text.to_owned()
            } else {
                format!("«{count}:{:x}»", fnv(text))
            }
        }

        fn node(&self, node: &Node) -> Node {
            let shown = |text: &Option<String>| text.as_deref().map(|text| self.text(text));
            Node {
                title: shown(&node.title),
                description: shown(&node.description),
                value: shown(&node.value),
                url: None,
                children: node.children.iter().map(|child| self.node(child)).collect(),
                ..node.clone()
            }
        }

        fn extraction(&self, extraction: &Extraction) -> Value {
            let sources: Vec<Value> = extraction
                .sources
                .iter()
                .map(|source| {
                    let names: Vec<Value> = source
                        .entries
                        .iter()
                        .map(|entry| {
                            json!({ "name": self.text(entry.name.as_str()), "self": entry.is_self })
                        })
                        .collect();
                    json!({ "id": source.id, "names": names })
                })
                .collect();
            json!({ "sources": sources, "truncated": extraction.truncated })
        }
    }

    fn emit(value: Value) {
        println!("{value}");
    }

    fn ms(time: Duration) -> f64 {
        (time.as_secs_f64() * 100_000.0).round() / 100.0
    }

    /// One phase as JSON: round trips, elements, time, and time per round trip.
    fn cost(cost: PhaseCost) -> Value {
        let per_call = if cost.calls > 0 {
            ms(cost.time) / cost.calls as f64
        } else {
            0.0
        };
        json!({
            "calls": cost.calls,
            "nodes": cost.nodes,
            "ms": ms(cost.time),
            "msPerCall": (per_call * 1000.0).round() / 1000.0,
        })
    }

    fn outcome(result: &Result<Extraction, NoNames>) -> String {
        match result {
            Ok(_) => "names".into(),
            Err(NoNames::Unsupported) => "unsupported".into(),
            Err(NoNames::PermissionMissing) => "permission_missing".into(),
            Err(NoNames::Skip(Skip::NoTarget)) => "no_target".into(),
            Err(NoNames::Skip(Skip::NotInCall)) => "not_in_call".into(),
            Err(NoNames::Skip(Skip::SeveralInCall(count))) => format!("several_in_call:{count}"),
            Err(NoNames::Skip(Skip::Discarded(discard))) => format!("discarded:{discard:?}"),
        }
    }

    /// Where one tick's time went, for the output and for the eye.
    fn timing(
        snap: usize,
        at: Duration,
        tick: Duration,
        read: Duration,
        outcome: &str,
        stats: TickStats,
    ) -> (Value, String) {
        let search = stats.windows.time + stats.search.time;
        let value = json!({
            "kind": "timing",
            "snap": snap,
            "t": at.as_secs_f64(),
            "outcome": outcome,
            "tickMs": ms(tick),
            "search": {
                "ms": ms(search),
                "appsSearched": stats.apps_searched,
                "windowsAndTitles": cost(stats.windows),
                "candidateWindows": stats.candidate_windows,
                "walkToPage": cost(stats.search),
                "found": stats.found,
                "stoppedBy": stats.search_stopped.map(|stopped| format!("{stopped:?}")),
            },
            "reading": {
                "ms": ms(read),
                "fromCache": stats.from_cache,
                "forgotten": stats.forgotten,
                "checkOfKnownWindows": cost(stats.cached),
                "page": cost(stats.page),
                "rules": cost(stats.rules),
            },
        });
        let stopped = match stats.search_stopped {
            Some(stopped) => format!(", stopped by {stopped:?}"),
            None => String::new(),
        };
        let line = format!(
            "tick {snap}: {outcome} | search {:.1} ms (windows+titles {} calls, {} candidates, walk {} nodes {} calls, found {}{stopped}) | reading {:.1} ms (from cache {}, forgotten {}, check {} calls {:.1} ms, page {} nodes {} calls {:.1} ms, rules {} calls {:.1} ms)",
            ms(search),
            stats.windows.calls,
            stats.candidate_windows,
            stats.search.nodes,
            stats.search.calls,
            stats.found,
            ms(read),
            stats.from_cache,
            stats.forgotten,
            stats.cached.calls,
            ms(stats.cached.time),
            stats.page.nodes,
            stats.page.calls,
            ms(stats.page.time),
            stats.rules.calls,
            ms(stats.rules.time),
        );
        (value, line)
    }

    pub fn main() {
        let options = parse().unwrap_or_else(|error| {
            eprintln!("{error}\n{USAGE}");
            std::process::exit(64);
        });
        let rules = Rules::embedded().unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(70);
        });
        if permission() != Permission::Granted {
            eprintln!("Give this terminal Accessibility access (System Settings > Privacy & Security > Accessibility), then run again.");
            std::process::exit(2);
        }
        let apps: Vec<RunningApp> = running_apps(&options)
            .into_iter()
            .filter(|app| app_kind(&app.bundle_id).is_some())
            .collect();
        if apps.is_empty() {
            eprintln!("No running app to read. Start the call (Meet in Chrome, Edge, Brave, Arc, Vivaldi or Chromium; or Zoom), or pass --pid and --bundle.");
            std::process::exit(1);
        }
        unsafe {
            signal(2, on_signal);
            signal(15, on_signal);
        }
        let clear = labels(&rules);
        let shown = Shown {
            clear: &clear,
            show_names: options.show_names,
        };
        if options.speaking {
            speaking::run(&options, apps, &shown);
            return;
        }
        let mut reader = Reader::new();
        reader.keep_trees(true);
        let mut roster = Roster::new();
        let started = Instant::now();
        emit(json!({
            "kind": "meta",
            "tool": "call-names snapshot",
            "app": if options.app == App::Zoom { "zoom" } else { "meet" },
            "apps": apps.iter().map(|app| json!({ "bundleId": app.bundle_id, "pid": app.pid.to_string() })).collect::<Vec<_>>(),
            "ticks": options.ticks,
            "every": options.every,
            "budgetMs": options.budget.max_time.as_millis() as u64,
            "searchBudgetMs": SEARCH_BUDGET.max_time.as_millis() as u64,
            "redacted": !options.show_names,
        }));
        for snap in 0..options.ticks {
            if STOP.load(Ordering::SeqCst) {
                break;
            }
            let at = started.elapsed();
            let began = Instant::now();
            let report = reader.read(&rules, &apps, options.budget);
            let tick = began.elapsed();
            let what = outcome(&report.outcome);
            let (value, line) = timing(snap, at, tick, report.elapsed, &what, reader.stats());
            emit(value);
            eprintln!("{line}");

            let mut nodes = Vec::new();
            for (index, (_, tree)) in reader.last_trees().iter().enumerate() {
                nodes.extend(flat::to_flat(&shown.node(tree), &format!("t{index}")));
            }
            if !nodes.is_empty() {
                emit(json!({
                    "kind": "full", "snap": snap, "t": at.as_secs_f64(),
                    "took": report.elapsed.as_secs_f64(), "count": nodes.len(), "nodes": nodes,
                }));
            }
            let found = report
                .outcome
                .as_ref()
                .ok()
                .map(|extraction| shown.extraction(extraction));
            emit(json!({
                "kind": "result", "snap": snap, "t": at.as_secs_f64(), "outcome": what,
                "tookMs": ms(report.elapsed), "nodes": report.nodes, "found": found,
            }));
            if let Ok(extraction) = &report.outcome {
                roster.observe(at.as_millis() as u64, extraction);
            }

            let next = Duration::from_secs_f64(options.every * (snap + 1) as f64);
            while snap + 1 < options.ticks
                && started.elapsed() < next
                && !STOP.load(Ordering::SeqCst)
            {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        reader.stop();
        let people: Vec<Value> = roster
            .people()
            .iter()
            .map(|person| json!({ "id": person.id, "name": shown.text(person.name.as_str()), "self": person.is_self }))
            .collect();
        emit(
            json!({ "kind": "roster", "app": roster.app(), "people": people, "truncated": roster.truncated() }),
        );
        eprintln!(
            "Done after {:.1} s. The browser's accessibility flag is back to its earlier value.",
            started.elapsed().as_secs_f64()
        );
    }

    /// `--speaking`: the app's own service, with this terminal as its host.
    mod speaking {
        use super::{emit, Options, Shown, STOP};
        use call_names::ax::{Reader, RunningApp};
        use call_names::service::{
            Due, Host, Live, Pace, Report, SampleReport, Sampling, Schedule, Service, Store,
        };
        use call_names::speaking::Mark;
        use serde_json::{json, Value};
        use std::sync::atomic::Ordering;
        use std::sync::Mutex;
        use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

        /// The recording id of this run: a made-up one, as the app's ids look.
        const RECORDING: &str = "snapshot-speaking";

        struct Terminal {
            started: Instant,
            apps: Vec<RunningApp>,
            /// Per sample: microseconds and round trips.
            costs: Mutex<Vec<(u64, u64)>>,
        }

        impl Host for Terminal {
            fn live(&self) -> Option<Live> {
                Some(Live {
                    id: RECORDING.into(),
                    channels: 2,
                    recorded_ms: self.started.elapsed().as_millis() as u64,
                })
            }

            fn running(&self, bundle_id: &str) -> Vec<RunningApp> {
                self.apps
                    .iter()
                    .filter(|app| app.bundle_id == bundle_id)
                    .cloned()
                    .collect()
            }

            fn report(&self, report: &Report) {
                emit(json!({
                    "kind": "tick",
                    "t": self.started.elapsed().as_secs_f64(),
                    "outcome": report.outcome,
                    "nodes": report.nodes,
                    "tickMs": report.elapsed_ms,
                    "people": report.people,
                    "error": report.error,
                }));
            }

            fn sampled(&self, sample: &SampleReport) {
                let us = sample.elapsed.as_micros() as u64;
                if let Ok(mut costs) = self.costs.lock() {
                    costs.push((us, sample.calls));
                }
                let tiles: Vec<Value> = sample
                    .tiles
                    .iter()
                    .map(|(tile, person, mark)| {
                        let mark = match mark {
                            Mark::Speaking => "on",
                            Mark::Quiet => "off",
                            Mark::Unknown => "unknown",
                        };
                        json!({ "tile": tile, "person": person, "mark": mark })
                    })
                    .collect();
                emit(json!({
                    "kind": "sample",
                    "t": sample.at_ms as f64 / 1000.0,
                    "intervalMs": sample.interval_ms,
                    "tiles": tiles,
                    "calls": sample.calls,
                    "us": us,
                    "timedOut": sample.timed_out,
                    "kept": sample.kept,
                }));
            }
        }

        fn percentile(sorted: &[u64], share: f64) -> u64 {
            if sorted.is_empty() {
                return 0;
            }
            let index = ((sorted.len() - 1) as f64 * share).round() as usize;
            sorted[index.min(sorted.len() - 1)]
        }

        pub fn run(options: &Options, apps: Vec<RunningApp>, shown: &Shown) {
            let folder =
                std::env::temp_dir().join(format!("call-names-speaking-{}", std::process::id()));
            let store = Store::new(folder.join("call-names"));
            if let Err(error) = store.set_enabled(true) {
                eprintln!("cannot write {}: {error}", folder.display());
                std::process::exit(73);
            }
            let started_wall = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |since| since.as_secs_f64());
            let host = Terminal {
                started: Instant::now(),
                apps,
                costs: Mutex::new(Vec::new()),
            };
            let interval = Duration::from_secs_f64(1.0 / options.hz);
            emit(json!({
                "kind": "meta",
                "tool": "call-names snapshot --speaking",
                "startedWall": started_wall,
                "hz": options.hz,
                "intervalMs": interval.as_millis() as u64,
                "seconds": options.seconds,
                "apps": host.apps.iter().map(|app| json!({ "bundleId": app.bundle_id, "pid": app.pid.to_string() })).collect::<Vec<_>>(),
                "store": folder.display().to_string(),
                "redacted": !options.show_names,
            }));
            let mut service = Service::new(store.clone(), Reader::new(), Pace::default());
            service.set_sampling(Sampling {
                interval,
                write_every: Duration::from_secs(15),
            });
            let mut schedule = Schedule::default();
            let until = Duration::from_secs_f64(options.seconds);
            while !STOP.load(Ordering::SeqCst) && host.started.elapsed() < until {
                match schedule.due(host.started.elapsed()) {
                    Due::Names => {
                        let delay = service.tick(&host);
                        schedule.ticked(host.started.elapsed(), delay, service.sampling());
                    }
                    Due::Sample => {
                        let next = service.sample(&host);
                        schedule.sampled(host.started.elapsed(), next);
                    }
                    Due::Wait(wait) => std::thread::sleep(wait.min(Duration::from_millis(50))),
                }
            }
            service.finish();
            let roster = store.read(RECORDING).ok().flatten();
            let people: Vec<Value> = roster
                .iter()
                .flat_map(|participants| &participants.people)
                .map(|person| json!({ "id": person.id, "name": shown.text(person.name.as_str()), "self": person.is_self }))
                .collect();
            emit(json!({ "kind": "roster", "people": people }));
            match store.read_speaking(RECORDING) {
                Ok(Some(timeline)) => {
                    let value: Value =
                        serde_json::from_str(&timeline.to_json()).unwrap_or(Value::Null);
                    emit(json!({ "kind": "timeline", "timeline": value }));
                }
                Ok(None) => emit(json!({ "kind": "timeline", "timeline": null })),
                Err(error) => emit(json!({ "kind": "timeline", "error": error.to_string() })),
            }
            let costs = host
                .costs
                .lock()
                .map(|costs| costs.clone())
                .unwrap_or_default();
            let mut us: Vec<u64> = costs.iter().map(|(us, _)| *us).collect();
            let mut calls: Vec<u64> = costs.iter().map(|(_, calls)| *calls).collect();
            us.sort_unstable();
            calls.sort_unstable();
            emit(json!({
                "kind": "cost",
                "samples": costs.len(),
                "usP50": percentile(&us, 0.5),
                "usP95": percentile(&us, 0.95),
                "usMax": us.last().copied().unwrap_or(0),
                "callsP50": percentile(&calls, 0.5),
                "callsP95": percentile(&calls, 0.95),
            }));
            eprintln!(
                "Done after {:.1} s: {} samples. The browser's accessibility flag is back to its earlier value. Files: {}",
                host.started.elapsed().as_secs_f64(),
                costs.len(),
                folder.display()
            );
        }
    }
}
