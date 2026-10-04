import AVFoundation
import Capacitor
import Foundation

/// Native voice notes for iOS. Same JS contract as the Android plugin
/// (frontend/src/lib/voiceNotes/nativeVoiceNotes.ts):
///
///   start({ maxDurationMs? })  → { id, startedAt, maxDurationMs }
///   stop()                     → { id, startedAt, durationMs, mimeType, sizeBytes,
///                                  silencedMs, silencedEvents, noSignalMs }
///   status()                   → { state, reason, id?, elapsedMs, maxDurationMs }
///   readAudioChunk({ id, offset, length })
///                              → { id, offset, base64, bytesRead, size, eof }
///   deleteAudio({ id })        → {}
///   listPending()              → { recordings: [stop() result, ...] } still on the device
///   events: "micState" { state, reason, at }, "level" { level },
///           "autoStopped" { reason: "max_duration", maxDurationMs, at, recording: stop() result | null }
///
/// A recording stops itself at maxDurationMs (`maxDuration`, or less when start
/// asks for less) through the same path as stop(): micState goes idle with reason
/// "max_duration", and "autoStopped" carries the result, which stays pending
/// (listPending) until the web layer saves it. Audio crosses the bridge one chunk
/// at a time, never the whole file.
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
        CAPPluginMethod(name: "readAudioChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPending", returnType: CAPPluginReturnPromise)
    ]

    private static let mimeType = "audio/mp4"
    private static let levelInterval: TimeInterval = 0.2
    /// Silence at or below this level for `noSignalAfter` counts as no signal.
    private static let silenceFloorDb: Float = -120
    private static let noSignalAfter: TimeInterval = 2
    /// The longest voice note (60 min): about 29 MB of 64 kbps AAC, 29 one-MiB parts in the
    /// user's space. Matches VoiceRecorder.MAX_DURATION_MS on Android.
    static let maxDuration: TimeInterval = 60 * 60
    /// The shortest limit start() accepts (tests ask for seconds).
    private static let minDurationLimit: TimeInterval = 1
    /// The most one readAudioChunk call returns (it crosses the bridge as base64).
    private static let maxChunkBytes = 4 * 1024 * 1024

    private var recorder: AVAudioRecorder?
    private var recordingId: String?
    private var startedAtMs: Int64 = 0
    private var startedUptime: TimeInterval = 0
    private var limit: TimeInterval = VoiceNotesPlugin.maxDuration
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
                self.startRecording(call, limit: Self.clampLimit(call.getDouble("maxDurationMs")))
            }
        }
    }

    /// A requested limit (ms) clamped to [minDurationLimit, maxDuration]; absent or <= 0 means the default.
    private static func clampLimit(_ requestedMs: Double?) -> TimeInterval {
        guard let ms = requestedMs, ms.isFinite, ms > 0 else { return maxDuration }
        return min(maxDuration, max(minDurationLimit, ms / 1000))
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.recorder != nil else {
                // Also when the limit stopped it first: "autoStopped" carries that recording.
                call.reject("No voice note is recording", "not_recording")
                return
            }
            guard let result = self.finishRecording(reason: nil) else {
                call.reject("The recording captured no audio", "no_audio_captured")
                return
            }
            call.resolve(result)
        }
    }

    /// Stops and finalizes the file (manual stop and the limit alike), writes the sidecar,
    /// and returns stop()'s result; nil when no audio was captured. Main thread only.
    private func finishRecording(reason: String?) -> [String: Any]? {
        guard let recorder = recorder, let id = recordingId else { return nil }
        let now = ProcessInfo.processInfo.systemUptime
        if let since = silencedSince { silencedTotal += now - since }
        if noSignal, let since = zeroSince { noSignalTotal += now - since }
        levelTimer?.invalidate()
        levelTimer = nil
        recorder.stop()
        self.recorder = nil
        recordingId = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        setState("idle", reason)

        let file = Self.fileURL(id)
        // URLResourceValues.fileSize, not FileManager.attributesOfItem: the latter is a file-timestamp
        // "required reason" API that PrivacyInfo.xcprivacy would have to declare.
        let size = Int64((try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        guard size > 0 else {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        let result: [String: Any] = [
            "id": id,
            "startedAt": startedAtMs,
            "durationMs": Int64((now - startedUptime) * 1000),
            "mimeType": Self.mimeType,
            "sizeBytes": size,
            "silencedMs": Int64(silencedTotal * 1000),
            "silencedEvents": silencedEvents,
            "noSignalMs": Int64(noSignalTotal * 1000)
        ]
        // Until the web layer confirms the save (deleteAudio), the sidecar lets listPending()
        // hand the recording back after a failed upload, a relaunch, or an unheard auto-stop.
        if let json = try? JSONSerialization.data(withJSONObject: result) {
            try? json.write(to: Self.sidecarURL(id))
        }
        return result
    }

    /// The limit was reached: the same stop as the user's, then "autoStopped" (retained until
    /// the webview listens; listPending() has the recording regardless).
    private func autoStop() {
        guard recorder != nil else { return }
        let limitMs = Int64(limit * 1000)
        var recording: Any = NSNull()
        if let result = finishRecording(reason: "max_duration") { recording = result }
        notifyListeners("autoStopped", data: [
            "reason": "max_duration",
            "maxDurationMs": limitMs,
            "at": Int64(Date().timeIntervalSince1970 * 1000),
            "recording": recording
        ], retainUntilConsumed: true)
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let elapsed = self.recorder == nil ? 0 : ProcessInfo.processInfo.systemUptime - self.startedUptime
            call.resolve([
                "state": self.state,
                "reason": Self.jsonValue(self.reason),
                "id": Self.jsonValue(self.recordingId),
                "elapsedMs": Int64(elapsed * 1000),
                "maxDurationMs": Int64((self.recorder == nil ? Self.maxDuration : self.limit) * 1000)
            ])
        }
    }

    /// Up to `length` bytes of a recording from `offset`, as base64. The web layer reads a note
    /// part by part (1 MiB, one stored part) so neither side holds the whole file as one string.
    @objc func readAudioChunk(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.contains("/"),
              let offset = call.getDouble("offset"), offset.isFinite, offset >= 0,
              let length = call.getDouble("length"), length.isFinite, length > 0 else {
            call.reject("readAudioChunk needs an id, an offset >= 0 and a length > 0", "invalid_argument")
            return
        }
        let file = Self.fileURL(id)
        guard let handle = try? FileHandle(forReadingFrom: file) else {
            call.reject("Voice note audio not found", "not_found")
            return
        }
        defer { try? handle.close() }
        do {
            let size = try handle.seekToEnd()
            let start = offset >= Double(size) ? size : UInt64(offset)
            try handle.seek(toOffset: start)
            let want = Int(min(UInt64(min(length, Double(Self.maxChunkBytes))), size - start))
            var data = Data()
            if want > 0 { data = try handle.read(upToCount: want) ?? Data() }
            call.resolve([
                "id": id,
                "offset": Int64(start),
                "base64": data.base64EncodedString(),
                "bytesRead": data.count,
                "size": Int64(size),
                "eof": start + UInt64(data.count) >= size
            ])
        } catch {
            call.reject("Could not read voice note audio", "read_failed", error)
        }
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

    private func startRecording(_ call: CAPPluginCall, limit: TimeInterval) {
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
        self.limit = limit
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
        call.resolve(["id": id, "startedAt": startedAtMs, "maxDurationMs": Int64(limit * 1000)])
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
        // Wall time, like durationMs: an interruption pauses the file but not the limit.
        if now - startedUptime >= limit {
            autoStop()
        }
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
