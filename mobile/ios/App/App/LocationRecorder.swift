#if DEBUG
// TC-524 location spike: Debug builds only. Release compiles none of this, so a Release binary never links
// CoreLocation and needs no location purpose strings (App Store Connect rejects a binary that references
// location APIs without them, ITMS-90683). The Debug-only Info.plist keys are added at build time by
// App/location-spike-info-plist.sh. What shipping it would change: mobile/docs/location-spike.md.
import CoreLocation
import Foundation
import UIKit

/// Process-wide owner of location capture. Owned here, not by the plugin, because iOS relaunches a terminated app
/// in the background for significant-change and visit events with no scene and no WebView; AppDelegate then
/// resumes capture through `resumeAfterLaunch` and the samples wait in the queue for the web layer.
///
/// What the OS lets the app observe, reported by `snapshot()` and as "state" events: authorization (not determined /
/// denied / restricted / when in use / always), precise vs approximate, location services on/off, Low Power Mode,
/// Background App Refresh, the app's visibility, and the OS pausing updates (`pausedByOs`). Changes while capture is
/// wanted are queued too, so the stored trail carries the reasons for its gaps.
final class LocationRecorder: NSObject, CLLocationManagerDelegate {
    static let marker = "EXO_LOCATION_SPIKE"
    static let shared = LocationRecorder()

    static let modeContinuous = "continuous"
    static let modeLowPower = "low_power"

    private enum Key {
        static let installId = "exo.location.installId"
        static let desired = "exo.location.desired"
        static let mode = "exo.location.mode"
        static let background = "exo.location.background"
        static let distance = "exo.location.distanceM"
        static let startedAt = "exo.location.startedAt"
        static let lastSampleAt = "exo.location.lastSampleAt"
        static let lastStopReason = "exo.location.lastStopReason"
        static let askedAlways = "exo.location.askedAlways"
    }

    /// Whether capture was on when the process last ran; read without creating a CLLocationManager.
    static var captureWasOn: Bool { UserDefaults.standard.bool(forKey: Key.desired) }

    var onSample: (([String: Any]) -> Void)?
    var onState: (([String: Any]) -> Void)?

    private let manager = CLLocationManager()
    private let queue = LocationQueue()
    private let defaults = UserDefaults.standard
    private var lastSummary: [String: Any] = [:]
    private var standardActive = false
    private var significantActive = false
    private var visitsActive = false
    private var pausedByOs = false
    private var sessionSamples = 0
    private var permissionWaiters: [([String: Any]) -> Void] = []
    private var permissionTimer: Timer?
    private var promptShowing = false

