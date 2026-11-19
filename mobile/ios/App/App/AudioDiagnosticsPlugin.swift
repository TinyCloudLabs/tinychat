import AVFoundation
import Capacitor
import Foundation
import UIKit

/// Playback diagnostics (TC-2857), off unless the user turns them on in Settings: the audio session's category, mode,
/// options and route, every route change and interruption, and the device's thermal state and Low Power Mode, with
/// timestamps. The web app (frontend/src/lib/audio/playbackDiagnostics.ts) owns the log and its export; this plugin
/// only reports what iOS says. It observes nothing until `setEnabled({ enabled: true })`.
public final class AudioDiagnosticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioDiagnosticsPlugin"
    public let jsName = "AudioDiagnostics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
    ]

    private var observers: [NSObjectProtocol] = []

    deinit { stopObserving() }

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            if enabled { self.startObserving() } else { self.stopObserving() }
            call.resolve(Self.snapshot())
        }
    }

    @objc func snapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(Self.snapshot()) }
    }

    private func startObserving() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        func watch(_ name: Notification.Name, _ kind: String, _ details: @escaping (Notification) -> [String: Any]) {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                var event = Self.snapshot()
                event["event"] = kind
                for (key, value) in details(note) { event[key] = value }
                self?.notifyListeners("event", data: event)
            })
        }
        watch(AVAudioSession.routeChangeNotification, "route_change") { note in
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
            let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            return ["reason": Self.routeChangeReason(raw),
                    "previousOutputs": previous.map { Self.ports($0.outputs) } ?? [],
                    "previousInputs": previous.map { Self.ports($0.inputs) } ?? []]
        }
        watch(AVAudioSession.interruptionNotification, "interruption") { note in
            let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let reason = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
            let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
            return ["type": type == AVAudioSession.InterruptionType.began.rawValue ? "began" : "ended",
                    "reason": reason.map { Int($0) } as Any? ?? NSNull(),
                    "shouldResume": options.map { $0 & AVAudioSession.InterruptionOptions.shouldResume.rawValue != 0 } as Any? ?? NSNull()]
        }
        watch(AVAudioSession.mediaServicesWereLostNotification, "media_services_lost") { _ in [:] }
        watch(AVAudioSession.mediaServicesWereResetNotification, "media_services_reset") { _ in [:] }
        watch(AVAudioSession.silenceSecondaryAudioHintNotification, "silence_secondary_audio_hint") { note in
            ["type": note.userInfo?[AVAudioSessionSilenceSecondaryAudioHintTypeKey] as? UInt as Any? ?? NSNull()]
        }
        watch(ProcessInfo.thermalStateDidChangeNotification, "thermal_state") { _ in [:] }
        watch(Notification.Name.NSProcessInfoPowerStateDidChange, "low_power_mode") { _ in [:] }
    }

    private func stopObserving() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
    }

    static func snapshot() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        return [
            "at": Int64(Date().timeIntervalSince1970 * 1000),
            "category": session.category.rawValue,
            "mode": session.mode.rawValue,
            "categoryOptions": Int(session.categoryOptions.rawValue),
            "outputs": ports(session.currentRoute.outputs),
            "inputs": ports(session.currentRoute.inputs),
            "sampleRate": session.sampleRate,
            "ioBufferDurationMs": session.ioBufferDuration * 1000,
            "outputLatencyMs": session.outputLatency * 1000,
            "otherAudioPlaying": session.isOtherAudioPlaying,
            "thermalState": thermalState(ProcessInfo.processInfo.thermalState),
            "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "appState": UIApplication.shared.applicationState == .active ? "active"
                : UIApplication.shared.applicationState == .background ? "background" : "inactive",
        ]
    }

    private static func ports(_ ports: [AVAudioSessionPortDescription]) -> [String] {
        ports.map { $0.portType.rawValue }
    }

    private static func thermalState(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    private static func routeChangeReason(_ raw: UInt) -> String {
        switch AVAudioSession.RouteChangeReason(rawValue: raw) {
        case .newDeviceAvailable: "new_device_available"
        case .oldDeviceUnavailable: "old_device_unavailable"
        case .categoryChange: "category_change"
        case .override: "override"
        case .wakeFromSleep: "wake_from_sleep"
        case .noSuitableRouteForCategory: "no_suitable_route_for_category"
        case .routeConfigurationChange: "route_configuration_change"
        default: "unknown(\(raw))"
        }
    }
}
