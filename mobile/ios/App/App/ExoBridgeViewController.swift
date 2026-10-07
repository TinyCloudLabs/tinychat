import Capacitor
import Darwin
import ExoCapture
import UIKit
#if DEBUG
import os
#endif

/// Registers Exo's app-local plugins with the Capacitor bridge.
/// SceneDelegate makes this the window's root (Main.storyboard names it too).
class ExoBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceNotesPlugin())
        #if EXO_HEALTH
        // Health spike (TC-525): Debug builds only (see HealthPlugin.swift).
        bridge?.registerPluginInstance(HealthPlugin())
        #endif
        #if DEBUG
        // TC-524 location spike: Debug builds only (LocationRecorder.swift). Release has no location code at all.
        bridge?.registerPluginInstance(LocationPlugin())
        startSmokeProbe()
        #endif
    }

    #if DEBUG
    // MARK: - Smoke probe (Debug builds only; Release compiles none of this)

    /// Once the bundled web app has mounted (or after `smokeProbeAttempts` seconds), log one `EXO_SMOKE {json}`
    /// line with what the WebView sees: its URL, the Capacitor platform, whether React rendered into #root,
    /// whether JS sees the VoiceNotes plugin, the plugin's own answer to `status()` over the bridge, and its
    /// `readAudioChunk` refusing a recording that does not exist; and the Location spike plugin's `status()` (TC-524).
    /// The CI simulator smoke test (mobile/scripts/ios-simulator-smoke.sh) gates on that line.
    private static let smokeProbeAttempts = 60
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
        return JSON.stringify(probe);
        """

    private var smokeProbeTimer: Timer?
    private var smokeProbeAttempt = 0

    private func startSmokeProbe() {
        let timer = Timer(timeInterval: 1, target: self, selector: #selector(runSmokeProbe), userInfo: nil, repeats: true)
        RunLoop.main.add(timer, forMode: .common)
        smokeProbeTimer = timer
    }

    @objc private func runSmokeProbe() {
        guard let webView = webView, smokeProbeTimer != nil else { return }
        smokeProbeAttempt += 1
        let lastAttempt = smokeProbeAttempt >= Self.smokeProbeAttempts
        webView.callAsyncJavaScript(Self.smokeProbeScript, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self, self.smokeProbeTimer != nil else { return }
            let line: String
            switch result {
            case .success(let value):
                line = (value as? String) ?? Self.smokeProbeError("non-string result")
            case .failure(let error):
                line = Self.smokeProbeError(error.localizedDescription)
            }
            guard line.contains(#""mounted":true"#) || lastAttempt else { return }
            self.smokeProbeTimer?.invalidate()
            self.smokeProbeTimer = nil
            let publish: (String) -> Void = { value in
                print("EXO_SMOKE \(value)")
                fflush(stdout)
                Logger(subsystem: "xyz.tinycloud.exo", category: "smoke").notice("EXO_SMOKE \(value, privacy: .public)")
                if ProcessInfo.processInfo.environment["EXO_QUICK_ACTION_SMOKE"] == "cold_warm" {
                    _ = AppLifecycleHooks.performShortcut(UIApplicationShortcutItem(
                        type: "xyz.tinycloud.exo.record", localizedTitle: "Record"))
                }
            }
            if ProcessInfo.processInfo.environment["EXO_CAPTURE_SMOKE"] == "1" {
                DispatchQueue.global(qos: .userInitiated).async {
                    var object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] ?? [:]
                    do { object["capture"] = try CaptureProbe.run() }
                    catch { object["capture"] = ["error": String(describing: error)] }
                    let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
                    let result = data.map { String(decoding: $0, as: UTF8.self) } ?? line
                    DispatchQueue.main.async { publish(result) }
                }
            } else { publish(line) }
            #if EXO_HEALTH
            self.startHealthProbe()
            #endif
            if ProcessInfo.processInfo.environment["EXO_LOCATION_SMOKE"] == "1" { self.runLocationProbe() }
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