    private override init() {
        dispatchPrecondition(condition: .onQueue(.main))
        super.init()
        if defaults.string(forKey: Key.installId) == nil {
            defaults.set(UUID().uuidString.lowercased(), forKey: Key.installId)
        }
        manager.delegate = self
        lastSummary = summary()
        let center = NotificationCenter.default
        for name in [
            UIApplication.didBecomeActiveNotification,
            UIApplication.didEnterBackgroundNotification,
            UIApplication.backgroundRefreshStatusDidChangeNotification,
            Notification.Name.NSProcessInfoPowerStateDidChange
        ] {
            center.addObserver(self, selector: #selector(osStateMayHaveChanged), name: name, object: nil)
        }
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    // MARK: - Control

    /// AppDelegate, at launch: capture was on when the process died, or iOS relaunched the app for a location event
    /// (significant change or visit; needs Always). Record the gap, then carry on with what the OS still allows.
    func resumeAfterLaunch(relaunchedForLocation: Bool) {
        guard defaults.bool(forKey: Key.desired) else {
            // A relaunch for monitoring this app no longer wants: switch it off so iOS stops waking us.
            manager.stopMonitoringSignificantLocationChanges()
            manager.stopMonitoringVisits()
            return
        }
        record("tracking", reason: relaunchedForLocation ? "relaunched_for_location" : "process_restarted")
        beginUpdates()
    }

    func start(mode: String, background: Bool, distanceM: Double) {
        stopUpdates()
        defaults.set(true, forKey: Key.desired)
        defaults.set(mode, forKey: Key.mode)
        defaults.set(background, forKey: Key.background)
        defaults.set(distanceM, forKey: Key.distance)
        defaults.set(Self.nowMs(), forKey: Key.startedAt)
        defaults.removeObject(forKey: Key.lastStopReason)
        sessionSamples = 0
        record("tracking", reason: "started")
        beginUpdates()
    }

    func stop(reason: String) {
        let wasDesired = defaults.bool(forKey: Key.desired)
        defaults.set(false, forKey: Key.desired)
        defaults.set(reason, forKey: Key.lastStopReason)
        stopUpdates()
        if wasDesired { record("tracking", reason: reason) }
    }

    /// foreground: When-In-Use prompt (once; afterwards only Settings can change it).
    /// background: the "Change to Always Allow" upgrade prompt, which iOS shows at most once.
    /// Resolves when the authorization changes, when the app comes back from a prompt, or after a short wait when
    /// iOS showed nothing.
    func requestPermission(background: Bool, done: @escaping ([String: Any]) -> Void) {
        let status = manager.authorizationStatus
        if background {
            guard status == .authorizedWhenInUse else {
                done(snapshot())
                return
            }
            defaults.set(true, forKey: Key.askedAlways)
            permissionWaiters.append(done)
            manager.requestAlwaysAuthorization()
        } else {
            guard status == .notDetermined else {
                done(snapshot())
                return
            }
            permissionWaiters.append(done)
            manager.requestWhenInUseAuthorization()
        }
        permissionTimer?.invalidate()
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            guard let self = self, !self.promptShowing else { return }
            self.resolvePermissionWaiters()
        }
    }

    // MARK: - Reading

    func pending(limit: Int) -> [[String: Any]] { queue.read(limit: limit) }

    func ack(throughSeq: Int64) -> Int { queue.ack(throughSeq: throughSeq) }

    var hasForegroundPermission: Bool {
        let status = manager.authorizationStatus
        return status == .authorizedWhenInUse || status == .authorizedAlways
    }

    /// Full status for JS.
    func snapshot() -> [String: Any] {
        var s = summary()
        let status = manager.authorizationStatus
        s["platform"] = "ios"
        s["installId"] = defaults.string(forKey: Key.installId) ?? ""
        switch status {
        case .authorizedAlways: s["backgroundRequest"] = "granted"
        case .authorizedWhenInUse: s["backgroundRequest"] = defaults.bool(forKey: Key.askedAlways) ? "settings" : "upgrade_prompt"
        default: s["backgroundRequest"] = "foreground_first"
        }
        s["declared"] = [
            "foreground": Self.infoString("NSLocationWhenInUseUsageDescription"),
            "background": Self.infoString("NSLocationAlwaysAndWhenInUseUsageDescription"),
            "backgroundExecution": Self.declaresBackgroundMode
        ]
        s["ios"] = [
            "authorizationStatus": Self.name(status),
            "backgroundRefresh": Self.name(UIApplication.shared.backgroundRefreshStatus),
            "significantChangeAvailable": CLLocationManager.significantLocationChangeMonitoringAvailable(),
            "allowsBackgroundLocationUpdates": manager.allowsBackgroundLocationUpdates,
            "systemVersion": UIDevice.current.systemVersion
        ] as [String: Any]
        var sources: [String] = []
        if standardActive { sources.append("standard") }
        if significantActive { sources.append("significant_change") }
        if visitsActive { sources.append("visits") }
        s["tracking"] = [
            "desired": defaults.bool(forKey: Key.desired),
            "active": !sources.isEmpty,
            "mode": defaults.string(forKey: Key.mode) ?? Self.modeContinuous,
            "background": defaults.object(forKey: Key.background) as? Bool ?? true,
            "sources": sources,
            "intervalMs": NSNull(),
            "distanceM": defaults.double(forKey: Key.distance),
            "startedAt": Self.nullable(defaults.object(forKey: Key.startedAt) as? Int64),
            "lastSampleAt": Self.nullable(defaults.object(forKey: Key.lastSampleAt) as? Int64),
            "sessionSamples": sessionSamples,
            "pausedByOs": pausedByOs,
            "lastStopReason": Self.orNull(defaults.string(forKey: Key.lastStopReason))
        ] as [String: Any]
        s["queue"] = ["pending": queue.count, "dropped": queue.dropped]
        return s
    }

    // MARK: - Updates

    private func beginUpdates() {
        stopUpdates()
        guard hasForegroundPermission else {
            record("error", reason: "no_permission")
            return
        }
        let mode = defaults.string(forKey: Key.mode) ?? Self.modeContinuous
        let background = defaults.object(forKey: Key.background) as? Bool ?? true
        let always = manager.authorizationStatus == .authorizedAlways
        // Setting this without UIBackgroundModes "location" throws (NSInternalInconsistencyException). With
        // When-In-Use authorization it still works for updates started in the foreground: they continue in the
        // background and iOS shows the blue location indicator in the status bar.
        manager.allowsBackgroundLocationUpdates = background && Self.declaresBackgroundMode
        manager.showsBackgroundLocationIndicator = true
        manager.pausesLocationUpdatesAutomatically = true
        manager.activityType = .other
        if mode == Self.modeLowPower {
            // Cell/Wi-Fi based, about 500 m and at most every 5 minutes; relaunches a terminated app, but only with
            // Always authorization. Visits: arrivals/departures at places the user stays.
            manager.startMonitoringSignificantLocationChanges()
            significantActive = true
            manager.startMonitoringVisits()
            visitsActive = true
        } else {
            manager.desiredAccuracy = kCLLocationAccuracyBest
            let distance = defaults.double(forKey: Key.distance)
            manager.distanceFilter = distance > 0 ? distance : kCLDistanceFilterNone
            manager.startUpdatingLocation()
            standardActive = true
            if always && background {
                // Safety net: wakes (or relaunches) the app after iOS pauses standard updates or the process dies.
                manager.startMonitoringSignificantLocationChanges()
                significantActive = true
            }
        }
    }

    private func stopUpdates() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.stopMonitoringVisits()
        standardActive = false
        significantActive = false
        visitsActive = false
        pausedByOs = false
    }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        checkOsState()
        if manager.authorizationStatus != .notDetermined, !promptShowing { resolvePermissionWaiters() }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if pausedByOs { pausedByOs = false; record("tracking", reason: "resumed") }
        if !standardActive, defaults.bool(forKey: Key.desired),
           defaults.string(forKey: Key.mode) == Self.modeContinuous,
           manager.authorizationStatus == .authorizedAlways {
            // A significant change woke us after an OS pause or a relaunch: restart the continuous trail.
            manager.startUpdatingLocation()
            standardActive = true
        }
        for location in locations { appendSample(location, source: standardActive ? "standard" : "significant_change") }
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        var sample = baseSample(at: visit.arrivalDate == .distantPast ? Date() : visit.arrivalDate, source: "visit")
        sample["lat"] = visit.coordinate.latitude
        sample["lon"] = visit.coordinate.longitude
        sample["accuracyM"] = visit.horizontalAccuracy >= 0 ? visit.horizontalAccuracy as Any : NSNull()
        sample["arrivalAt"] = visit.arrivalDate == .distantPast ? NSNull() as Any : Self.ms(visit.arrivalDate)
        sample["departureAt"] = visit.departureDate == .distantFuture ? NSNull() as Any : Self.ms(visit.departureDate)
        append(sample)
    }

    func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        // iOS decided the device is not moving. Updates do not resume by themselves: this app restarts them when it
        // is in the foreground again, or when a significant change wakes it (Always only). The gap starts here.
        pausedByOs = true
        standardActive = false
        record("tracking", reason: "paused_by_os")
    }

    func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
        pausedByOs = false
        record("tracking", reason: "resumed")
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let code = (error as? CLError)?.code
        if code == .locationUnknown { return } // transient: iOS keeps trying
        record("error", reason: code == .denied ? "denied" : "cl_error_\((error as NSError).code)", detail: error.localizedDescription)
    }

    // MARK: - OS state

    @objc private func osStateMayHaveChanged() {
        DispatchQueue.main.async { self.checkOsState() }
    }

    @objc private func willResignActive() {
        // A permission prompt makes the app inactive; wait for it to come back before answering.
        if !permissionWaiters.isEmpty { promptShowing = true }
    }

    @objc private func didBecomeActive() {
        if pausedByOs, defaults.bool(forKey: Key.desired) {
            // After an OS pause, updates never resume by themselves (and a When-In-Use app gets nothing more until it
            // is in use again): restart them now that the user is back.
            record("tracking", reason: "resumed_on_foreground")
            beginUpdates()
        }
        guard promptShowing else { return }
        promptShowing = false
        // The authorization callback can land just after the app is active again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.resolvePermissionWaiters() }
    }

    private func resolvePermissionWaiters() {
        permissionTimer?.invalidate()
        permissionTimer = nil
        let waiters = permissionWaiters
        permissionWaiters = []
        guard !waiters.isEmpty else { return }
        let status = snapshot()
        for waiter in waiters { waiter(status) }
    }

    func checkOsState() {
        let now = summary()
        let before = lastSummary
        let changed = Self.diffKeys.filter { String(describing: before[$0]) != String(describing: now[$0]) }
        guard !changed.isEmpty else { return }
        record(Self.changeKind(changed), reason: nil, changed: changed)
    }

    private static let diffKeys = ["permission", "accuracy", "servicesEnabled", "lowPowerMode", "backgroundRefresh", "appVisible"]

    private static func changeKind(_ changed: [String]) -> String {
        if changed.contains("permission") { return "permission" }
        if changed.contains("accuracy") { return "accuracy" }
        if changed.contains("servicesEnabled") { return "services" }
        if changed.contains("appVisible") { return "visibility" }
        return "power"
    }

    private func summary() -> [String: Any] {
        let status = manager.authorizationStatus
        let granted = status == .authorizedWhenInUse || status == .authorizedAlways
        return [
            "permission": Self.permission(status),
            "accuracy": granted ? (manager.accuracyAuthorization == .fullAccuracy ? "precise" : "approximate") as Any : NSNull(),
            "servicesEnabled": CLLocationManager.locationServicesEnabled(),
            "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "backgroundRefresh": Self.name(UIApplication.shared.backgroundRefreshStatus),
            "appVisible": UIApplication.shared.applicationState != .background
        ]
    }

    private func record(_ change: String, reason: String?, changed: [String]? = nil, detail: String? = nil) {
        lastSummary = summary()
        var event: [String: Any] = [
            "kind": "state",
            "at": Self.nowMs(),
            "change": change,
            "reason": Self.orNull(reason),
            "state": lastSummary
        ]
        if let changed = changed { event["changed"] = changed }
        if let detail = detail { event["detail"] = detail }
        print("\(Self.marker) \(change) \(reason ?? changed?.joined(separator: ",") ?? "")")
        if defaults.bool(forKey: Key.desired) || change == "tracking" { _ = queue.append(event) }
        onState?(event)
    }

    // MARK: - Samples

    private func appendSample(_ location: CLLocation, source: String) {
        var sample = baseSample(at: location.timestamp, source: source)
        sample["lat"] = location.coordinate.latitude
        sample["lon"] = location.coordinate.longitude
        sample["accuracyM"] = location.horizontalAccuracy >= 0 ? location.horizontalAccuracy as Any : NSNull()
        sample["altitudeM"] = location.verticalAccuracy >= 0 ? location.altitude as Any : NSNull()
        sample["verticalAccuracyM"] = location.verticalAccuracy >= 0 ? location.verticalAccuracy as Any : NSNull()
        sample["speedMps"] = location.speed >= 0 ? location.speed as Any : NSNull()
        sample["bearingDeg"] = location.course >= 0 ? location.course as Any : NSNull()
        // iOS 15+ (the deployment target): true for a simulated location (Xcode, the Simulator, a test device).
        if let info = location.sourceInformation {
            sample["mock"] = info.isSimulatedBySoftware
        }
        append(sample)
    }

    private func baseSample(at date: Date, source: String) -> [String: Any] {
        [
            "kind": "sample",
            "at": Self.ms(date),
            "receivedAt": Self.nowMs(),
            "provider": source,
            "mock": false,
            "accuracyAuthorization": manager.accuracyAuthorization == .fullAccuracy ? "precise" : "approximate",
            "mode": defaults.string(forKey: Key.mode) ?? Self.modeContinuous,
            "appVisible": UIApplication.shared.applicationState != .background
        ]
    }

    private func append(_ sample: [String: Any]) {
        var entry = sample
        entry["seq"] = queue.append(sample)
        sessionSamples += 1
        defaults.set(Self.nowMs(), forKey: Key.lastSampleAt)
        onSample?(entry)
    }

    // MARK: - Helpers

    private static var declaresBackgroundMode: Bool {
        (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String])?.contains("location") ?? false
    }

    private static func infoString(_ key: String) -> Bool {
        !((Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? "").isEmpty
    }

    private static func permission(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "prompt"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedWhenInUse: return "foreground"
        case .authorizedAlways: return "background"
        @unknown default: return "prompt"
        }
    }

    private static func name(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedWhenInUse: return "authorizedWhenInUse"
        case .authorizedAlways: return "authorizedAlways"
        @unknown default: return "unknown"
        }
    }

    private static func name(_ status: UIBackgroundRefreshStatus) -> String {
        switch status {
        case .available: return "available"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unknown"
        }
    }

    private static func nullable(_ value: Int64?) -> Any { value.map { $0 as Any } ?? NSNull() }

    /// Bridge-safe optional: JSON null instead of a boxed Swift Optional.
    private static func orNull(_ value: String?) -> Any { value.map { $0 as Any } ?? NSNull() }

    private static func ms(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970 * 1000) }

    private static func nowMs() -> Int64 { ms(Date()) }
}

