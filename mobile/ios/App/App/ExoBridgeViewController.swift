import Capacitor
import UIKit
#if DEBUG
import os
#endif

/// Registers Exo's app-local plugins with the Capacitor bridge.
/// SceneDelegate makes this the window's root (Main.storyboard names it too).
class ExoBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceNotesPlugin())
        #if DEBUG
        startSmokeProbe()
        #endif
    }

    #if DEBUG
    // MARK: - Smoke probe (Debug builds only; Release compiles none of this)

    /// Once the bundled web app has mounted (or after `smokeProbeAttempts` seconds), log one `EXO_SMOKE {json}`
    /// line with what the WebView sees: its URL, the Capacitor platform, whether React rendered into #root,
    /// whether JS sees the VoiceNotes plugin, the plugin's own answer to `status()` over the bridge, and its
    /// `readAudioChunk` refusing a recording that does not exist. The CI simulator smoke test
    /// (mobile/scripts/ios-simulator-smoke.sh) gates on that line.
    private static let smokeProbeAttempts = 60
    private static let smokeProbeScript = """
        const cap = window.Capacitor;
        const root = document.getElementById("root");
        const headers = (cap && cap.PluginHeaders) || [];
        const probe = {
          href: location.href,
          readyState: document.readyState,
          platform: cap && cap.getPlatform ? cap.getPlatform() : null,
          mounted: !!root && root.childElementCount > 0,
          voiceNotesHeader: headers.some((h) => h.name === "VoiceNotes"),
          voiceNotesAvailable: !!(cap && cap.isPluginAvailable && cap.isPluginAvailable("VoiceNotes")),
          title: document.title,
        };
        if (probe.mounted && probe.voiceNotesHeader && cap.nativePromise) {
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000));
          try {
            probe.voiceNotesStatus = await Promise.race([cap.nativePromise("VoiceNotes", "status", {}), timeout]);
          } catch (error) {
            probe.voiceNotesStatus = { error: String((error && error.message) || error) };
          }
          try {
            const chunk = cap.nativePromise("VoiceNotes", "readAudioChunk", { id: "smoke-missing", offset: 0, length: 16 });
            probe.voiceNotesReadChunk = { resolved: await Promise.race([chunk, timeout]) };
          } catch (error) {
            probe.voiceNotesReadChunk = { code: (error && error.code) || null, error: String((error && error.message) || error) };
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
            print("EXO_SMOKE \(line)")
            Logger(subsystem: "xyz.tinycloud.exo", category: "smoke").notice("EXO_SMOKE \(line, privacy: .public)")
        }
    }

    private static func smokeProbeError(_ message: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: ["error": message]) else { return #"{"error":"unknown"}"# }
        return String(decoding: data, as: UTF8.self)
    }
    #endif
}
