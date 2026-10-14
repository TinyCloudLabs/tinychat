import Capacitor
import ExoStt
import Foundation

@objc(OnDeviceSttPlugin)
public final class OnDeviceSttPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OnDeviceSttPlugin"
    public let jsName = "OnDeviceStt"
    public var pluginMethods: [CAPPluginMethod] {
        ["status", "installSpeechAssets", "enqueue", "enqueueAgain", "cancel"]
            .map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    }

    private let assets = AppleSpeechAssets.shared
    private let queue = TranscriptionQueue.shared

    override public func load() {
        queue.onQueueChanged = { [weak self] in self?.emitStatus() }
        assets.onChanged = { [weak self] in self?.emitStatus() }
        queue.onProgress = { [weak self] id, percent in
            DispatchQueue.main.async { self?.notifyListeners("progress", data: ["id": id, "percent": percent]) }
        }
        queue.onTranscribed = { [weak self] id, outcome in
            DispatchQueue.main.async { self?.notifyListeners("transcribed", data: ["id": id, "outcome": outcome], retainUntilConsumed: true) }
        }
        queue.onFailed = { [weak self] id, code, message in
            DispatchQueue.main.async { self?.notifyListeners("failed", data: ["id": id, "code": code, "message": message], retainUntilConsumed: true) }
        }
    }

    /// Never reports before the first asset check has finished, so the app never sees a made-up "unsupported".
    private func emitStatus() {
        assets.whenChecked { [weak self] in
            DispatchQueue.main.async { self?.notifyListeners("status", data: self?.statusDict() ?? [:], retainUntilConsumed: true) }
        }
    }

    /// The speech model belongs to the OS, so there are no models, packs or download policy of the app's own.
    private func statusDict() -> [String: Any] {
        let (state, install) = assets.current
        return [
            "models": [], "pack": "full", "autoDownload": false,
            "download": ["policy": "system", "state": install.rawValue],
            "engine": "apple-speech", "appleSpeech": state.rawValue,
            "queue": queue.queueSnapshot(),
        ]
    }

    @objc public func status(_ call: CAPPluginCall) {
        assets.whenChecked { [self] in call.resolve(statusDict()) }
    }

    @objc public func installSpeechAssets(_ call: CAPPluginCall) {
        Task {
            do {
                try await assets.installAssets()
                queue.reconcile()
                call.resolve()
            } catch {
                call.reject("Could not get speech from iOS", "asset_install_failed", error)
            }
        }
    }

    @objc public func enqueue(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required", "invalid_argument"); return }
        queue.enqueue(id: id, accepted: { accepted in
            if accepted { call.resolve() } else { call.reject("This note already has a transcript", "already_transcribed") }
        }, failed: { error in
            call.reject("Could not queue this note", "enqueue_failed", error)
        })
    }
    @objc public func enqueueAgain(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let rev = call.getInt("rev"), rev > 0 else {
            call.reject("id and positive rev are required", "invalid_argument")
            return
        }
        queue.enqueueAgain(id: id, rev: rev, accepted: { accepted in
            if accepted { call.resolve() } else { call.reject("Could not queue this note", "enqueue_failed") }
        }, failed: { error in
            call.reject("Could not queue this note", "enqueue_failed", error)
        })
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required", "invalid_argument"); return }
        queue.cancel(id: id)
        call.resolve()
    }
}
