import AVFoundation
import CaptureCore
import Foundation
import OSLog
import UIKit

public final class CaptureEngine {
    public static let shared = CaptureEngine()
    public let library: RecordingLibrary
    private let log = Logger(subsystem: "xyz.tinycloud.exo", category: "capture")
    private let defaultsKey = "exo.capture.defaults.v2"
    private let recovery = DispatchGroup()
    private var startedRecovery = false
    private var audioEngine: AVAudioEngine?
    private let tapCallbacks = DispatchGroup()
    private let tapTimeLock = NSLock()
    private var lastTapEndSample: AVAudioFramePosition?
    private var writer: AacAdtsWriter?
    private var info: SessionInfo?
    private var intent = "stopped"
    private var availability = "available"
    private var reason: String?
    private var generation = 0
    private var pausedSince: Int64?
    private var pausedMs: Int64 = 0
    private var audioMs: Int64 = 0
    private var spans: [MissingAudioSpan] = []
    private var openSpan: MissingAudioSpan?
    private var lastLevel = Date.distantPast
    private var appActive = false
    private var zeroSince: Date?
    private var noSignalMs: Int64 = 0
    private var options = CaptureOptions()
    private var currentInput: [String: Any]?
    private var transitions: CaptureTransitionMachine?
    private var limitTimer: Timer?
    private var lastDiskCheck = Date.distantPast
    private var observers: [UUID: (String, [String: Any], Bool) -> Void] = [:]
    private var retainedEvents: [(String, [String: Any])] = []

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("voice-notes", isDirectory: true)
        // This directory is required before a plugin or a scene exists. Initialization failure
        // terminates launch because no capture or library operation can be made durable.
        do { library = try RecordingLibrary(root: base) }
        catch { fatalError("Voice-note library unavailable: \(error)") }
    }

    public func observe(_ body: @escaping (String, [String: Any], Bool) -> Void) -> UUID {
        let token = UUID(); observers[token] = body
        for (name, data) in retainedEvents { body(name, data, true) }
        retainedEvents.removeAll()
        return token
    }
    public func removeObserver(_ token: UUID) { observers.removeValue(forKey: token) }
    public func setAppActive(_ active: Bool) { appActive = active }
    public func presentRecorder() {
        if let id = info?.id {
            log.notice("presentRecorder id=\(id, privacy: .public)")
            emit("presentRecorder", ["id": id], retained: true)
        }
    }
    private func emit(_ name: String, _ data: [String: Any], retained: Bool = false) {
        if retained && observers.isEmpty { retainedEvents.append((name, data)) }
        for listener in observers.values { listener(name, data, retained) }
    }

    public func recoverOnce() {
        guard !startedRecovery else { return }
        startedRecovery = true
        recovery.enter()
        DispatchQueue.global(qos: .utility).async { [self] in
            defer { recovery.leave() }
            do {
                CaptureRecoverySweep.run(ids: try library.recoverableSessions(), recover: { id in
                    try recoverSession(id)
                }, failed: { id, error in
                        log.error("Recovery failed for \(id, privacy: .public): \(String(describing: error), privacy: .public)")
                        DispatchQueue.main.async { self.emit("recoveryFailed", ["id": id, "reason": String(describing: error)], retained: true) }
                })
                try importLegacyOrphans()
            } catch {
                log.error("Recovery scan failed: \(String(describing: error), privacy: .public)")
                DispatchQueue.main.async { self.emit("recoveryFailed", ["reason": String(describing: error)], retained: true) }
            }
        }
    }

    public func awaitRecovery() throws {
        recovery.wait()
    }

    public func defaults() -> CaptureDefaults {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let value = try? JSONDecoder().decode(CaptureDefaults.self, from: data) else {
            return CaptureDefaults()
        }
        return value
    }

    @discardableResult public func setDefaults(_ value: CaptureDefaults) throws -> [String] {
        let old = defaults()
        try value.validateTransition(from: old)
        let encoded = try JSONEncoder().encode(value)
        UserDefaults.standard.set(encoded, forKey: defaultsKey)
        guard UserDefaults.standard.data(forKey: defaultsKey) == encoded else {
            throw CaptureError.io("Capture defaults were not persisted")
        }
        var claimed: [String] = []
        if let did = value.accountDid {
            if var live = info, live.owner == nil {
                try library.appendJournal(live.id, ["e": "owner", "t": wallMilliseconds(),
                                                    "a": audioMs, "did": did])
                live.owner = did; info = live
                claimed.append(live.id)
            }
            for item in try library.listCommitted() {
                guard item["version"] as? Int == 2,
                      item["ownerUnknown"] as? Bool != true,
                      item["owner"] == nil || item["owner"] is NSNull,
                      let id = item["id"] as? String else { continue }
                _ = try library.claim(id, did: did, evidence: "signed_out_v2")
                claimed.append(id)
            }
        }
        return claimed
    }

    public func start(source: String = "in_app", requestedLimitMs: Int64? = nil,
                      override: CaptureOptions? = nil) throws -> [String: Any] {
        recoverOnce()
        guard info == nil else { throw CaptureError.alreadyRecording }
        guard let free = try library.root.resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity else {
            throw CaptureError.io("read available storage")
        }
        guard free >= 300 * 1024 * 1024 else { throw CaptureError.insufficientStorage }
        let settings = defaults()
        let testLimit = UserDefaults.standard.object(forKey: "exo.voiceNotes.maxDurationMs") as? Int64
        let limit = min(10_800_000, max(1_000, min(requestedLimitMs ?? 10_800_000,
                                                   testLimit.flatMap { $0 > 0 ? $0 : nil } ?? 10_800_000)))
        var selected = override ?? settings.options
        if settings.accountDid == nil { selected.transcriber = "on-device" }
        let now = wallMilliseconds()
        let session = SessionInfo(id: UUID().uuidString.lowercased(), maxDurationMs: limit,
                                  source: source, owner: settings.accountDid,
                                  transitionGen: settings.transitionGen, options: selected,
                                  startedAt: now)
        try library.startSession(session)
        info = session; options = selected; intent = "recording"; availability = "available"
        transitions = CaptureTransitionMachine()
        reason = nil; spans = []; openSpan = nil; audioMs = 0; pausedMs = 0; pausedSince = nil
        noSignalMs = 0; zeroSince = nil
        lastDiskCheck = Date()
        generation += 1
        do { try activateGraph() }
        catch {
            try? library.delete(session.id)
            info = nil; intent = "stopped"
            throw error
        }
        emitState()
        limitTimer?.invalidate()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkDurationLimit() }
        RunLoop.main.add(timer, forMode: .common)
        limitTimer = timer
        if source != "in_app" { presentRecorder() }
        return ["id": session.id, "startedAt": now, "maxDurationMs": limit]
    }

    private func activateGraph() throws {
        guard let session = info else { throw CaptureError.notRecording }
        let audioSession = AVAudioSession.sharedInstance()
        var acquired = false
        var pendingEngine: AVAudioEngine?
        defer {
            if !acquired {
                pendingEngine?.stop()
                do { try audioSession.setActive(false, options: .notifyOthersOnDeactivation) }
                catch { log.error("Audio session cleanup failed: \(String(describing: error), privacy: .public)") }
            }
        }
        var category: AVAudioSession.CategoryOptions = [.mixWithOthers, .allowBluetoothHFP, .defaultToSpeaker]
        if #available(iOS 26.0, *) { category.insert(.bluetoothHighQualityRecording) }
        try audioSession.setCategory(.playAndRecord, mode: .default, options: category)
        try audioSession.setPrefersNoInterruptionsFromSystemAlerts(true)
        try audioSession.setPrefersInterruptionOnRouteDisconnect(false)
        try audioSession.setActive(true)
        let engine = AVAudioEngine()
        pendingEngine = engine
        let node = engine.inputNode
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw CaptureError.io("microphone input has no format") }
        // Verify the input can actually start before recording a successful acquisition.
        engine.prepare()
        try engine.start()
        let acquiredAt = wallMilliseconds()
        // The transition machine emits span_close, availability, and only a changed input.
        var input: (id: String, name: String, kind: String)?
        if let port = audioSession.currentRoute.inputs.first {
            let kind: String
            switch port.portType {
            case .builtInMic: kind = "built_in"
            case .headsetMic: kind = "wired"
            case .bluetoothHFP: kind = "bluetooth"
            case .usbAudio: kind = "usb"
            case .carAudio: kind = "car"
            default: kind = "other"
            }
            input = (port.uid, port.portName, kind)
            currentInput = ["id": port.uid, "name": port.portName, "kind": kind]
        }
        var next = transitions ?? CaptureTransitionMachine()
        for event in next.acquired(at: acquiredAt, audioMs: audioMs, generation: generation, input: input) {
            try library.appendJournal(session.id, event)
        }
        if openSpan != nil { closeSpan(at: acquiredAt, journal: false) }
        transitions = next
        let writer: AacAdtsWriter
        if let existing = self.writer { try existing.reopen(); writer = existing }
        else {
            let openedAt = wallMilliseconds()
            try library.openFirstSegment(session.id, at: openedAt)
            writer = try AacAdtsWriter(library: library, id: session.id, segmentOpenedAt: openedAt)
            self.writer = writer
        }
        writer.onLevel = { [weak self] level, peak in
            DispatchQueue.main.async { self?.receiveLevel(level, peak: peak) }
        }
        writer.onFrames = { [weak self] audioMs in
            DispatchQueue.main.async { self?.receiveFrames(audioMs) }
        }
        writer.onFailure = { [weak self] error in
            DispatchQueue.main.async { self?.writerFailed(error) }
        }
        writer.onStall = { [weak self] active, dropped in
            DispatchQueue.main.async { self?.writerStallChanged(active, droppedFrames: dropped) }
        }
        writer.onStale = { [weak self] frames in
            DispatchQueue.main.async { self?.log.error("Stale tap frames rejected: \(frames)") }
        }
        writer.setGeneration(generation)
        tapTimeLock.lock(); lastTapEndSample = nil; tapTimeLock.unlock()
        let attemptGeneration = generation
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, writer] buffer, when in
            self?.tapCallbacks.enter()
            defer { self?.tapCallbacks.leave() }
            if when.isSampleTimeValid {
                self?.tapTimeLock.lock()
                self?.lastTapEndSample = when.sampleTime + AVAudioFramePosition(buffer.frameLength)
                self?.tapTimeLock.unlock()
            }
            writer.enqueue(buffer, generation: attemptGeneration)
        }
        audioEngine = engine
        acquired = true
    }

    private func deactivateGraph(tapRemoved: Bool = false) {
        if let engine = audioEngine {
            if !tapRemoved { engine.inputNode.removeTap(onBus: 0) }
            engine.stop()
        }
        audioEngine = nil
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { log.error("Audio session deactivation failed: \(String(describing: error), privacy: .public)") }
    }

    @discardableResult private func stopInput() -> Bool {
        guard let engine = audioEngine else { return true }
        let renderTime = engine.inputNode.lastRenderTime
        let renderEnd = renderTime?.isSampleTimeValid == true ? renderTime?.sampleTime : nil
        engine.stop()
        guard !engine.isRunning else { return false }
        engine.inputNode.removeTap(onBus: 0)
        tapCallbacks.wait()
        tapTimeLock.lock()
        let deliveredEnd = lastTapEndSample
        tapTimeLock.unlock()
        if let renderEnd, let deliveredEnd {
            log.notice("Pause/stop tap tail estimate samples=\(max(0, renderEnd - deliveredEnd)); bufferSize=1024")
        }
        audioEngine = nil
        return true
    }

    private func receiveLevel(_ level: Double, peak: Double) {
        guard intent == "recording", availability == "available" else { return }
        let now = Date()
        if peak == 0 {
            if zeroSince == nil { zeroSince = now }
            if now.timeIntervalSince(zeroSince!) > 2 && reason != "no_signal" {
                reason = "no_signal"; emitState()
            }
        } else {
            closeNoSignal(at: now)
            if reason == "no_signal" { reason = nil; emitState() }
        }
        if appActive && now.timeIntervalSince(lastLevel) >= 0.05 {
            emit("level", ["level": level, "peak": peak]); lastLevel = now
        }
    }

    private func closeNoSignal(at now: Date = Date()) {
        if let since = zeroSince, now.timeIntervalSince(since) > 2 {
            noSignalMs += Int64(now.timeIntervalSince(since) * 1000)
        }
        zeroSince = nil
    }

    private func receiveFrames(_ value: Int64) {
        audioMs = value
    }

    private func checkDurationLimit() {
        if let session = info, intent != "stopped",
           (status()["elapsedMs"] as? Int64 ?? 0) >= session.maxDurationMs {
            stop(reason: "max_duration") { [weak self] result in
                let recording: Any = (try? result.get()) ?? NSNull()
                self?.emit("autoStopped", ["reason": "max_duration", "maxDurationMs": session.maxDurationMs,
                                            "at": wallMilliseconds(), "recording": recording], retained: true)
            }
            return
        }
        if info != nil, Date().timeIntervalSince(lastDiskCheck) >= 5 {
            lastDiskCheck = Date()
            do {
                guard let free = try library.root.resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity else {
                    throw CaptureError.io("read available storage")
                }
                if free < 100 * 1024 * 1024 {
                    stop(reason: "disk_full") { [weak self] result in
                        self?.emit("autoStopped", ["reason": "disk_full", "at": wallMilliseconds(),
                                                    "recording": (try? result.get()) ?? NSNull()], retained: true)
                    }
                }
            } catch { log.error("Disk capacity check failed: \(String(describing: error), privacy: .public)") }
        }
    }

    private func writerFailed(_ error: Error) {
        guard info != nil, intent == "recording" else { return }
        log.error("Writer failed: \(String(describing: error), privacy: .public)")
        stop(reason: "write_failed") { [weak self] result in
            let recording: Any = (try? result.get()) ?? NSNull()
            self?.emit("autoStopped", ["reason": "write_failed", "at": wallMilliseconds(),
                                        "recording": recording], retained: true)
        }
    }

    private func writerStallChanged(_ active: Bool, droppedFrames: Int) {
        guard info != nil, intent == "recording" else { return }
        log.error("Writer stall \(active ? "opened" : "closed", privacy: .public); dropped PCM frames=\(droppedFrames)")
        if active { openOmittedSpan("writer_stalled") }
        else if openSpan?.reason == "writer_stalled" { closeSpan() }
    }

    public func pause() throws {
        guard let session = info else { throw CaptureError.notRecording }
        if intent == "paused" { return }
        guard intent == "recording" else { throw CaptureError.notRecording }
        generation += 1
        var next = transitions ?? CaptureTransitionMachine()
        let input = ClosureInputControl(stop: { [self] in stopInput() }, release: {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        })
        let frames = ClosureFrameSink(close: { [self] in try writer?.closeForPause() })
        let journal = ClosureJournalSink(write: { [self] event, fullSync in
            try library.appendJournal(session.id, event, fullSync: fullSync)
        })
        let paused: (audioMs: Int64, at: Int64)
        do {
            paused = try next.pause(input: input, frames: frames, journal: journal,
                                    clock: SystemCaptureClock(), currentAudioMs: audioMs) { [self] error in
                log.error("Audio session remained active after Pause: \(String(describing: error), privacy: .public)")
            }
        } catch CaptureError.pauseFailed {
            throw CaptureError.pauseFailed
        } catch {
            writerFailed(error)
            throw CaptureError.pauseFailed
        }
        audioMs = paused.audioMs
        closeNoSignal()
        if openSpan != nil { closeSpan(at: paused.at, journal: false) }
        transitions = next
        intent = "paused"; reason = "user"; pausedSince = paused.at
        emitState()
    }

    public func resume() throws {
        guard let session = info else { throw CaptureError.notRecording }
        guard intent == "paused" || availability != "available" else { return }
        let wasPaused = intent == "paused"
        generation += 1
        if wasPaused {
            let now = wallMilliseconds()
            var next = transitions ?? CaptureTransitionMachine()
            for event in next.resumed(at: now, audioMs: audioMs) { try library.appendJournal(session.id, event) }
            if let since = pausedSince { pausedMs += max(0, now - since) }
            pausedSince = nil
            intent = "recording"
            transitions = next
        }
        do {
            try activateGraph()
            availability = "available"; reason = nil
        } catch {
            availability = "blocked"; reason = "resume_blocked"
            var next = transitions ?? CaptureTransitionMachine()
            for event in next.blocked(at: wallMilliseconds(), audioMs: audioMs, generation: generation) {
                try library.appendJournal(session.id, event, fullSync: true)
            }
            transitions = next
            emitState(); throw CaptureError.resumeFailed
        }
        emitState()
    }

    public func interruptionBegan() {
        guard let session = info, intent != "stopped" else { return }
        generation += 1
        guard stopInput() else {
            log.error("Could not stop capture input during interruption")
            return
        }
        do { audioMs = try writer?.closeForPause().audioMs ?? audioMs }
        catch { writerFailed(error); return }
        closeNoSignal()
        deactivateGraph(tapRemoved: true)
        let interruptedAt = wallMilliseconds()
        var next = transitions ?? CaptureTransitionMachine()
        let events = next.interrupted(at: interruptedAt, audioMs: audioMs,
                                      generation: generation, reason: "interruption")
        if events.first?["e"] as? String == "span_open" {
            openSpan = MissingAudioSpan(kind: "omitted", reason: "interruption",
                                        startedAt: interruptedAt, atAudioMs: audioMs)
        }
        availability = "interrupted"; reason = "interruption"
        do {
            for event in events { try library.appendJournal(session.id, event) }
            transitions = next
        }
        catch { log.error("Journal interruption failed: \(String(describing: error), privacy: .public)") }
        emitState()
    }

    public func interruptionEnded() {
        guard info != nil, intent == "recording", availability == "interrupted" else { return }
        do { try resume() }
        catch { log.error("Interruption restart failed: \(String(describing: error), privacy: .public)") }
    }

    private func openOmittedSpan(_ why: String) {
        guard openSpan == nil, let session = info else { return }
        let at = wallMilliseconds()
        openSpan = MissingAudioSpan(kind: "omitted", reason: why, startedAt: at, atAudioMs: audioMs)
        var next = transitions ?? CaptureTransitionMachine()
        do {
            for event in next.openedSpan(at: at, audioMs: audioMs, kind: "omitted", reason: why) {
                try library.appendJournal(session.id, event)
            }
            transitions = next
        }
        catch { log.error("Journal span open failed: \(String(describing: error), privacy: .public)") }
    }

    private func closeSpan(at timestamp: Int64? = nil, journal: Bool = true) {
        guard var span = openSpan else { return }
        span.endedAt = timestamp ?? wallMilliseconds()
        if span.kind == "silenced" { span.audioMs = max(0, audioMs - span.atAudioMs) }
        spans.append(span); openSpan = nil
        if journal, let session = info {
            var next = transitions ?? CaptureTransitionMachine()
            do {
                for event in next.closedSpan(at: span.endedAt!, audioMs: audioMs) {
                    try library.appendJournal(session.id, event)
                }
                transitions = next
            }
            catch { log.error("Journal span close failed: \(String(describing: error), privacy: .public)") }
        }
    }

    public func inputMuteChanged(_ muted: Bool) {
        guard let session = info, intent == "recording" else { return }
        if muted {
            guard openSpan == nil else { return }
            let at = wallMilliseconds()
            openSpan = MissingAudioSpan(kind: "silenced", reason: "input_muted",
                                        startedAt: at, atAudioMs: audioMs)
            reason = "input_muted"
            var next = transitions ?? CaptureTransitionMachine()
            do {
                for event in next.openedSpan(at: at, audioMs: audioMs, kind: "silenced", reason: "input_muted") {
                    try library.appendJournal(session.id, event)
                }
                transitions = next
            }
            catch { log.error("Journal mute failed: \(String(describing: error), privacy: .public)") }
        } else { closeSpan(); reason = nil }
        emitState()
    }

    public func stop(reason stopReason: String = "user",
                     completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let session = info else { completion(.failure(CaptureError.notRecording)); return }
        generation += 1
        guard stopInput() else {
            completion(.failure(CaptureError.io("stop capture input")))
            return
        }
        closeNoSignal()
        let stoppedAt = wallMilliseconds()
        let final: (audioMs: Int64, heartbeatAt: Int64?)
        do { final = try writer?.finish(at: stoppedAt) ?? (audioMs: 0, heartbeatAt: nil) }
        catch {
            library.endLiveCapture(session.id)
            deactivateGraph(tapRemoved: true)
            limitTimer?.invalidate(); limitTimer = nil
            writer = nil; info = nil; intent = "stopped"; availability = "available"; reason = "write_failed"
            emitState()
            DispatchQueue.global(qos: .utility).async { [self] in
                do { try recoverSession(session.id) }
                catch { log.error("Write-failure recovery failed: \(String(describing: error), privacy: .public)") }
            }
            completion(.failure(error))
            return
        }
        deactivateGraph(tapRemoved: true)
        library.endLiveCapture(session.id)
        if openSpan != nil { closeSpan(at: stoppedAt, journal: false) }
        var next = transitions ?? CaptureTransitionMachine()
        let stopEvents = next.stopped(at: stoppedAt, audioMs: final.audioMs, reason: stopReason)
        transitions = next
        if let since = pausedSince { pausedMs += max(0, stoppedAt - since) }
        let paused = pausedMs
        let spans = self.spans
        let input = currentInput
        let noSignal = noSignalMs
        limitTimer?.invalidate(); limitTimer = nil
        writer = nil; info = nil; intent = "stopped"; availability = "available"; reason = stopReason
        emitState()
        let backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish voice note") {
            self.log.error("Voice-note finalization exceeded background time; recovery will retry on launch")
        }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            defer { DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(backgroundTask) } }
            do {
                let duration = final.audioMs
                guard duration > 0 else {
                    try library.delete(session.id)
                    throw CaptureError.noAudio
                }
                for (index, event) in stopEvents.enumerated() {
                    try library.appendJournal(session.id, event, fullSync: index == stopEvents.count - 1)
                }
                let lastHeartbeat: Int64?
                if let at = final.heartbeatAt { lastHeartbeat = at }
                else {
                    lastHeartbeat = try library.readJournal(session.id)
                        .last(where: { $0["e"] as? String == "hb" })?["t"] as? Int64
                }
                let sidecar = makeSidecar(session, duration: duration,
                                          wallMs: max(0, stoppedAt - session.startedAt),
                                          pausedMs: paused, spans: spans, recovered: false,
                                          endedUnexpectedly: false,
                                          lastHeartbeatAt: lastHeartbeat, input: input,
                                          noSignalMs: noSignal)
                let committed = try library.commit(session.id, sidecar: sidecar) { staged in
                    try RecordingFinalizer.mux(segments: RecordingFinalizer.segments(in: library.sessionURL(session.id)),
                                               expectedAudioMs: duration, to: staged)
                }
                let flushes = library.syncMetrics()
                for kind in ["F_FULLFSYNC", "F_BARRIERFSYNC", "fsync_fallback"] {
                    if let metric = flushes[kind] {
                        log.notice("\(kind, privacy: .public) count=\(metric.count) meanMs=\(metric.meanMs) maxMs=\(metric.maxMs)")
                    }
                }
                DispatchQueue.main.async {
                    self.emit("committed", committed, retained: true)
                    completion(.success(committed))
                }
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    public func discard() throws -> String? {
        guard let session = info else { return nil }
        generation += 1
        try library.delete(session.id)
        _ = stopInput()
        deactivateGraph(tapRemoved: true)
        _ = try? writer?.finish(at: wallMilliseconds())
        writer = nil; info = nil; intent = "stopped"; reason = "user"
        limitTimer?.invalidate(); limitTimer = nil
        emitState()
        return session.id
    }

    public func setRecordingOptions(_ changed: CaptureOptions) throws {
        guard let session = info else { throw CaptureError.notRecording }
        var actual = changed
        if session.owner == nil { actual.transcriber = "on-device" }
        try library.appendJournal(session.id, ["e": "options", "t": wallMilliseconds(), "a": audioMs,
                                               "transcriber": actual.transcriber,
                                               "identifySpeakers": actual.identifySpeakers])
        options = actual
        info?.options = actual
    }

    public func status() -> [String: Any] {
        let state: String = intent == "stopped" ? "idle" : intent == "paused" ? "paused" :
            availability == "interrupted" ? "interrupted" : availability == "blocked" ? "needs_user" :
            openSpan?.kind == "silenced" ? "silenced" : "recording"
        let now = wallMilliseconds()
        let elapsed = info.map { CaptureTiming.elapsedMilliseconds(startedAt: $0.startedAt,
            closedPaused: pausedMs, pausedSince: pausedSince, now: now) } ?? 0
        return ["state": state, "reason": reason as Any? ?? NSNull(), "id": info?.id as Any? ?? NSNull(),
                "intent": intent, "availability": availability, "startedAt": info?.startedAt as Any? ?? NSNull(),
                "elapsedMs": elapsed, "audioMs": audioMs,
                "pausedMs": CaptureTiming.pausedMilliseconds(closed: pausedMs, since: pausedSince, now: now),
                "maxDurationMs": info?.maxDurationMs ?? 10_800_000,
                "spans": spans.map(Self.spanObject), "openSpan": openSpan.map(Self.spanObject) as Any? ?? NSNull(),
                "source": info?.source as Any? ?? NSNull(),
                "options": ["transcriber": options.transcriber, "identifySpeakers": options.identifySpeakers],
                "input": currentInput as Any? ?? NSNull(), "owner": info?.owner as Any? ?? NSNull(),
                "transitionGen": info?.transitionGen ?? defaults().transitionGen]
    }

    private func emitState() { emit("micState", status().merging(["at": wallMilliseconds()]) { _, newer in newer }, retained: true) }

    private static func spanObject(_ span: MissingAudioSpan) -> [String: Any] {
        ["kind": span.kind, "reason": span.reason, "startedAt": span.startedAt,
         "endedAt": span.endedAt as Any? ?? NSNull(), "atAudioMs": span.atAudioMs, "audioMs": span.audioMs]
    }

    private func makeSidecar(_ session: SessionInfo, duration: Int64, wallMs: Int64,
                             pausedMs: Int64, spans: [MissingAudioSpan], recovered: Bool,
                             endedUnexpectedly: Bool, lastHeartbeatAt: Int64?,
                             input: [String: Any]?, noSignalMs: Int64 = 0) -> [String: Any] {
        SidecarFactory.v2(session: session, durationMs: duration, wallMs: wallMs,
                          pausedMs: pausedMs, spans: spans, input: input,
                          recovered: recovered, endedUnexpectedly: endedUnexpectedly,
                          lastHeartbeatAt: lastHeartbeatAt, noSignalMs: noSignalMs)
    }

    private func recoverSession(_ id: String) throws {
        guard !library.isLiveCapture(id) else { return }
        if FileManager.default.fileExists(atPath: library.sidecarURL(id).path) {
            try library.cleanupCommittedSession(id)
            return
        }
        if !FileManager.default.fileExists(atPath: library.journalURL(id).path) {
            try library.delete(id)
            return
        }
        let events = try library.readJournal(id)
        guard let first = events.first, first["e"] as? String == "session",
              let startedAt = first["t"] as? Int64 else { return }
        let recovered = try JournalRecovery(events: events)
        let segments = try RecordingFinalizer.segments(in: library.sessionURL(id))
        let frames = try segments.reduce(0) { sum, path in sum + ADTS.fullFrameCount(try Data(contentsOf: path)) }
        guard frames > 0 else { try library.delete(id); return }
        let option = events.last(where: { $0["e"] as? String == "options" }) ??
            (first["options"] as? [String: Any] ?? [:])
        let session = SessionInfo(id: id, rate: first["rate"] as? Int ?? 48_000,
                                  bitrate: first["bitrate"] as? Int ?? 64_000,
                                  maxDurationMs: first["maxDurationMs"] as? Int64 ?? 10_800_000,
                                  source: first["source"] as? String ?? "in_app", owner: recovered.owner,
                                  transitionGen: first["transitionGen"] as? Int64 ?? 0,
                                  options: CaptureOptions(transcriber: option["transcriber"] as? String ?? "on-device",
                                                          identifySpeakers: option["identifySpeakers"] as? Bool ?? false),
                                  startedAt: startedAt)
        let sidecar = makeSidecar(session, duration: Int64(frames) * 1024 * 1000 / 48_000,
                                  wallMs: recovered.wallMs, pausedMs: recovered.pausedMs,
                                  spans: recovered.spans, recovered: true,
                                  endedUnexpectedly: recovered.endedUnexpectedly,
                                  lastHeartbeatAt: recovered.lastHeartbeatAt, input: recovered.input)
        let committed = try library.commit(id, sidecar: sidecar) { staged in
            try RecordingFinalizer.mux(segments: segments,
                                       expectedAudioMs: sidecar["durationMs"] as? Int64 ?? 0, to: staged)
        }
        DispatchQueue.main.async { [weak self] in
            self?.emit("recovered", committed, retained: true)
            self?.emit("committed", committed, retained: true)
        }
    }

    private func importLegacyOrphans() throws {
        let files = try FileManager.default.contentsOfDirectory(at: library.root, includingPropertiesForKeys: [.creationDateKey])
        for audio in files where audio.pathExtension == "m4a" {
            let id = audio.deletingPathExtension().lastPathComponent
            guard RecordingLibrary.validID(id),
                  !FileManager.default.fileExists(atPath: library.sessionURL(id).path),
                  !FileManager.default.fileExists(atPath: library.url("tombstones/\(id)").path) else { continue }
            if FileManager.default.fileExists(atPath: library.sidecarURL(id).path),
               (try? library.readSidecar(id)) != nil { continue }
            do {
                try library.probeLegacy(id) {
                let asset = AVURLAsset(url: audio)
                let seconds = CMTimeGetSeconds(asset.duration)
                guard !asset.tracks(withMediaType: .audio).isEmpty, seconds.isFinite, seconds >= 0.5 else {
                    return nil
                }
                let started = Int64(((try? audio.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()).timeIntervalSince1970 * 1000)
                let session = SessionInfo(id: id, source: "in_app", owner: nil,
                                          transitionGen: 0, options: CaptureOptions(), startedAt: started)
                var item = SidecarFactory.v2(session: session, durationMs: Int64(seconds * 1000),
                                              wallMs: Int64(seconds * 1000), pausedMs: 0, spans: [], input: nil,
                                              recovered: true, endedUnexpectedly: false,
                                              lastHeartbeatAt: nil)
                item["legacyImport"] = true; item["ownerUnknown"] = true
                item["sizeBytes"] = (try? audio.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                return item
                }
            } catch {
                log.error("Legacy import failed for \(id, privacy: .public): \(String(describing: error), privacy: .public)")
                DispatchQueue.main.async { [weak self] in
                    self?.emit("recoveryFailed", ["id": id, "reason": String(describing: error)], retained: true)
                }
            }
        }
    }
}

public enum ExoCaptureBootstrap {
    public static func start() {
        CaptureEngine.shared.recoverOnce()
        let center = NotificationCenter.default
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let kind = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if kind == .began { CaptureEngine.shared.interruptionBegan() }
            else { CaptureEngine.shared.interruptionEnded() }
        }
        center.addObserver(forName: AVAudioApplication.inputMuteStateChangeNotification, object: nil, queue: .main) { _ in
            CaptureEngine.shared.inputMuteChanged(AVAudioApplication.shared.isInputMuted)
        }
    }
}
