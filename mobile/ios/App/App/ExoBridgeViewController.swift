import ActivityKit
import Capacitor
import CaptureCore
import Darwin
import ExoCapture
import ReplicaStore
import UIKit
import WebKit
#if DEBUG
import os
#endif

/// Capacitor's iOS bridge handler is registered for every frame and never checks which frame posted
/// (WebViewDelegationHandler: `contentController.add(self, name: "bridge")`; only the JS shim is main-frame only).
/// One frames other apps (TC-3568), so script in a frame could call native plugins straight through
/// `window.webkit.messageHandlers.bridge`. This stands in for that handler and passes on only the main frame's
/// messages, the rule Android's bridge already applies.
final class MainFrameBridgeMessages: NSObject, WKScriptMessageHandler {
    private weak var capacitor: WebViewDelegationHandler?

    init(_ capacitor: WebViewDelegationHandler) {
        self.capacitor = capacitor
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        capacitor?.userContentController(controller, didReceive: message)
    }
}

/// Registers Exo's app-local plugins with the Capacitor bridge.
/// SceneDelegate makes this the window's root (Main.storyboard names it too).
class ExoBridgeViewController: CAPBridgeViewController {
    private var webViewRecovery: WebViewRecovery?
    private var statusBarTapObserver: NSObjectProtocol?

    deinit {
        if let statusBarTapObserver { NotificationCenter.default.removeObserver(statusBarTapObserver) }
    }

