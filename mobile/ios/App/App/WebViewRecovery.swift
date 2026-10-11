import os
import WebKit

/// iOS can kill the WebView's content process while Exo is backgrounded. Capacitor answers that with
/// `webView.reload()`, but a terminated WKWebView has no `url`, so the reload does nothing and the screen stays blank.
/// This stands in as the navigation delegate, forwards everything to Capacitor's handler, and on termination
/// loads the address the user was on (or the app's start page when that is unknown or foreign).
final class WebViewRecovery: NSObject, WKNavigationDelegate {
    private let original: WKNavigationDelegate
    private let startURL: URL
    private var urlObservation: NSKeyValueObservation?
    private(set) var lastURL: URL?

    init(webView: WKWebView, startURL: URL, original: WKNavigationDelegate) {
        self.original = original
        self.startURL = startURL
        super.init()
        urlObservation = webView.observe(\.url, options: [.initial, .new]) { [weak self] webView, _ in
            self?.lastURL = webView.url
        }
        webView.navigationDelegate = self
    }

    static func restoreURL(lastURL: URL?, startURL: URL) -> URL {
        guard let lastURL, lastURL.scheme == startURL.scheme, lastURL.host == startURL.host,
              lastURL.port == startURL.port else { return startURL }
        return lastURL
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let target = Self.restoreURL(lastURL: lastURL, startURL: startURL)
        Logger(subsystem: "xyz.tinycloud.exo", category: "webview")
            .notice("WebView content process terminated; reloading \(target.path, privacy: .public)")
        webView.load(URLRequest(url: target))
    }

    override func forwardingTarget(for selector: Selector!) -> Any? { original }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || original.responds(to: selector)
    }
}
