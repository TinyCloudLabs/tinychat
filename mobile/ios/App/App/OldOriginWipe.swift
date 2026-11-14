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
final class OldOriginWipe: NSObject, WKNavigationDelegate, WKURLSchemeHandler {
    static let doneKey = "xyz.tinycloud.home.oldOriginWiped.v1"
    static let attemptsKey = "xyz.tinycloud.home.oldOriginWipe.attempts.v1"
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

    /// On the main thread, off the app WebView's first load; once per process. `appHost` is the host the app WebView
    /// serves the app from.
    static func startIfNeeded(appHost: String?, defaults: UserDefaults = .standard) {
        guard !ranThisProcess else { return }
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
        let url = urlSchemeTask.request.url ?? Self.oldPage
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
