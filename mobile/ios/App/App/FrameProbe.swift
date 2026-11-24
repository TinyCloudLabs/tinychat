#if EXO_FRAME_PROBE
// CI only (TC-3677). Compiled only with EXO_FRAME_PROBE, which only the mobile workflow's Release simulator job sets
// (mobile/scripts/ios-frame-probe.sh gates on what this logs). The release archive check fails if the shipped binary
// contains the EXO_FRAME_PROBE marker.
import Capacitor
import ObjectiveC
import UIKit
import WebKit
import os

/// Checks, on the build One ships, that an app in a frame inside One cannot reach the native bridge and cannot take
/// over One's main view. Once the bundled app has mounted it adds three frames (frames One opens use the same
/// `sandbox`):
/// - `opaque`: srcdoc, One's sandbox without allow-same-origin, so a cross-origin frame with no network;
/// - `unsandboxed`: srcdoc with no sandbox at all, so only the native guards stand in its way;
/// - `explorer`: One's real Explorer frame (`https://explorer.tinycloud.xyz/?embed=one`, One's sandbox), when it loads.
/// In each frame a user script posts a `ping` for this probe's plugin and a `Preferences.set` straight to
/// `window.webkit.messageHandlers.bridge`. Neither may reach Capacitor: the plugin counts pings, the main frame
/// counts answers for the frames' callback ids, and the Preferences keys must stay unset. Then each frame calls
/// `window.open` and clicks a `target=_blank` and a `target=_top` link: every URL must be handed to the system
/// (`UIApplication.open`, which this probe holds until the end), and One's main frame must keep its page.
/// Logs one `EXO_FRAME_PROBE {json}` line; then opens the first held URL for real and logs
/// `EXO_FRAME_PROBE_HANDOFF {json}` with whether the system opened it.
final class FrameProbe: NSObject {
    static private(set) var shared: FrameProbe?

    static let frameIds = ["opaque", "unsandboxed", "explorer"]
    private static let actions = ["window-open", "blank", "top"]
    /// FramedAppScreen.tsx's SANDBOX.
    private static let oneSandbox = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
    /// registry.ts frameUrl() for Explorer in a production build.
    private static let explorerURL = "https://explorer.tinycloud.xyz/?embed=one"

    private weak var webView: WKWebView?
    private let navigation: FrameProbeNavigation
    private let messages = FrameProbeMessages()
    private let marker = UUID().uuidString
    private var frames: [String: (info: WKFrameInfo, report: [String: Any])] = [:]
    fileprivate var pings: [String] = []
    fileprivate var holdingOpens = false
    private var held: [(url: URL, options: [UIApplication.OpenExternalURLOptionsKey: Any], completion: ((Bool) -> Void)?)] = []

    private init(webView: WKWebView, navigation: FrameProbeNavigation) {
        self.webView = webView
        self.navigation = navigation
        super.init()
    }

