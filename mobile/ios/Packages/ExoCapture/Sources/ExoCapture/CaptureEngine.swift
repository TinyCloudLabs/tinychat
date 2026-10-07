import AVFoundation
import CaptureCore
import Foundation
import OSLog

public final class CaptureEngine {
    public static let shared = CaptureEngine()
    public let library: RecordingLibrary
    private let log = Logger(subsystem: "xyz.tinycloud.exo", category: "capture")
    private let defaultsKey = "exo.capture.defaults.v2"
    private let recovery = DispatchGroup()
    private let recoveryLock = NSLock()
    private var recoveryFailure: Error?
    private var startedRecovery = false
    private var audioEngine: AVAudioEngine?
    private let tapCallbacks = DispatchGroup()
    private var writer: AacAdtsWriter?
    private var info: SessionInfo?
    private var intent = "stopped"
    private var availability = "available"
    private var reason: String?
    private var generation = 0
    private var startedUptime: TimeInterval = 0
    private var pausedSince: TimeInterval?
    private var pausedMs: Int64 = 0
    private var audioMs: Int64 = 0
    private var spans: [MissingAudioSpan] = []
    private var openSpan: MissingAudioSpan?
    private var lastLevel = Date.distantPast
    private var appActive = false
    private var zeroSince: Date?
    private var options = CaptureOptions()
    private var currentInput: [String: Any]?
    private var limitTimer: Timer?
    private var lastDiskCheck = Date.distantPast
    private var observers: [UUID: (String, [String: Any], Bool) -> Void] = [:]
    private var retainedEvents: [(String, [String: Any])] = []

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("voice-notes", isDirectory: true)
        // This directory is required before a plugin or a scene exists. Failure is fatal to
        // capture operations and is surfaced through the plugin, not papered over with a new path.
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
                for id in try library.recoverableSessions() {
                    do { try recoverSession(id) }
                    catch {
                        recoveryLock.lock(); recoveryFailure = recoveryFailure ?? error; recoveryLock.unlock()
                        log.error("Recovery failed for \(id, privacy: .public): \(String(describing: error), privacy: .public)")
                    }
                }
                try importLegacyOrphans()
            } catch {
                recoveryLock.lock(); recoveryFailure = recoveryFailure ?? error; recoveryLock.unlock()
                log.error("Recovery scan failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    public func awaitRecovery() throws {
        recovery.wait()
        recoveryLock.lock(); defer { recoveryLock.unlock() }
        if let recoveryFailure { throw recoveryFailure }
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
        try awaitRecovery()
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
        reason = nil; spans = []; openSpan = nil; audioMs = 0; pausedMs = 0; pausedSince = nil
        startedUptime = ProcessInfo.processInfo.systemUptime
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
        if source != "in_app" { emit("presentRecorder", ["id": session.id], retained: true) }
        return ["id": session.id, "startedAt": now, "maxDurationMs": limit]
    }

    private func activateGraph() throws {
        guard let session = info else { throw CaptureError.notRecording }
        let audioSession = AVAudioSession.sharedInstance()
        var acquired = false
        defer {
            if !acquired {
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
        try library.appendJournal(session.id, ["e": "avail", "t": wallMilliseconds(), "a": audioMs,
                                               "value": "available", "reason": NSNull(), "gen": generation])
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
            currentInput = ["id": port.uid, "name": port.portName, "kind": kind]
            try library.appendJournal(session.id, ["e": "input", "t": wallMilliseconds(), "a": audioMs,
                                                   "id": port.uid, "name": port.portName, "kind": kind])
        }
        let engine = AVAudioEngine()
        let node = engine.inputNode
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw CaptureError.io("microphone input has no format") }
        let writer: AacAdtsWriter
        if let existing = self.writer { try existing.reopen(); writer = existing }
        else {
            try library.openFirstSegment(session.id)
            writer = try AacAdtsWriter(library: library, id: session.id); self.writer = writer
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
        node.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self, weak writer] buffer, _ in
            self?.tapCallbacks.enter()
            defer { self?.tapCallbacks.leave() }
            writer?.enqueue(buffer)
        }
        engine.prepare()
        try engine.start()
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
        engine.stop()
        guard !engine.isRunning else { return false }
        engine.inputNode.removeTap(onBus: 0)
        tapCallbacks.wait()
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
            zeroSince = nil
            if reason == "no_signal" { reason = nil; emitState() }
        }
        if appActive && now.timeIntervalSince(lastLevel) >= 0.05 {
            emit("level", ["level": level, "peak": peak]); lastLevel = now
        }
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

    public func pause() throws {
        guard let session = info else { throw CaptureError.notRecording }
        if intent == "paused" { return }
        guard intent == "recording" else { throw CaptureError.notRecording }
        generation += 1
        // Stop input first. The writer retains every buffer delivered through the tap,
        // including a callback already in flight, before the queue is drained.
        guard stopInput() else { throw CaptureError.pauseFailed }
        let closed: (audioMs: Int64, at: Int64)?
        do { closed = try writer?.closeForPause() }
        catch {
            writerFailed(error)
            throw CaptureError.pauseFailed
        }
        audioMs = closed?.audioMs ?? audioMs
        closeSpan(at: closed?.at)
        do {
            try library.appendJournal(session.id, ["e": "intent", "t": closed?.at ?? wallMilliseconds(), "a": audioMs,
                                                   "value": "paused", "by": "user"], fullSync: true)
        } catch {
            writerFailed(error)
            throw CaptureError.pauseFailed
        }
        intent = "paused"; reason = "user"; pausedSince = ProcessInfo.processInfo.systemUptime
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch {
            log.error("Audio session remained active after Pause: \(String(describing: error), privacy: .public)")
        }
        emitState()
    }

    public func resume() throws {
        guard let session = info else { throw CaptureError.notRecording }
        guard intent == "paused" || availability != "available" else { return }
        let wasPaused = intent == "paused"
        generation += 1
        if wasPaused {
            if let since = pausedSince { pausedMs += Int64((ProcessInfo.processInfo.systemUptime - since) * 1000) }
            pausedSince = nil
            intent = "recording"
            try library.appendJournal(session.id, ["e": "intent", "t": wallMilliseconds(), "a": audioMs,
                                                   "value": "recording", "by": "user"])
        }
        do {
            try activateGraph()
            availability = "available"; reason = nil; closeSpan()
        } catch {
            availability = "blocked"; reason = "resume_blocked"
            try library.appendJournal(session.id, ["e": "avail", "t": wallMilliseconds(), "a": audioMs,
                                                   "value": "blocked", "reason": "resume_blocked", "gen": generation], fullSync: true)
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
        deactivateGraph(tapRemoved: true)
        if intent == "recording" { openOmittedSpan("interruption") }
        availability = "interrupted"; reason = "interruption"
        try? library.appendJournal(session.id, ["e": "avail", "t": wallMilliseconds(), "a": audioMs,
                                                "value": "interrupted", "reason": "interruption", "gen": generation])
        emitState()
    }

    public func interruptionEnded() {
        guard info != nil, intent == "recording", availability == "interrupted" else { return }
        do { try resume() }
        catch { log.error("Interruption restart failed: \(String(describing: error), privacy: .public)") }
    }

    private func openOmittedSpan(_ why: String) {
        guard openSpan == nil, let session = info else { return }
        openSpan = MissingAudioSpan(kind: "omitted", reason: why,
                                    startedAt: wallMilliseconds(), atAudioMs: audioMs)
        try? library.appendJournal(session.id, ["e": "span_open", "t": wallMilliseconds(),
                                                "a": audioMs, "kind": "omitted", "reason": why])
    }

    private func closeSpan(at timestamp: Int64? = nil) {
        guard var span = openSpan else { return }
        span.endedAt = timestamp ?? wallMilliseconds()
        if span.kind == "silenced" { span.audioMs = max(0, audioMs - span.atAudioMs) }
        spans.append(span); openSpan = nil
        if let session = info {
            try? library.appendJournal(session.id, ["e": "span_close", "t": span.endedAt!,
                                                    "a": audioMs, "kind": span.kind, "reason": span.reason])
        }
    }

    public func inputMuteChanged(_ muted: Bool) {
        guard let session = info, intent == "recording" else { return }
        if muted {
            guard openSpan == nil else { return }
            openSpan = MissingAudioSpan(kind: "silenced", reason: "input_muted",
                                        startedAt: wallMilliseconds(), atAudioMs: audioMs)
            reason = "input_muted"
            try? library.appendJournal(session.id, ["e": "span_open", "t": wallMilliseconds(),
                                                    "a": audioMs, "kind": "silenced", "reason": "input_muted"])
        } else { closeSpan(); reason = nil }
        emitState()
    }

    public func stop(reason stopReason: String = "user",
                     completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let session = info else { completion(.failure(CaptureError.notRecording)); return }
        generation += 1
        closeSpan()
        guard stopInput() else {
            completion(.failure(CaptureError.io("stop capture input")))
            return
        }
        let final: (audioMs: Int64, heartbeatAt: Int64?)
        do { final = try writer?.finish() ?? (audioMs: 0, heartbeatAt: nil) }
        catch {
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
        if let since = pausedSince { pausedMs += Int64((ProcessInfo.processInfo.systemUptime - since) * 1000) }
        let paused = pausedMs
        let spans = self.spans
        let input = currentInput
        limitTimer?.invalidate(); limitTimer = nil
        writer = nil; info = nil; intent = "stopped"; availability = "available"; reason = stopReason
        emitState()
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            do {
                let duration = final.audioMs
                guard duration > 0 else {
                    try library.delete(session.id)
                    throw CaptureError.noAudio
                }
                let stoppedAt = wallMilliseconds()
                let stoppedBy = stopReason == "max_duration" ? "limit" :
                    stopReason == "disk_full" ? "disk" : stopReason
                try library.appendJournal(session.id, ["e": "intent", "t": stoppedAt,
                                                       "a": duration, "value": "stopped", "by": stoppedBy])
                try library.appendJournal(session.id, ["e": "stop", "t": stoppedAt,
                                                       "a": duration, "reason": stopReason], fullSync: true)
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
                                          lastHeartbeatAt: lastHeartbeat, input: input)
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
        deactivateGraph()
        try library.delete(session.id) // tombstone before the writer is released
        _ = try? writer?.finish()
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
        let elapsed = info == nil ? 0 : max(0, Int64((ProcessInfo.processInfo.systemUptime - startedUptime) * 1000) - pausedMs -
                                               Int64((pausedSince.map { ProcessInfo.processInfo.systemUptime - $0 } ?? 0) * 1000))
        return ["state": state, "reason": reason as Any? ?? NSNull(), "id": info?.id as Any? ?? NSNull(),
                "intent": intent, "availability": availability, "startedAt": info?.startedAt as Any? ?? NSNull(),
                "elapsedMs": elapsed, "audioMs": audioMs, "pausedMs": pausedMs + Int64((pausedSince.map { ProcessInfo.processInfo.systemUptime - $0 } ?? 0) * 1000),
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
                             input: [String: Any]?) -> [String: Any] {
        SidecarFactory.v2(session: session, durationMs: duration, wallMs: wallMs,
                          pausedMs: pausedMs, spans: spans, input: input,
                          recovered: recovered, endedUnexpectedly: endedUnexpectedly,
                          lastHeartbeatAt: lastHeartbeatAt)
    }

    private func recoverSession(_ id: String) throws {
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
