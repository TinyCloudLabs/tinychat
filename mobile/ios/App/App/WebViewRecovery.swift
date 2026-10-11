import os
import UIKit
import WebKit

/// Allows a few automatic recoveries in a short window, so a content process that keeps dying cannot loop forever.
struct RecoveryBudget {
    static let maxAutomatic = 2
    static let window: TimeInterval = 60

    private var deaths: [TimeInterval] = []

    /// Records a death; true while it is still within the automatic budget.
    mutating func recordDeath(at now: TimeInterval) -> Bool {
        deaths.removeAll { now - $0 >= Self.window }
        deaths.append(now)
        return deaths.count <= Self.maxAutomatic
    }

    mutating func reset() { deaths.removeAll() }
}

/// iOS can kill the WebView's content process while Exo is backgrounded. Capacitor answers that with
/// `webView.reload()`, which may recover nothing once the WebView has lost its `url`.
/// This stands in as the navigation delegate, forwards everything to Capacitor's handler, and on termination
/// loads the address the user was on (or the app's start page when that is unknown or foreign). If the process
/// keeps dying it stops and shows a native Reload prompt instead.
final class WebViewRecovery: NSObject, WKNavigationDelegate {
    private let original: WKNavigationDelegate
    private let startURL: URL
    private var urlObservation: NSKeyValueObservation?
    private var budget = RecoveryBudget()
    private var prompt: UIView?
    private(set) var lastURL: URL?

    init(webView: WKWebView, startURL: URL, original: WKNavigationDelegate) {
        self.original = original
        self.startURL = startURL
        super.init()
        // The url goes nil when the content process dies; the last real address is what recovery needs.
        urlObservation = webView.observe(\.url, options: [.initial, .new]) { [weak self] webView, _ in
            if let url = webView.url { self?.lastURL = url }
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
        let log = Logger(subsystem: "xyz.tinycloud.exo", category: "webview")
        guard budget.recordDeath(at: ProcessInfo.processInfo.systemUptime) else {
            log.notice("WebView content process keeps terminating; waiting for the user to reload")
            showPrompt(over: webView, target: target)
            return
        }
        log.notice("WebView content process terminated; reloading \(target.path, privacy: .public)")
        webView.load(URLRequest(url: target))
    }

    private func showPrompt(over webView: WKWebView, target: URL) {
        prompt?.removeFromSuperview()
        let overlay = UIView(frame: webView.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = .systemBackground

        let title = UILabel()
        title.text = "Exo needs to reload"
        title.font = .preferredFont(forTextStyle: .title2)
        title.textColor = .label
        let message = UILabel()
        message.text = "Something interrupted Exo while it was in the background. Reload to pick up where you left off."
        message.font = .preferredFont(forTextStyle: .callout)
        message.textColor = .secondaryLabel
        for label in [title, message] {
            label.numberOfLines = 0
            label.textAlignment = .center
            label.adjustsFontForContentSizeCategory = true
        }
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Reload"
        let button = UIButton(configuration: configuration, primaryAction: UIAction { [weak self, weak webView] _ in
            guard let self, let webView else { return }
            self.budget.reset()
            self.prompt?.removeFromSuperview()
            self.prompt = nil
            webView.load(URLRequest(url: target))
        })

        // The labels fill the stack's width so they wrap; the button sits centered in a row of its own.
        button.translatesAutoresizingMaskIntoConstraints = false
        let buttonRow = UIView()
        buttonRow.addSubview(button)
        NSLayoutConstraint.activate([
            button.centerXAnchor.constraint(equalTo: buttonRow.centerXAnchor),
            button.topAnchor.constraint(equalTo: buttonRow.topAnchor),
            button.bottomAnchor.constraint(equalTo: buttonRow.bottomAnchor),
            button.leadingAnchor.constraint(greaterThanOrEqualTo: buttonRow.leadingAnchor),
            button.trailingAnchor.constraint(lessThanOrEqualTo: buttonRow.trailingAnchor),
        ])
        let stack = UIStackView(arrangedSubviews: [title, message, buttonRow])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Centered while it fits; scrolls when large text makes it taller than the screen.
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let content = UIView()
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)
        content.addSubview(stack)
        overlay.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.trailingAnchor),
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            content.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24),
        ])
        webView.addSubview(overlay)
        prompt = overlay
    }

    override func forwardingTarget(for selector: Selector!) -> Any? { original }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || original.responds(to: selector)
    }
}