    static func install(bridge: CAPBridgeProtocol?, webView: WKWebView?) {
        guard shared == nil, let bridge, let webView, let original = webView.navigationDelegate else {
            publish(["error": "no bridge or web view to probe"])
            return
        }
        bridge.registerPluginInstance(ExoFrameProbePlugin())
        let probe = FrameProbe(webView: webView, navigation: FrameProbeNavigation(webView: webView, original: original))
        shared = probe
        UIApplication.exoFrameProbeSwizzleOpen()
        probe.messages.onMessage = { [weak probe] message in probe?.frameReported(message) }
        let content = webView.configuration.userContentController
        content.add(probe.messages, name: "exoFrameProbe")
        content.addUserScript(WKUserScript(source: frameScript, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        Task { @MainActor in await probe.run() }
    }

    // MARK: - Scripts

    /// Runs in every frame (a WKUserScript, and inline in the srcdoc frames); acts only in the probe's own frames.
    private static let frameScript = """
        (() => {
          const prefix = "exo-frame-probe:";
          const name = String(window.name || "");
          if (window === window.top || !name.startsWith(prefix) || window.__exoFrameProbeRan) return;
          window.__exoFrameProbeRan = true;
          const handlers = window.webkit && window.webkit.messageHandlers;
          const report = handlers && handlers.exoFrameProbe;
          if (!report) return;
          const id = name.slice(prefix.length);
          const bridge = handlers.bridge;
          const posted = [];
          const post = (pluginId, methodName, options) => {
            try {
              bridge.postMessage({ type: "message", pluginId, methodName, options, callbackId: "exo-frame-" + id + "-" + methodName });
              posted.push(pluginId + "." + methodName);
            } catch (error) {
              posted.push(pluginId + "." + methodName + ":" + String((error && error.message) || error));
            }
          };
          if (bridge) {
            post("ExoFrameProbe", "ping", { from: id });
            post("Preferences", "set", { key: "exo.frameprobe." + id, value: "reached" });
          }
          report.postMessage({ frame: id, bridge: typeof bridge, posted, origin: String(location.origin) });
        })();
        """

    /// Main frame, once mounted: count answers to the frames' callback ids, prove the plugin answers the main frame,
    /// clear the frames' Preferences keys, add the frames. "not-ready" until the bundled app has mounted.
    private static let setupScript = """
        const cap = window.Capacitor;
        const root = document.getElementById("root");
        if (!cap || !cap.nativePromise || !location.href.startsWith("capacitor://localhost") || !root || root.childElementCount === 0) return "not-ready";
        if (window.__exoFrameProbe) return "not-ready";
        const state = { marker, answers: [] };
        window.__exoFrameProbe = state;
        const fromNative = cap.fromNative;
        cap.fromNative = function (result) {
          const id = String((result && result.callbackId) || "");
          if (id.startsWith("exo-frame-")) state.answers.push(id);
          return fromNative.apply(this, arguments);
        };
        const timeout = (ms = 5000) => new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms));
        const out = { href: location.href };
        // A slow simulator launch can answer One's own ping after 5 s (TC-4259), so this one call gets 30 s.
        const started = Date.now();
        try {
          const answer = await Promise.race([cap.nativePromise("ExoFrameProbe", "ping", { from: "main" }), timeout(30000)]);
          out.answered = !!answer && answer.pong === true;
        } catch (error) {
          out.answered = false;
          out.error = String((error && error.message) || error);
        }
        out.ms = Date.now() - started;
        for (const frame of frames) {
          try { await Promise.race([cap.nativePromise("Preferences", "remove", { key: "exo.frameprobe." + frame.id }), timeout()]); } catch {}
        }
        const holder = document.createElement("div");
        holder.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:40%;display:flex;gap:4px;padding:4px;" +
          "z-index:2147483647;background:#fff;border-top:3px solid #c00;box-sizing:border-box";
        for (const frame of frames) {
          const element = document.createElement("iframe");
          element.name = "exo-frame-probe:" + frame.id;
          element.title = "Frame probe: " + frame.id;
          if (frame.sandbox !== null) element.setAttribute("sandbox", frame.sandbox);
          element.setAttribute("allow", "clipboard-write");
          element.referrerPolicy = "strict-origin";
          element.style.cssText = "flex:1;min-width:0;height:100%;border:1px solid #888";
          if (frame.src !== null) element.src = frame.src;
          else element.srcdoc = "<!doctype html><meta name=viewport content='width=device-width'>" +
            "<body style='font:13px -apple-system;margin:6px'><p>Frame probe: " + frame.id + "</p><script>" + frameScript + "</scr" + "ipt>";
          holder.appendChild(element);
        }
        document.body.appendChild(holder);
        return JSON.stringify(out);
        """

    /// In a probe frame: open `url` the three ways an app could. Each runs as its own call, so each has a user gesture.
    private static let actionScript = """
        if (action === "window-open") {
          const opened = window.open(url, "_blank");
          return opened === null ? "null" : "window";
        }
        const link = document.createElement("a");
        link.href = url;
        link.target = action === "top" ? "_top" : "_blank";
        if (action === "blank") link.rel = "noopener noreferrer";
        link.textContent = action;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return "clicked";
        """

    /// Main frame, at the end: still the same page, and what reached it.
    private static let verifyScript = """
        const cap = window.Capacitor;
        const state = window.__exoFrameProbe;
        const out = { href: location.href, marker: !!state && state.marker === marker, answers: state ? state.answers.length : -1, stored: {} };
        for (const id of ids) {
          try {
            const result = await Promise.race([cap.nativePromise("Preferences", "get", { key: "exo.frameprobe." + id }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000))]);
            out.stored[id] = result.value === undefined ? null : result.value;
          } catch (error) {
            out.stored[id] = "error:" + String((error && error.message) || error);
          }
        }
        return JSON.stringify(out);
        """

    // MARK: - Run

    @MainActor
    private func run() async {
        var setup: [String: Any]?
        var startURL: String?
        let frameSpecs: [[String: Any]] = Self.frameIds.map { (id: String) -> [String: Any] in
            switch id {
            case "opaque":
                return ["id": id, "sandbox": Self.oneSandbox.replacingOccurrences(of: " allow-same-origin", with: ""), "src": NSNull()]
            case "unsandboxed":
                return ["id": id, "sandbox": NSNull(), "src": NSNull()]
            default:
                return ["id": id, "sandbox": Self.oneSandbox, "src": Self.explorerURL]
            }
        }
        for _ in 0..<240 {
            try? await Task.sleep(for: .seconds(1))
            guard let webView else { return }
            let value = try? await webView.callAsyncJavaScript(Self.setupScript, arguments: [
                "marker": marker, "frames": frameSpecs, "frameScript": Self.frameScript,
            ], in: nil, contentWorld: .page)
            if let text = value as? String, text != "not-ready", let object = Self.object(text) {
                setup = object
                startURL = webView.url?.absoluteString
                break
            }
        }
        guard let setup, let webView else {
            Self.publish(["error": "the bundled app never mounted"])
            return
        }

        // The local frames report at once; Explorer loads over the network.
        let framesAdded = Date()
        while Date().timeIntervalSince(framesAdded) < 30, !Self.frameIds.allSatisfy({ frames[$0] != nil }) {
            try? await Task.sleep(for: .milliseconds(500))
        }
        // Let any bridge message a frame posted be dispatched and answered.
        try? await Task.sleep(for: .seconds(2))

        holdingOpens = true
        navigation.recording = true
        var results: [String: [String: String]] = [:]
        for id in Self.frameIds {
            guard let frame = frames[id] else { continue }
            for action in Self.actions {
                let url = Self.actionURL(frame: id, action: action)
                do {
                    let value = try await webView.callAsyncJavaScript(Self.actionScript, arguments: ["action": action, "url": url],
                                                                      in: frame.info, contentWorld: .page)
                    results[id, default: [:]][action] = (value as? String) ?? "non-string"
                } catch {
                    results[id, default: [:]][action] = "error:" + error.localizedDescription
                }
            }
        }
        try? await Task.sleep(for: .seconds(2))
        navigation.recording = false

        let verifyValue = try? await webView.callAsyncJavaScript(Self.verifyScript, arguments: [
            "marker": marker, "ids": Self.frameIds,
        ], in: nil, contentWorld: .page)
        let verify = (verifyValue as? String).flatMap(Self.object) ?? ["error": "verify failed"]
        let handed = Set(held.map { $0.url.absoluteString })

        var frameOut: [String: Any] = [:]
        for id in Self.frameIds {
            guard let frame = frames[id] else {
                frameOut[id] = ["ready": false]
                continue
            }
            var entry = frame.report
            entry["ready"] = true
            entry["open"] = results[id]?["window-open"] ?? "not-run"
            entry["blankClick"] = results[id]?["blank"] ?? "not-run"
            entry["topClick"] = results[id]?["top"] ?? "not-run"
            entry["openHanded"] = handed.contains(Self.actionURL(frame: id, action: "window-open"))
            entry["blankHanded"] = handed.contains(Self.actionURL(frame: id, action: "blank"))
            entry["topHanded"] = handed.contains(Self.actionURL(frame: id, action: "top"))
            frameOut[id] = entry
        }
        let mainHref = setup["href"] as? String ?? ""
        let unchanged = (verify["href"] as? String) == mainHref && (verify["marker"] as? Bool) == true
            && webView.url?.absoluteString == startURL
        #if DEBUG
        let configuration = "Debug"
        #else
        let configuration = "Release"
        #endif
        Self.publish([
            "configuration": configuration,
            "main": [
                "href": mainHref, "answered": setup["answered"] ?? false, "unchanged": unchanged,
                "error": setup["error"] ?? NSNull(), "ms": setup["ms"] ?? NSNull(), "marker": verify["marker"] ?? false,
            ] as [String: Any],
            "pings": ["main": pings.filter { $0 == "main" }.count, "framed": pings.filter { $0 != "main" }.count],
            "answers": verify["answers"] ?? -1,
            "stored": verify["stored"] ?? [String: Any](),
            "frames": frameOut,
            "topNavigations": ["attempted": navigation.topAttempts, "allowed": navigation.topAllowed],
            "handed": handed.count,
        ])

        // Leave One on screen for the script's screenshot, then let the system open the first held URL for real.
        try? await Task.sleep(for: .seconds(5))
        holdingOpens = false
        guard let first = held.first else {
            Self.publish(handoff: true, ["held": 0, "opened": false])
            return
        }
        var opened: Bool?
        UIApplication.shared.exoFrameProbeOpen(first.url, options: first.options) { success in
            opened = success
            first.completion?(success)
        }
        for _ in 0..<40 where opened == nil { try? await Task.sleep(for: .milliseconds(250)) }
        Self.publish(handoff: true, [
            "held": held.count, "url": first.url.absoluteString, "opened": opened ?? false, "answered": opened != nil,
        ])
    }

    private func frameReported(_ message: WKScriptMessage) {
        guard !message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let id = body["frame"] as? String,
              Self.frameIds.contains(id), frames[id] == nil else { return }
        frames[id] = (message.frameInfo, [
            "bridge": body["bridge"] ?? "missing", "posted": body["posted"] ?? [Any](), "origin": body["origin"] ?? "",
        ])
    }

    fileprivate func hold(_ url: URL, _ options: [UIApplication.OpenExternalURLOptionsKey: Any], _ completion: ((Bool) -> Void)?) {
        held.append((url, options, completion))
    }

    private static func actionURL(frame: String, action: String) -> String {
        "https://example.com/exo-frame-probe/\(frame)/\(action)"
    }

    private static func object(_ text: String) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
    }

    /// The os_log format strings carry the markers, so the release archive check finds `EXO_FRAME_PROBE` in any binary
    /// with this probe (a short Swift string literal can be stored inline, out of reach of grep).
    private static func publish(handoff: Bool = false, _ object: [String: Any]) {
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let line = data.map { String(decoding: $0, as: UTF8.self) } ?? #"{"error":"unserializable"}"#
        let logger = Logger(subsystem: "xyz.tinycloud.exo", category: "frame-probe")
        if handoff {
            print("EXO_FRAME_PROBE_HANDOFF \(line)")
            logger.notice("EXO_FRAME_PROBE_HANDOFF \(line, privacy: .public)")
        } else {
            print("EXO_FRAME_PROBE \(line)")
            logger.notice("EXO_FRAME_PROBE \(line, privacy: .public)")
        }
        fflush(stdout)
    }
}

/// Answers `ping` and records who asked. Any ping that is not the main frame's reached native from a frame.
public final class ExoFrameProbePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ExoFrameProbePlugin"
    public let jsName = "ExoFrameProbe"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "ping", returnType: CAPPluginReturnPromise)]

    @objc func ping(_ call: CAPPluginCall) {
        let from = call.getString("from") ?? "unknown"
        DispatchQueue.main.async { FrameProbe.shared?.pings.append(from) }
        call.resolve(["pong": true])
    }
}

