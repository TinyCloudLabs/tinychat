import Capacitor
import os
import WebKit

/// TC-3045: the shell's WebView origin moved from capacitor://localhost to tinycloudone://app.tinycloud.one, so what
/// the web app stored at the old origin (including held answers and drafts whose 7-day expiry is only enforced when
/// they are read) is never read again. Once, after the switch, this deletes it.
///
/// `WKWebsiteDataStore.fetchDataRecords` cannot reach it: WebKit names data records only for http, https and file
/// origins (WebsiteDataRecord::displayNameForOrigin) and drops nameless origins from the list unless a private SPI is
/// set (WebsiteDataStore.cpp, CallbackAggregator::addWebsiteData). So a hidden WKWebView on the app's default data
/// store opens the old origin itself, from an empty page served by a "capacitor" scheme handler, and clears its
/// storage from JavaScript. Records named "localhost" (http(s) data such as cookies) are removed too.
///
/// The done flag is set only after every step succeeded within `timeout`. Each run counts as an attempt before it
/// starts, so a crash or hang mid-run counts too; an error or the timeout leaves the flag unset and the next launch
/// tries again, up to `OldOriginWipeAttempts.limit` attempts. A dev build served from http://localhost
/// (EXO_DEV_SERVER_URL) still lives on that site and is skipped.
///
/// Nothing is wiped before the web app has confirmed, on a launch after its import, that the copy is on disk at the new
/// origin (`OldOriginMigrationPlugin`): until then a launch starts no attempt and costs none. Once it has, the wipe
/// starts right after the confirm, or a few seconds into a later launch if that attempt didn't finish.
final class OldOriginWipe: NSObject, WKNavigationDelegate, WKURLSchemeHandler {
    static let doneKey = "xyz.tinycloud.home.oldOriginWiped.v1"
    static let attemptsKey = "xyz.tinycloud.home.oldOriginWipe.attempts.v1"
    /// Set by `OldOriginMigrationPlugin.ack` once the web app has imported the old origin's export.
    static let importedKey = "xyz.tinycloud.home.oldOriginImported.v1"
    /// Set by `OldOriginMigrationPlugin.confirm` once a later launch found the import on disk; the wipe waits for it.
    static let confirmedKey = "xyz.tinycloud.home.oldOriginImportConfirmed.v1"
    static let oldScheme = "capacitor"
    static let oldPage = URL(string: "capacitor://localhost/")!
    static let oldHost = "localhost"
    static let timeout: TimeInterval = 10

    /// Runs in the old origin's page; resolves to "wiped" only once every store is empty.
    static let clearScript = """
        localStorage.clear();
        sessionStorage.clear();
        for (const { name } of await indexedDB.databases()) {
          if (!name) continue;
          await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error("deleteDatabase failed"));
          });
        }
        if (window.caches) {
          for (const key of await caches.keys()) await caches.delete(key);
        }
        return "wiped";
        """

    /// The data records to remove: only the old http(s) site's. The new origin's data is not a listed record at all.
    static func isOldSiteRecord(displayName: String) -> Bool {
        displayName == oldHost
    }

    private static var ranThisProcess = false
    private static var running: OldOriginWipe?
    private static let log = Logger(subsystem: "xyz.tinycloud.exo", category: "webview")

    private let defaults: UserDefaults
    private let attempt: Int
    private var webView: WKWebView?
    private var deadline: DispatchWorkItem?

    private init(defaults: UserDefaults, attempt: Int) {
        self.defaults = defaults
        self.attempt = attempt
    }

    /// On the main thread, off the app WebView's first load; at most one attempt per process, and none before the web
    /// app has confirmed its copy of the old origin's export. `appHost` is the host the app WebView serves the app from.
    static func startIfNeeded(appHost: String?, defaults: UserDefaults = .standard) {
        guard !ranThisProcess else { return }
        guard defaults.bool(forKey: confirmedKey) else {
            log.notice("The old origin's WebView data stays until a launch after the import confirms the copy")
            return
        }
        ranThisProcess = true
        let decision = OldOriginWipeAttempts.decide(done: defaults.bool(forKey: doneKey),
                                                    attempts: defaults.integer(forKey: attemptsKey), appHost: appHost)
        switch decision {
        case .skip:
            return
        case .giveUp:
            giveUp(defaults)
        case .attempt(let number):
            defaults.set(number, forKey: attemptsKey)
            let wipe = OldOriginWipe(defaults: defaults, attempt: number)
            running = wipe
            wipe.start()
        }
    }

    private static func giveUp(_ defaults: UserDefaults) {
        defaults.set(OldOriginWipeAttempts.gaveUp, forKey: attemptsKey)
        log.notice("Gave up deleting the old origin's WebView data after \(OldOriginWipeAttempts.limit, privacy: .public) attempts")
    }