/// On-device queue of samples and state events, one JSON object per line with a growing `seq`. Native code appends
/// (the WebView may be suspended in the background, or absent after a background relaunch); the web layer reads a
/// page, writes it to the user's TinyCloud space and acks it. Same contract as Android's LocationQueue.
/// The file uses the default data protection (complete until first unlock), so it is writable while locked.
final class LocationQueue {
    static let maxEntries = 20_000
    private static let nextSeqKey = "exo.location.queue.nextSeq"
    private static let droppedKey = "exo.location.queue.dropped"

    private let url: URL
    private let lock = NSLock()
    private(set) var count = 0

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("location", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("queue.jsonl")
        count = readAll().count
    }

    var dropped: Int { UserDefaults.standard.integer(forKey: Self.droppedKey) }

    /// Appends `entry` with the next seq; returns that seq.
    func append(_ entry: [String: Any]) -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        let defaults = UserDefaults.standard
        let seq = max(1, (defaults.object(forKey: Self.nextSeqKey) as? Int64) ?? 1)
        defaults.set(seq + 1, forKey: Self.nextSeqKey)
        var line = entry
        line["seq"] = seq
        guard var data = try? JSONSerialization.data(withJSONObject: line) else { return seq }
        data.append(0x0A)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            handle.closeFile()
        } else {
            try? data.write(to: url)
        }
        count += 1
        if count > Self.maxEntries {
            let all = readAll()
            let drop = all.count - Self.maxEntries * 9 / 10
            if drop > 0 {
                defaults.set(dropped + drop, forKey: Self.droppedKey)
                rewrite(Array(all.dropFirst(drop)))
            }
        }
        return seq
    }

    func read(limit: Int) -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return Array(readAll().prefix(limit))
    }

    /// Removes every entry at or below `throughSeq`; returns how many are left.
    func ack(throughSeq: Int64) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let keep = readAll().filter { (($0["seq"] as? NSNumber)?.int64Value ?? 0) > throughSeq }
        rewrite(keep)
        return keep.count
    }

    private func readAll() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return data.split(separator: 0x0A).compactMap { line in
            // A torn last line (process killed mid-write) is skipped.
            try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
        }
    }

    private func rewrite(_ entries: [[String: Any]]) {
        var out = Data()
        for entry in entries {
            guard let data = try? JSONSerialization.data(withJSONObject: entry) else { continue }
            out.append(data)
            out.append(0x0A)
        }
        if (try? out.write(to: url, options: .atomic)) != nil { count = entries.count }
    }
}
#endif