/// The probe's own message handler, for every frame (the frames report here, never through the bridge).
final class FrameProbeMessages: NSObject, WKScriptMessageHandler {
    var onMessage: ((WKScriptMessage) -> Void)?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        onMessage?(message)
    }
}

/// Stands in as the navigation delegate (in front of WebViewRecovery and Capacitor) and, while recording, counts
/// navigations of One's main frame and how many were allowed.
final class FrameProbeNavigation: NSObject, WKNavigationDelegate {
    private let original: WKNavigationDelegate
    var recording = false
    private(set) var topAttempts = 0
    private(set) var topAllowed = 0

    init(webView: WKWebView, original: WKNavigationDelegate) {
        self.original = original
        super.init()
        webView.navigationDelegate = self
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let counted = recording && navigationAction.targetFrame?.isMainFrame == true
        if counted { topAttempts += 1 }
        let decide: (WKNavigationActionPolicy) -> Void = { [weak self] policy in
            if counted, policy == .allow { self?.topAllowed += 1 }
            decisionHandler(policy)
        }
        if original.webView?(webView, decidePolicyFor: navigationAction, decisionHandler: decide) == nil { decide(.allow) }
    }

    override func forwardingTarget(for selector: Selector!) -> Any? { original }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || original.responds(to: selector)
    }
}

extension UIApplication {
    /// After `exoFrameProbeSwizzleOpen`, `open(_:options:completionHandler:)` runs this and this selector runs
    /// UIKit's. While the probe holds, a URL handed to the system is recorded instead of opened.
    @objc(exoFrameProbeOpenURL:options:completionHandler:)
    dynamic func exoFrameProbeOpen(_ url: URL, options: [UIApplication.OpenExternalURLOptionsKey: Any] = [:],
                                   completionHandler: ((Bool) -> Void)? = nil) {
        if let probe = FrameProbe.shared, probe.holdingOpens {
            probe.hold(url, options, completionHandler)
            return
        }
        exoFrameProbeOpen(url, options: options, completionHandler: completionHandler)
    }

    static func exoFrameProbeSwizzleOpen() {
        guard let uikit = class_getInstanceMethod(UIApplication.self, NSSelectorFromString("openURL:options:completionHandler:")),
              let probe = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.exoFrameProbeOpen(_:options:completionHandler:)))
        else { fatalError("frame probe: UIApplication.open(_:options:completionHandler:) not found") }
        method_exchangeImplementations(uikit, probe)
    }
}
#endif