    private func start() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(self, forURLScheme: Self.oldScheme)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        self.webView = webView
        let deadline = DispatchWorkItem { [weak self] in self?.finish(failure: "timed out") }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout, execute: deadline)
        self.deadline = deadline
        webView.load(URLRequest(url: Self.oldPage))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript(Self.clearScript, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value as String) where value == "wiped":
                self.removeOldSiteRecords()
            case .success:
                self.finish(failure: "unexpected script result")
            case .failure(let error):
                self.finish(failure: error.localizedDescription)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(failure: error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(failure: error.localizedDescription)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        Self.serveBlankPage(urlSchemeTask)
    }

    /// The old origin's page for a hidden WebView: empty, so only the storage it can reach matters.
    static func serveBlankPage(_ urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url ?? oldPage
        let body = Data("<!doctype html><title></title>".utf8)
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "text/html; charset=utf-8"])
        urlSchemeTask.didReceive(response ?? URLResponse(url: url, mimeType: "text/html",
                                                         expectedContentLength: body.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func removeOldSiteRecords() {
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        store.fetchDataRecords(ofTypes: types) { [weak self] records in
            let old = records.filter { Self.isOldSiteRecord(displayName: $0.displayName) }
            store.removeData(ofTypes: types, for: old) { self?.finish(failure: nil) }
        }
    }

    private func finish(failure: String?) {
        guard let webView else { return }
        deadline?.cancel()
        deadline = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        self.webView = nil
        Self.running = nil
        if let failure {
            Self.log.notice("Deleting the old origin's WebView data failed (\(failure, privacy: .public))")
            if OldOriginWipeAttempts.givesUp(afterFailedAttempt: attempt) { Self.giveUp(defaults) }
        } else {
            defaults.set(true, forKey: Self.doneKey)
            Self.log.notice("Deleted the old origin's WebView data")
        }
    }
}

/// The attempt cap, free of WebKit and UserDefaults; it mirrors Android's OldOriginWipe.start.
enum OldOriginWipeAttempts {
    static let limit = 3
    /// Stored once the wipe has given up, so the give-up line is logged once.
    static let gaveUp = limit + 1

    enum Decision: Equatable {
        /// Done, already given up, or a dev build still served from the old site.
        case skip
        /// The last attempt never settled (the app died or hung): record the give-up and log it.
        case giveUp
        /// Store this attempt count, then start the attempt.
        case attempt(Int)
    }

    static func decide(done: Bool, attempts: Int, appHost: String?) -> Decision {
        if done || appHost?.lowercased() == OldOriginWipe.oldHost || attempts > Self.limit { return .skip }
        if attempts == Self.limit { return .giveUp }
        return .attempt(attempts + 1)
    }

    /// After attempt `number` failed: whether it was the last one.
    static func givesUp(afterFailedAttempt number: Int) -> Bool {
        number >= Self.limit
    }
}

/// TC-3045: runs a web app script (frontend/src/lib/oldOriginImport.ts) at the old origin in a hidden WKWebView at
/// capacitor://localhost, which loads only a blank page, and hands back the JSON it resolves: the export (reads only),
/// or the scrub of the old origin's sign-in token and session keys.
final class OldOriginExport: NSObject, WKNavigationDelegate, WKURLSchemeHandler {
    static let timeout: TimeInterval = 20
    private static var running: [OldOriginExport] = []

    private let allow: [String: Any]
    private let script: String
    private let completion: (Result<String, Error>) -> Void
    private var webView: WKWebView?
    private var deadline: DispatchWorkItem?

    private init(allow: [String: Any], script: String, completion: @escaping (Result<String, Error>) -> Void) {
        self.allow = allow
        self.script = script
        self.completion = completion
    }

    /// On the main thread. `script` is the body of an async function of `allow`; `completion` is called once.
    static func run(allow: [String: Any], script: String, completion: @escaping (Result<String, Error>) -> Void) {
        let export = OldOriginExport(allow: allow, script: script, completion: completion)
        running.append(export)
        export.start()
    }

    private func start() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(self, forURLScheme: OldOriginWipe.oldScheme)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        self.webView = webView
        let deadline = DispatchWorkItem { [weak self] in self?.finish(.failure(OldOriginExportError(reason: "timed out"))) }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout, execute: deadline)
        self.deadline = deadline
        webView.load(URLRequest(url: OldOriginWipe.oldPage))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript(script, arguments: ["allow": allow], in: nil, in: .page) { [weak self] result in
            switch result {
            case .success(let json as String):
                self?.finish(.success(json))
            case .success:
                self?.finish(.failure(OldOriginExportError(reason: "unexpected script result")))
            case .failure(let error):
                self?.finish(.failure(error))
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        OldOriginWipe.serveBlankPage(urlSchemeTask)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func finish(_ result: Result<String, Error>) {
        guard let webView else { return }
        deadline?.cancel()
        deadline = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        self.webView = nil
        Self.running.removeAll { $0 === self }
        completion(result)
    }
}

struct OldOriginExportError: LocalizedError {
    let reason: String
    var errorDescription: String? { reason }
}

/// The web app's side of the old origin's export and wipe (frontend/src/lib/oldOriginImport.ts); it mirrors Android's
/// OldOriginMigration. `take` hands over the export (saved first to an app-private file kept out of backups, and reused
/// by later launches until the copy is confirmed); `ack` marks the import and wipes nothing, because the WebView writes
/// localStorage to disk only after a short delay; on a later launch `confirm` (the web app found its marker, written
/// after every copied item, on disk) deletes the file and only then lets `OldOriginWipe` run. From launch
/// `scrubFromLaunch` on, while the copy is unconfirmed, `take` first runs the web app's scrub at the old origin, which
/// removes only its sign-in token and session keys.
public final class OldOriginMigrationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OldOriginMigrationPlugin"
    public let jsName = "OldOriginMigration"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirm", returnType: CAPPluginReturnPromise),
    ]
    static let scrubFromLaunch = 3
    static let launchesKey = "xyz.tinycloud.home.oldOriginImport.launches.v1"
    private static let log = Logger(subsystem: "xyz.tinycloud.exo", category: "webview")
    /// This process has counted its launch (a reload of the web app is not a launch).
    private static var launchCounted = false

    private static var exportFile: URL? {
        try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("old-origin-export.json")
    }

    /// On the main thread: counts this launch once per process and returns the launches counted so far.
    private static func countLaunch(_ defaults: UserDefaults) -> Int {
        let launches = defaults.integer(forKey: launchesKey)
        if launchCounted { return launches }
        launchCounted = true
        defaults.set(launches + 1, forKey: launchesKey)
        return launches + 1
    }

    /// Resolves `{state, data?}`: "skip" for a dev build still served from the old site, "done" once confirmed, or
    /// "export" (import, then ack) / "verify" (an earlier launch acked) with the export's JSON.
    @objc func take(_ call: CAPPluginCall) {
        guard let allow = call.options["allow"] as? [String: Any], let script = call.getString("script"),
              let scrub = call.getString("scrub") else {
            call.reject("allow, script and scrub are required")
            return
        }
        DispatchQueue.main.async { [weak self] in
            if self?.bridge?.config.appStartServerURL.host?.lowercased() == OldOriginWipe.oldHost {
                call.resolve(["state": "skip"])
                return
            }
            guard let file = Self.exportFile else {
                call.reject("Could not find the app's support directory")
                return
            }
            let defaults = UserDefaults.standard
            if defaults.bool(forKey: OldOriginWipe.confirmedKey) {
                // Left behind if the app died between the confirm's flag and the file's deletion.
                try? FileManager.default.removeItem(at: file)
                call.resolve(["state": "done"])
                return
            }
            let state = defaults.bool(forKey: OldOriginWipe.importedKey) ? "verify" : "export"
            guard Self.countLaunch(defaults) >= Self.scrubFromLaunch else {
                Self.handOver(call, state: state, file: file, allow: allow, script: script)
                return
            }
            OldOriginExport.run(allow: [:], script: scrub) { result in
                switch result {
                case .success(let json):
                    Self.log.notice("Removed the old origin's sign-in token and session keys; its other data stays until the copy is confirmed (\(json, privacy: .public))")
                case .failure(let error):
                    Self.log.notice("Could not remove the old origin's sign-in token and session keys (\(error.localizedDescription, privacy: .public)); the next launch tries again")
                }
                Self.handOver(call, state: state, file: file, allow: allow, script: script)
            }
        }
    }

    /// The file from an earlier launch, or a fresh export saved to the file before it is handed over.
    private static func handOver(_ call: CAPPluginCall, state: String, file: URL, allow: [String: Any], script: String) {
        if let existing = try? String(contentsOf: file, encoding: .utf8) {
            call.resolve(["state": state, "data": existing])
            return
        }
        OldOriginExport.run(allow: allow, script: script) { result in
            switch result {
            case .success(let json):
                do {
                    try Data(json.utf8).write(to: file, options: [.atomic])
                    var values = URLResourceValues()
                    values.isExcludedFromBackup = true
                    var saved = file
                    try saved.setResourceValues(values)
                } catch {
                    call.reject("Could not save the old origin's export (\(error.localizedDescription))")
                    return
                }
                Self.log.notice("Handing the old origin's export to the web app (\(state, privacy: .public), \(json.count, privacy: .public) chars)")
                call.resolve(["state": state, "data": json])
            case .failure(let error):
                let reason = "Could not export the old origin's data (\(error.localizedDescription))"
                Self.log.notice("\(reason, privacy: .public)")
                call.reject(reason)
            }
        }
    }

    @objc func ack(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UserDefaults.standard.set(true, forKey: OldOriginWipe.importedKey)
            Self.log.notice("The web app imported the old origin's export; the old origin stays until a later launch confirms the copy")
            call.resolve()
        }
    }

    @objc func confirm(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            UserDefaults.standard.set(true, forKey: OldOriginWipe.confirmedKey)
            if let file = Self.exportFile { try? FileManager.default.removeItem(at: file) }
            Self.log.notice("The web app confirmed the copy is on disk; deleted the export file")
            OldOriginWipe.startIfNeeded(appHost: self?.bridge?.config.appStartServerURL.host)
            call.resolve()
        }
    }
}
