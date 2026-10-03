import AVFoundation
import Capacitor
import Foundation

/// Native voice notes for iOS. Same JS contract as the Android plugin
/// (frontend/src/lib/voiceNotes/nativeVoiceNotes.ts):
///
///   start()             → { id, startedAt }
///   stop()              → { id, startedAt, durationMs, mimeType, sizeBytes,
///                           silencedMs, silencedEvents, noSignalMs }
///   status()            → { state, reason, id?, elapsedMs }
///   readAudio({ id })   → { id, mimeType, base64 }
///   deleteAudio({ id }) → {}
///   listPending()       → { recordings: [stop() result, ...] } still on the device
///   events: "micState" { state, reason, at }, "level" { level }
///
/// Mic state comes from the OS: an audio-session interruption (a call, Siri,
/// another app taking the mic) or the system input mute (iOS 17+) reads as
/// `silenced`. Recording continues in the background via the `audio`
/// background mode; iOS shows its own mic indicator the app cannot hide.
@objc(VoiceNotesPlugin)
public class VoiceNotesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceNotesPlugin"
    public let jsName = "VoiceNotes"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPending", returnType: CAPPluginReturnPromise)
    ]

    private static let mimeType = "audio/mp4"
    private static let levelInterval: TimeInterval = 0.2
    /// Silence at or below this level for `noSignalAfter` counts as no signal.
    private static let silenceFloorDb: Float = -120
    private static let noSignalAfter: TimeInterval = 2

    private var recorder: AVAudioRecorder?
    private var recordingId: String?
    private var startedAtMs: Int64 = 0
    private var startedUptime: TimeInterval = 0
    private var state = "idle"
    private var reason: String?

    private var silencedSince: TimeInterval?
    private var silencedTotal: TimeInterval = 0
    private var silencedEvents = 0
    private var zeroSince: TimeInterval?
    private var noSignalTotal: TimeInterval = 0
    private var noSignal = false
    private var levelTimer: Timer?

    override public func load() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(onInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        if #available(iOS 17.0, *) {
            center.addObserver(self, selector: #selector(onInputMuteChanged(_:)), name: AVAudioApplication.inputMuteStateChangeNotification, object: nil)
        }
    }

    // MARK: - Methods

    @objc func start(_ call: CAPPluginCall) {
        if recorder != nil {
            call.reject("A voice note is already recording", "already_recording")
            return
        }
        requestRecordPermission { granted in
            DispatchQueue.main.async {
                guard granted else {
                    call.reject("Microphone permission denied", "permission_denied")
                    return
                }
                self.startRecording(call)
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let recorder = self.recorder, let id = self.recordingId else {
                call.reject("No voice note is recording", "not_recording")
                return
            }
            let now = ProcessInfo.processInfo.systemUptime
            if let since = self.silencedSince { self.silencedTotal += now - since }
            if self.noSignal, let since = self.zeroSince { self.noSignalTotal += now - since }
            self.levelTimer?.invalidate()
            self.levelTimer = nil
            recorder.stop()
            self.recorder = nil
            self.recordingId = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            self.setState("idle", nil)

            let file = Self.fileURL(id)
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 0
            guard size > 0 else {
                try? FileManager.default.removeItem(at: file)
                call.reject("The recording captured no audio", "no_audio_captured")
                return
            }
            let result: [String: Any] = [
                "id": id,
                "startedAt": self.startedAtMs,
                "durationMs": Int64((now - self.startedUptime) * 1000),
                "mimeType": Self.mimeType,
                "sizeBytes": size,
                "silencedMs": Int64(self.silencedTotal * 1000),
                "silencedEvents": self.silencedEvents,
                "noSignalMs": Int64(self.noSignalTotal * 1000)
            ]
            // Until the web layer confirms the save (deleteAudio), the sidecar lets
            // listPending() hand the recording back after a failed upload or a relaunch.
            if let json = try? JSONSerialization.data(withJSONObject: result) {
                try? json.write(to: Self.sidecarURL(id))
            }
            call.resolve(result)
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let elapsed = self.recorder == nil ? 0 : ProcessInfo.processInfo.systemUptime - self.startedUptime
            call.resolve([
                "state": self.state,
                "reason": Self.jsonValue(self.reason),
                "id": Self.jsonValue(self.recordingId),
                "elapsedMs": Int64(elapsed * 1000)
            ])
        }
    }

    @objc func readAudio(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let data = try? Data(contentsOf: Self.fileURL(id)) else {
            call.reject("Voice note audio not found", "not_found")
            return
        }
        call.resolve(["id": id, "mimeType": Self.mimeType, "base64": data.base64EncodedString()])
    }

    @objc func deleteAudio(_ call: CAPPluginCall) {
        if let id = call.getString("id") {
            try? FileManager.default.removeItem(at: Self.fileURL(id))
            try? FileManager.default.removeItem(at: Self.sidecarURL(id))
        }
        call.resolve()
    }

    @objc func listPending(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let dir = Self.fileURL("probe").deletingLastPathComponent()
            let sidecars = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            var recordings: [Any] = []
            for sidecar in sidecars where sidecar.pathExtension == "json" {
                let id = sidecar.deletingPathExtension().lastPathComponent
                if id == self.recordingId { continue }
                guard FileManager.default.fileExists(atPath: Self.fileURL(id).path) else {
                    try? FileManager.default.removeItem(at: sidecar)
                    continue
                }
                if let data = try? Data(contentsOf: sidecar),
                   let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    recordings.append(object)
                }
            }
            call.resolve(["recordings": recordings])
        }
    }

    // MARK: - Recording

    private func startRecording(_ call: CAPPluginCall) {
        let id = UUID().uuidString.lowercased()
        let file = Self.fileURL(id)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let recorder = try AVAudioRecorder(url: file, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.record() else {
                call.reject("Could not start the microphone", "start_failed")
                return
            }
            self.recorder = recorder
        } catch {
            call.reject("Could not start the microphone: \(error.localizedDescription)", "start_failed", error)
            return
        }

        recordingId = id
        startedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        startedUptime = ProcessInfo.processInfo.systemUptime
        silencedSince = nil
        silencedTotal = 0
        silencedEvents = 0
        zeroSince = nil
        noSignalTotal = 0
        noSignal = false
        setState("recording", nil)
        if #available(iOS 17.0, *), AVAudioApplication.shared.isInputMuted {
            markSilenced()
        }

        let timer = Timer(timeInterval: Self.levelInterval, repeats: true) { [weak self] _ in self?.levelTick() }
        RunLoop.main.add(timer, forMode: .common)
        levelTimer = timer
        call.resolve(["id": id, "startedAt": startedAtMs])
    }

    private func levelTick() {
        guard let recorder = recorder else { return }
        recorder.updateMeters()
        let peakDb = recorder.peakPower(forChannel: 0)
        let now = ProcessInfo.processInfo.systemUptime
        if peakDb <= Self.silenceFloorDb {
            if zeroSince == nil { zeroSince = now }
            if !noSignal, let since = zeroSince, now - since >= Self.noSignalAfter, state == "recording" {
                noSignal = true
                setState("recording", "no_signal")
            }
        } else {
            if noSignal, let since = zeroSince {
                noSignalTotal += now - since
                noSignal = false
                if state == "recording" { setState("recording", nil) }
            }
            zeroSince = nil
        }
        let level = min(1, max(0, pow(10, recorder.averagePower(forChannel: 0) / 20)))
        notifyListeners("level", data: ["level": level])
    }

    // MARK: - OS mic state

    @objc private func onInterruption(_ notification: Notification) {
        guard recorder != nil,
              let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        DispatchQueue.main.async {
            switch type {
            case .began:
                self.markSilenced()
            case .ended:
                // AVAudioRecorder pauses on interruption; resume into the same file.
                try? AVAudioSession.sharedInstance().setActive(true)
                self.recorder?.record()
                self.markUnsilenced()
            @unknown default:
                break
            }
        }
    }

    @objc private func onInputMuteChanged(_ notification: Notification) {
        guard #available(iOS 17.0, *), recorder != nil else { return }
        let muted = (notification.userInfo?[AVAudioApplication.muteStateKey] as? NSNumber)?.boolValue ?? AVAudioApplication.shared.isInputMuted
        DispatchQueue.main.async {
            muted ? self.markSilenced() : self.markUnsilenced()
        }
    }

    private func markSilenced() {
        if silencedSince == nil {
            silencedSince = ProcessInfo.processInfo.systemUptime
            silencedEvents += 1
        }
        setState("silenced", "os_silenced")
    }

    private func markUnsilenced() {
        if let since = silencedSince {
            silencedTotal += ProcessInfo.processInfo.systemUptime - since
            silencedSince = nil
        }
        setState("recording", noSignal ? "no_signal" : nil)
    }

    private func setState(_ next: String, _ why: String?) {
        guard next != state || why != reason else { return }
        state = next
        reason = why
        notifyListeners("micState", data: [
            "state": next,
            "reason": Self.jsonValue(why),
            "at": Int64(Date().timeIntervalSince1970 * 1000)
        ], retainUntilConsumed: true)
    }

    // MARK: - Helpers

    private func requestRecordPermission(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: done)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(done)
        }
    }

    /// Bridge-safe optional: JSON null instead of a boxed Swift Optional.
    private static func jsonValue(_ value: String?) -> Any {
        value.map { $0 as Any } ?? NSNull()
    }

    private static func sidecarURL(_ id: String) -> URL {
        fileURL(id).deletingPathExtension().appendingPathExtension("json")
    }

    private static func fileURL(_ id: String) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("voice-notes", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("\(id).m4a")
    }
}