    override open func capacitorDidLoad() {
        // Before the first page load (loadWebView runs from viewDidLoad). Capacitor's cleanUp() removes by this name.
        if let capacitor = webView?.uiDelegate as? WebViewDelegationHandler {
            capacitor.contentController.removeScriptMessageHandler(forName: "bridge")
            capacitor.contentController.add(MainFrameBridgeMessages(capacitor), name: "bridge")
        } else {
            fatalError("Capacitor's WebView delegation handler is missing; the bridge would accept every frame")
        }
        if let webView = webView, let start = bridge?.config.appStartServerURL, let original = webView.navigationDelegate {
            webViewRecovery = WebViewRecovery(webView: webView, startURL: start, original: original)
        }
        // The web app scrolls inside its own boxes, so UIKit's status-bar scroll-to-top (document only) does nothing there.
        // Capacitor swizzles UIStatusBarManager and posts this on every status-bar tap; the page answers the `statusTap`
        // window event (frontend/src/lib/statusTapScroll.ts), as @capacitor/status-bar would for Ionic.
        statusBarTapObserver = NotificationCenter.default.addObserver(forName: .capacitorStatusBarTapped, object: nil, queue: .main) { [weak self] _ in
            self?.bridge?.triggerWindowJSEvent(eventName: "statusTap")
        }
        bridge?.registerPluginInstance(VoiceNotesPlugin())
        bridge?.registerPluginInstance(OnDeviceSttPlugin())
        bridge?.registerPluginInstance(AppLockPlugin())
        bridge?.registerPluginInstance(AudioDiagnosticsPlugin())
        // TC-2862 native replica storage (flagged off in the web app until the SDK adapter lands).
        bridge?.registerPluginInstance(ReplicaStorePlugin())
        #if EXO_HEALTH
        // Health spike (TC-525): Debug builds only (see HealthPlugin.swift).
        bridge?.registerPluginInstance(HealthPlugin())
        #endif
        #if DEBUG
        if Bundle.main.bundleIdentifier == "xyz.tinycloud.home.dev" {
            bridge?.registerPluginInstance(ExoDevLogPlugin())
        }
        // TC-524 location spike: Debug builds only (LocationRecorder.swift). Release has no location code at all.
        bridge?.registerPluginInstance(LocationPlugin())
        webView?.configuration.userContentController.addUserScript(WKUserScript(
            source: Self.smokeSubframeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        startSmokeProbe()
        #endif
        #if EXO_FRAME_PROBE
        // CI-only frame probe (TC-3677, FrameProbe.swift): only the mobile workflow's Release simulator job compiles it.
        FrameProbe.install(bridge: bridge, webView: webView)
        #endif
    }

    #if DEBUG
    // MARK: - Smoke probe (Debug builds only; Release compiles none of this)

    // The fixture inherits the app's CSP. Deliver its script through WebKit instead of an inline script tag.
    private static let smokeSubframeName = "exo-smoke-subframe"
    private static let smokeSubframeKey = "exo.smoke.subframe"
    private static let smokeSubframeScript = """
        (() => {
          if (window === window.top || window.parent !== window.top ||
              location.href !== "about:srcdoc" || window.name !== "\(smokeSubframeName)") return;
          const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge;
          if (h) h.postMessage({ type: "message", pluginId: "Preferences", methodName: "set", callbackId: "exo-subframe",
            options: { key: "\(smokeSubframeKey)", value: "reached" } });
          parent.postMessage({ exoSubframe: typeof h }, "*");
        })();
        """

    /// Once the committed bundled web app has mounted, log one `EXO_SMOKE {json}`
    /// line with what the WebView sees: its URL, the Capacitor platform, whether React rendered into #root,
    /// whether JS sees the VoiceNotes plugin, the plugin's own answer to `status()` over the bridge, and its
    /// `readAudioChunk` refusing a recording that does not exist; and the Location spike plugin's `status()` (TC-524).
    /// The CI simulator smoke test (mobile/scripts/ios-simulator-smoke.sh) gates on that line.
    private static let smokeProbeScript = """
        const cap = window.Capacitor;
        const root = document.getElementById("root");
        const headers = (cap && cap.PluginHeaders) || [];
        const probe = {
          href: location.href,
          platform: cap && cap.getPlatform ? cap.getPlatform() : null,
          mounted: !!root && root.childElementCount > 0,
          voiceNotesHeader: headers.some((h) => h.name === "VoiceNotes"),
          voiceNotesAvailable: !!(cap && cap.isPluginAvailable && cap.isPluginAvailable("VoiceNotes")),
          healthHeader: headers.some((h) => h.name === "Health"),
          locationAvailable: !!(cap && cap.isPluginAvailable && cap.isPluginAvailable("Location")),
          // The web app's PWA service worker must never register in the shell (frontend/src/lib/pwa.ts).
          serviceWorkerDecision: document.documentElement.dataset.exoSw || null,
          serviceWorkerRegistrations: navigator.serviceWorker ?
            await Promise.race([navigator.serviceWorker.getRegistrations().then((items) => items.length),
              new Promise((resolve) => setTimeout(() => resolve(-1), 2000))]) : 0,
        };
        if (probe.mounted && probe.voiceNotesHeader && cap.nativePromise) {
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000));
          try {
            const status = await Promise.race([cap.nativePromise("VoiceNotes", "status", {}), timeout]);
            probe.voiceNotesStatus = { state: status.state, maxDurationMs: status.maxDurationMs };
          } catch (error) {
            probe.voiceNotesStatus = { error: String((error && error.message) || error) };
          }
          try {
            const chunk = cap.nativePromise("VoiceNotes", "readAudioChunk", { id: "00000000-0000-0000-0000-000000000001", offset: 0, length: 16 });
            probe.voiceNotesReadChunk = { resolved: await Promise.race([chunk, timeout]) };
          } catch (error) {
            probe.voiceNotesReadChunk = { code: (error && error.code) || null, error: String((error && error.message) || error) };
          }
          try {
            const before = await Promise.race([cap.nativePromise("VoiceNotes", "listInputs", {}), timeout]);
            await Promise.race([cap.nativePromise("VoiceNotes", "selectInput", { id: null }), timeout]);
            const after = await Promise.race([cap.nativePromise("VoiceNotes", "listInputs", {}), timeout]);
            probe.voiceNotesInputs = { listed: Array.isArray(before.inputs), reset: after.selectedId === null,
              count: after.inputs.length };
          } catch (error) {
            probe.voiceNotesInputs = { error: String((error && error.message) || error) };
          }
        }
        // Location spike (TC-524). Only the fields the smoke checks: unified logging truncates a line past about 1 KB.
        if (probe.mounted && probe.locationAvailable && cap.nativePromise) {
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000));
          try {
            const s = await Promise.race([cap.nativePromise("Location", "status", {}), timeout]);
            probe.locationStatus = { platform: s.platform, permission: s.permission, declared: s.declared };
          } catch (error) {
            probe.locationStatus = { error: String((error && error.message) || error) };
          }
        }
        // App lock (TC-2738): the smoke launches with EXO_APP_LOCK=off, so the plugin answers with no device security.
        if (probe.mounted && cap.nativePromise) {
          try {
            const s = await Promise.race([cap.nativePromise("AppLock", "status", {}),
              new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000))]);
            probe.appLock = { deviceSecure: s.deviceSecure };
          } catch (error) {
            probe.appLock = { error: String((error && error.message) || error) };
          }
        }
        // TC-3568: a frame inside the app must not reach native plugins through the bridge (MainFrameBridgeMessages).
        // The frame says whether it sees the bridge handler and posts Preferences.set straight to it; the key must stay unset.
        if (probe.mounted && cap.nativePromise) {
          const key = "\(smokeSubframeKey)";
          const frame = document.createElement("iframe");
          frame.name = "\(smokeSubframeName)";
          frame.hidden = true;
          frame.srcdoc = "<!doctype html><html><body></body></html>";
          try {
            await cap.nativePromise("Preferences", "remove", { key });
            const seen = new Promise((resolve) => {
              const finish = (value) => {
                clearTimeout(timeout);
                removeEventListener("message", onMessage);
                resolve(value);
              };
              const onMessage = ({ source, data }) => {
                if (source && source === frame.contentWindow &&
                    (data?.exoSubframe === "object" || data?.exoSubframe === "undefined")) finish(data.exoSubframe);
              };
              addEventListener("message", onMessage);
              const timeout = setTimeout(() => finish("no-report"), 3000);
            });
            document.body.appendChild(frame);
            const bridge = await seen;
            await new Promise((resolve) => setTimeout(resolve, 500));
            const stored = await cap.nativePromise("Preferences", "get", { key });
            probe.subframe = { bridge, leaked: stored.value !== null && stored.value !== undefined };
          } catch (error) {
            probe.subframe = { error: String((error && error.message) || error) };
          } finally {
            frame.remove();
          }
        }
        return JSON.stringify(probe);
        """

    private var smokeProbeTimer: Timer?
    private var smokeProbeInFlight = false

    private func startSmokeProbe() {
        let timer = Timer(timeInterval: 1, target: self, selector: #selector(runSmokeProbe), userInfo: nil, repeats: true)
        RunLoop.main.add(timer, forMode: .common)
        smokeProbeTimer = timer
    }

    @objc private func runSmokeProbe() {
        guard let webView = webView, smokeProbeTimer != nil, !smokeProbeInFlight else { return }
        smokeProbeInFlight = true
        webView.callAsyncJavaScript(Self.smokeProbeScript, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self, self.smokeProbeTimer != nil else { return }
            self.smokeProbeInFlight = false
            let line: String
            switch result {
            case .success(let value):
                line = (value as? String) ?? Self.smokeProbeError("non-string result")
            case .failure(let error):
                line = Self.smokeProbeError(error.localizedDescription)
            }
            // A page at about:blank can outlive the old 60-second timer; publish only after the app page mounts.
            guard line.contains(#""href":"capacitor://localhost"#), line.contains(#""mounted":true"#) else { return }
            self.smokeProbeTimer?.invalidate()
            self.smokeProbeTimer = nil
            print("EXO_WEB_APP_READY")
            fflush(stdout)
            Logger(subsystem: "xyz.tinycloud.exo", category: "smoke").notice("EXO_WEB_APP_READY")
            let publish: (String) -> Void = { value in
                print("EXO_SMOKE \(value)")
                fflush(stdout)
                Logger(subsystem: "xyz.tinycloud.exo", category: "smoke").notice("EXO_SMOKE \(value, privacy: .public)")
                if ProcessInfo.processInfo.environment["EXO_QUICK_ACTION_SMOKE"] == "cold_warm" {
                    _ = AppLifecycleHooks.performShortcut(UIApplicationShortcutItem(
                        type: "xyz.tinycloud.exo.record", localizedTitle: "Record"))
                }
                // The quick-action smoke owns the recording in that run.
                if ProcessInfo.processInfo.environment["EXO_SHORTCUT_SMOKE"] == "1",
                   ProcessInfo.processInfo.environment["EXO_QUICK_ACTION_SMOKE"] == nil { self.runShortcutProbe() }
            }
            if ProcessInfo.processInfo.environment["EXO_CAPTURE_SMOKE"] == "1" {
                DispatchQueue.global(qos: .userInitiated).async {
                    var object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] ?? [:]
                    do {
                        let capture = try CaptureProbe.run()
                        object["capture"] = capture
                        object["recovery"] = capture["recovery"]
                    }
                    catch { object["capture"] = ["error": String(describing: error)] }
                    let account = CaptureEngine.shared.defaults()
                    UserDefaults.standard.set("3", forKey: "exo.debug.failAccountState")
                    do {
                        try CaptureEngine.shared.setAccountState(status: "signed_out", accountDid: nil,
                                                                 transitionGen: account.transitionGen)
                        object["accountFailpoint"] = "failed"
                    } catch {
                        object["accountFailpoint"] = (error as? CaptureError)?.code == "io_failed" ? "ok" : "failed"
                    }
                    UserDefaults.standard.removeObject(forKey: "exo.debug.failAccountState")
                    DispatchQueue.main.async {
                        object["transitions"] = CaptureEngine.shared.simulate("transitions")
                        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
                        publish(data.map { String(decoding: $0, as: UTF8.self) } ?? line)
                    }
                }
            } else { publish(line) }
            #if EXO_HEALTH
            self.startHealthProbe()
            #endif
            if ProcessInfo.processInfo.environment["EXO_LOCATION_SMOKE"] == "1" { self.runLocationProbe() }
            if let phase = ProcessInfo.processInfo.environment["EXO_REPLICA_SMOKE"] { self.runReplicaProbe(phase) }
        }
    }

    /// TC-2862: with `EXO_REPLICA_SMOKE=write|read|wipe`, drive the TinyCloudReplicaStore plugin over the bridge and
    /// log one `EXO_REPLICA_SMOKE {json}` line with what JS saw plus the replica directory and Keychain items.
    /// `write` starts clean and stores two entries; `read`, after an app restart, reads them back; `wipe` runs the
    /// sign-out wipe (`wipe(account)` then `wipeAll()`, as frontend/src/lib/replication/nativeReplicaStore.ts does).
    private static let replicaProbeScript = """
        const cap = window.Capacitor;
        const call = (method, args) => Promise.race([
          cap.nativePromise("TinyCloudReplicaStore", method, args || {}),
          new Promise((_, reject) => setTimeout(() => reject(new Error(method + " timed out")), 8000)),
        ]);
        const account = "did:pkh:eip155:1:0x00000000000000000000000000000000000a11ce";
        const out = { phase, available: !!(cap.isPluginAvailable && cap.isPluginAvailable("TinyCloudReplicaStore")) };
        const readBack = async () => {
          out.value = (await call("get", { store: "entries", key: "smoke/a" })).value;
          out.keys = (await call("list", { store: "entries", prefix: "smoke/" })).entries.map((e) => e.key);
        };
        try {
          if (phase === "write") {
            await call("wipeAll");
            out.open = await call("open", { account });
            await call("write", { ops: [
              { op: "put", store: "entries", key: "smoke/a", value: "aGVsbG8gcmVwbGljYQ==" },
              { op: "put", store: "entries", key: "smoke/b", value: "c2Vjb25k" },
            ] });
            await readBack();
          } else if (phase === "read") {
            out.open = await call("open", { account });
            await readBack();
            out.estimate = await call("estimate");
          } else if (phase === "wipe") {
            await call("wipe", { account });
            await call("wipeAll");
            out.afterWipe = await call("get", { store: "entries", key: "smoke/a" }).then(() => "resolved", (e) => e.code);
          }
        } catch (error) {
          out.error = String((error && error.message) || error);
          out.code = (error && error.code) || null;
        }
        return JSON.stringify(out);
        """

    private func runReplicaProbe(_ phase: String) {
        webView?.callAsyncJavaScript(Self.replicaProbeScript, arguments: ["phase": phase], in: nil, in: .page) { result in
            var object: [String: Any]
            switch result {
            case .success(let value):
                object = (value as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) }
                    as? [String: Any] ?? ["error": "non-string result"]
            case .failure(let error):
                object = ["error": error.localizedDescription]
            }
            let directory = try? ReplicaStoreCore.defaultDirectory()
            object["files"] = directory.flatMap { try? FileManager.default.contentsOfDirectory(atPath: $0.path) }?.sorted() ?? []
            object["keychainItems"] = KeychainSecretStore().count()
            let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            let line = data.map { String(decoding: $0, as: UTF8.self) } ?? Self.smokeProbeError("unencodable")
            print("EXO_REPLICA_SMOKE \(line)")
            fflush(stdout)
            Logger(subsystem: "xyz.tinycloud.exo", category: "smoke").notice("EXO_REPLICA_SMOKE \(line, privacy: .public)")
        }
    }

    /// TC-524: with `EXO_LOCATION_SMOKE=1` in the launch environment (the smoke script passes it, with location
    /// granted and a simulated position set), start a continuous capture, wait, read the native queue and stop.
    /// Logs one `EXO_LOCATION_SMOKE {json}` line: evidence that the iOS capture path records samples, from CI.
    private static let locationProbeScript = """
        const cap = window.Capacitor;
        const call = (method, args) => Promise.race([
          cap.nativePromise("Location", method, args || {}),
          new Promise((_, reject) => setTimeout(() => reject(new Error(method + " timed out")), 8000)),
        ]);
        // Compact (unified logging truncates a line past about 1 KB): the fields the smoke summary reports.
        const out = {};
        try {
          const before = await call("status");
          out.before = { permission: before.permission, accuracy: before.accuracy, backgroundRequest: before.backgroundRequest };
          const started = await call("start", { mode: "continuous", background: true });
          out.started = { active: started.tracking.active, sources: started.tracking.sources };
          await new Promise((resolve) => setTimeout(resolve, 15000));
          const page = await call("pending", { limit: 50 });
          const sample = page.entries.find((e) => e.kind === "sample");
          out.pending = {
            pending: page.pending,
            samples: page.entries.filter((e) => e.kind === "sample").length,
            states: page.entries.filter((e) => e.kind === "state").map((e) => e.change + ":" + e.reason),
            sample: sample && { lat: sample.lat, lon: sample.lon, accuracyM: sample.accuracyM, provider: sample.provider, mock: sample.mock },
          };
          const stopped = await call("stop");
          out.stopped = { active: stopped.tracking.active, lastStopReason: stopped.tracking.lastStopReason, sessionSamples: stopped.tracking.sessionSamples };
        } catch (error) {
          out.error = String((error && error.message) || error);
        }
        return JSON.stringify(out);
        """

    private func runLocationProbe() {
        webView?.callAsyncJavaScript(Self.locationProbeScript, arguments: [:], in: nil, in: .page) { result in
            let line: String
            switch result {
            case .success(let value):
                line = (value as? String) ?? Self.smokeProbeError("non-string result")
            case .failure(let error):
                line = Self.smokeProbeError(error.localizedDescription)
            }
            print("EXO_LOCATION_SMOKE \(line)")
            Logger(subsystem: "xyz.tinycloud.exo", category: "smoke").notice("EXO_LOCATION_SMOKE \(line, privacy: .public)")
        }
    }

    /// With `EXO_SHORTCUT_SMOKE=1`, once the main probe has published: run the App Shortcut's start path
    /// (`RecordingShortcut`, which StartRecordingIntent and the quick action call), check the engine, the Live
    /// Activity and the bridge all see the recording with its source, that a second shortcut keeps the same
    /// recording, then discard it and check the activity ends. Logs one `EXO_SHORTCUT_SMOKE {json}` line.
    private static let shortcutBridgeScript = """
        const status = await Promise.race([window.Capacitor.nativePromise("VoiceNotes", "status", {}),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000))]);
        return JSON.stringify({ state: status.state, source: status.source, id: status.id });
        """

    private func runShortcutProbe() {
        Task { @MainActor [weak self] in
            var out: [String: Any] = [:]
            let activeIDs = { Activity<RecordingActivityAttributes>.activities
                .filter { $0.activityState == .active }.map(\.attributes.recordingId) }
            do {
                try await RecordingShortcut.start(.intent, foreground: .already)
                let status = CaptureEngine.shared.status()
                let id = status["id"] as? String
                out["started"] = id != nil
                out["state"] = status["state"]
                out["source"] = status["source"]
                out["activity"] = id.map { activeIDs().contains($0) } ?? false
                if let webView = self?.webView {
                    let value = try await webView.callAsyncJavaScript(Self.shortcutBridgeScript, contentWorld: .page)
                    let bridge = (value as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: Any]
                    out["bridge"] = ["state": bridge?["state"] ?? NSNull(), "source": bridge?["source"] ?? NSNull(),
                                     "sameId": (bridge?["id"] as? String) == id]
                }
                try await RecordingShortcut.start(.control, foreground: .already)
                out["secondKeptRecording"] = CaptureEngine.shared.status()["id"] as? String == id
                out["discarded"] = try CaptureEngine.shared.discard() == id
                for _ in 0..<50 where !activeIDs().isEmpty { try await Task.sleep(for: .milliseconds(100)) }
                out["activityEnded"] = activeIDs().isEmpty
            } catch {
                out["error"] = String(describing: error)
            }
            let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
            let line = data.map { String(decoding: $0, as: UTF8.self) } ?? Self.smokeProbeError("unserializable")
            print("EXO_SHORTCUT_SMOKE \(line)")
            fflush(stdout)
            Logger(subsystem: "xyz.tinycloud.exo", category: "smoke").notice("EXO_SHORTCUT_SMOKE \(line, privacy: .public)")
        }
    }

    #if EXO_HEALTH
    // MARK: - HealthKit probe (Debug builds, and only when launched with EXO_HEALTH_PROBE=1)

    /// The CI HealthKit spike (mobile/scripts/ios-health-probe.sh) launches an ad-hoc signed build with
    /// SIMCTL_CHILD_EXO_HEALTH_PROBE=1. Once the smoke probe has seen React mount, this drives the Health plugin over
    /// the bridge the way the web app would, logging one `EXO_HEALTH_PROBE {"stage":…,"response":…}` line per step:
    /// availability and status, a read-only authorization request (the product's), then the write request the
    /// sample data needs (the script answers each Health sheet, if it can), sample data, a 7-day read and
    /// background delivery. Before each request it logs `requesting-<stage>` so the script knows a sheet is up.
    private static let healthProbeSteps: [(stage: String, method: String, args: [String: Any])] = [
        ("availability", "availability", [:]),
        ("status", "authorizationStatus", [:]),
        ("authorized-read", "requestAuthorization", [:]),
        ("authorized-write", "requestAuthorization", ["sampleWrite": true]),
        ("inserted", "insertSampleData", [:]),
        ("read", "readDailySummaries", ["days": 7]),
        ("background", "enableBackgroundDelivery", ["types": ["steps"]]),
        ("status-after", "authorizationStatus", [:]),
        ("read-steps-only", "readDailySummaries", ["days": 3, "types": ["steps"]])
    ]
    private static let healthProbeScript = """
        try {
          return JSON.stringify({ ok: true, result: await window.Capacitor.nativePromise("Health", method, args) });
        } catch (error) {
          return JSON.stringify({ ok: false, code: (error && error.code) || null, message: String((error && error.message) || error) });
        }
        """

    private func startHealthProbe() {
        guard ProcessInfo.processInfo.environment["EXO_HEALTH_PROBE"] == "1" else { return }
        runHealthProbeStep(0)
    }

    private func runHealthProbeStep(_ index: Int) {
        guard index < Self.healthProbeSteps.count, let webView = webView else {
            logHealthProbe(stage: "done", response: "{}")
            return
        }
        let step = Self.healthProbeSteps[index]
        if step.method == "requestAuthorization" { logHealthProbe(stage: "requesting-\(step.stage)", response: "{}") }
        let arguments: [String: Any] = ["method": step.method, "args": step.args]
        webView.callAsyncJavaScript(Self.healthProbeScript, arguments: arguments, in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let value):
                self.logHealthProbe(stage: step.stage, response: (value as? String) ?? Self.smokeProbeError("non-string result"))
            case .failure(let error):
                self.logHealthProbe(stage: step.stage, response: Self.smokeProbeError(error.localizedDescription))
            }
            self.runHealthProbeStep(index + 1)
        }
    }

    private func logHealthProbe(stage: String, response: String) {
        let line = "{\"stage\":\"\(stage)\",\"response\":\(response)}"
        print("EXO_HEALTH_PROBE \(line)")
        Logger(subsystem: "xyz.tinycloud.exo", category: "health").notice("EXO_HEALTH_PROBE \(line, privacy: .public)")
    }
    #endif

    private static func smokeProbeError(_ message: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: ["error": message]) else { return #"{"error":"unknown"}"# }
        return String(decoding: data, as: UTF8.self)
    }
    #endif
}
