#if DEBUG
// TC-524 location spike: Debug builds only (see LocationRecorder.swift).
import Capacitor
import Foundation
import UIKit

/// JS bridge for the location spike. Same contract as the Android plugin
/// (frontend/src/lib/location/nativeLocation.ts):
///
///   status()                                → LocationStatus
///   requestPermission({ level })            → LocationStatus once the prompt is answered (or none was shown)
///   openSettings()                          → {} (the app's page in Settings)
///   start({ mode, background, distanceM? }) → LocationStatus   (intervalMs and provider are Android-only)
///   stop()                                  → LocationStatus
///   pending({ limit? })                     → { entries: [sample | state event], pending }
///   ack({ throughSeq })                     → { pending }
///   events: "sample", "state"
@objc(LocationPlugin)
public class LocationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocationPlugin"
    public let jsName = "Location"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        DispatchQueue.main.async {
            let recorder = LocationRecorder.shared
            recorder.onSample = { [weak self] sample in self?.notifyListeners("sample", data: sample) }
            recorder.onState = { [weak self] event in self?.notifyListeners("state", data: event, retainUntilConsumed: true) }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(LocationRecorder.shared.snapshot())
        }
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        let background = call.getString("level") == "background"
        DispatchQueue.main.async {
            let recorder = LocationRecorder.shared
            let declared = recorder.snapshot()["declared"] as? [String: Bool] ?? [:]
            guard declared[background ? "background" : "foreground"] == true else {
                call.reject("This build has no location usage description (the spike is Debug-only)", "not_declared")
                return
            }
            if background, !recorder.hasForegroundPermission {
                call.reject("Grant location while using the app first", "foreground_first")
                return
            }
            recorder.requestPermission(background: background) { status in call.resolve(status) }
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("No settings URL", "unavailable")
                return
            }
            UIApplication.shared.open(url)
            call.resolve()
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let mode = call.getString("mode") ?? LocationRecorder.modeContinuous
        let background = call.getBool("background") ?? true
        let lowPower = mode == LocationRecorder.modeLowPower
        let distanceM = call.getDouble("distanceM") ?? (lowPower ? 100 : 0)
        guard mode == LocationRecorder.modeContinuous || lowPower else {
            call.reject("Unknown mode \(mode)", "bad_request")
            return
        }
        DispatchQueue.main.async {
            let recorder = LocationRecorder.shared
            guard recorder.hasForegroundPermission else {
                call.reject("Location permission is not granted", "permission_required")
                return
            }
            recorder.start(mode: mode, background: background, distanceM: max(0, distanceM))
            call.resolve(recorder.snapshot())
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            LocationRecorder.shared.stop(reason: "stopped")
            call.resolve(LocationRecorder.shared.snapshot())
        }
    }

    @objc func pending(_ call: CAPPluginCall) {
        let limit = max(1, min(1_000, call.getInt("limit") ?? 200))
        DispatchQueue.main.async {
            let recorder = LocationRecorder.shared
            let entries = recorder.pending(limit: limit)
            let left = (recorder.snapshot()["queue"] as? [String: Any])?["pending"] ?? 0
            call.resolve(["entries": entries, "pending": left])
        }
    }

    @objc func ack(_ call: CAPPluginCall) {
        guard let throughSeq = call.getDouble("throughSeq"), throughSeq >= 0 else {
            call.reject("throughSeq is required", "bad_request")
            return
        }
        DispatchQueue.main.async {
            call.resolve(["pending": LocationRecorder.shared.ack(throughSeq: Int64(throughSeq))])
        }
    }
}
#endif
