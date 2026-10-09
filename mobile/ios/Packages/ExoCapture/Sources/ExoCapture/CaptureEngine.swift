import AVFoundation
import CaptureCore
import Foundation
import OSLog
import UIKit

public enum CaptureResumeError: Error, LocalizedError {
    case failed
    public var code: String { "resume_failed" }
    public var errorDescription: String? { code }
}

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
    private var lastTapAt: TimeInterval = 0
    private var tapDeliveryCount: UInt64 = 0
    private var observedTapDeliveryCount: UInt64 = 0
    private var consecutiveStalls = 0
    private var stallBackoffActive = false
    private var writer: AacAdtsWriter?
    private var info: SessionInfo?
    private var intent = "stopped"
    private var availability = "available"
    private var reason: String?
    private var attempts = CaptureAttemptGate()
    private var generation: Int { attempts.generation }
    private let inputRouter = InputRouter()
    private var retryTimer: Timer?
    private var backoff = CaptureBackoffSchedule()
    private var notificationPending = false
    private var graphActive = false
    private var pausedSince: Int64?
    private var pausedMs: Int64 = 0
    private var audioMs: Int64 = 0
    private var wallClock: CaptureClock = SystemCaptureClock()
    private var spans: [MissingAudioSpan] = []
    private var openSpan: MissingAudioSpan?
    private var lastLevel = Date.distantPast
    private var appActive = false
    private var zeroSince: Date?
    private var noSignalMs: Int64 = 0
    private var options = CaptureOptions()
    private var currentInput: [String: Any]?
    private var currentInputRate: Double?
    private var transitions: CaptureTransitionMachine?
    private var limitTimer: Timer?
    private var lastDiskCheck = Date.distantPast
    private var observers: [UUID: (String, [String: Any], Bool) -> Void] = [:]
    private var retainedEvents: [(String, [String: Any])] = []
    #if DEBUG
    private var debugTesting = false
    private var debugSuppressTapDelivery = false
    private(set) var debugResetNotifications = 0
    private(set) var debugResumeNotices: [(id: String, epoch: Int, reason: String)] = []
    private(set) var debugSegmentOpenCount = 0
    var debugForeground: Bool?
    var debugActivationError: Error?
    var debugActivationAttempts = 0
    var debugBeforeAttach: (() -> Void)?
    var debugInputRoute: (id: String?, sampleRate: Double?)?
    var debugNow: (() -> TimeInterval)?
    #endif
    private var isForeground: Bool {
        #if DEBUG
        if let debugForeground { return debugForeground }
        #endif
        return appActive || UIApplication.shared.applicationState == .active
    }
    private var retryNow: TimeInterval {
        #if DEBUG
        if let debugNow { return debugNow() }
        #endif
        return ProcessInfo.processInfo.systemUptime
    }

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("voice-notes", isDirectory: true)
        // This directory is required before a plugin or a scene exists. Initialization failure
        // terminates launch because no capture or library operation can be made durable.
        do { library = try RecordingLibrary(root: base) }
        catch { fatalError("Voice-note library unavailable: \(error)") }
    }

    #if DEBUG
    init(testRoot: URL, clock: CaptureClock = SystemCaptureClock()) throws {
        library = try RecordingLibrary(root: testRoot)
        wallClock = clock
        debugTesting = true
    }
    var debugGraphActive: Bool { graphActive || audioEngine?.isRunning == true }
    var debugLimitTimerArmed: Bool { limitTimer?.isValid == true }
    var debugRetryPending: Bool { retryTimer != nil }
    var debugEpoch: Int { attempts.epoch }
    func debugRetryTick() { retryTimer?.invalidate(); retryTimer = nil; try? attemptResume(automatic: true) }
    func debugStopEngineWithoutTransition() { audioEngine?.stop() }
    func debugAgeLastTap(by seconds: TimeInterval) {
        tapTimeLock.lock(); lastTapAt = retryNow - seconds; tapTimeLock.unlock()
    }
    func debugWatchdogTick() { checkDurationLimit() }
    func debugSuppressTaps() {
        tapTimeLock.lock(); debugSuppressTapDelivery = true; tapTimeLock.unlock()
    }
    func debugRecordDeliveredTap() {
        tapTimeLock.lock()
        tapDeliveryCount &+= 1
        lastTapAt = retryNow
        tapTimeLock.unlock()
    }
    #endif

    public func observe(_ body: @escaping (String, [String: Any], Bool) -> Void) -> UUID {
        let token = UUID(); observers[token] = body
        for (name, data) in retainedEvents { body(name, data, true) }
        retainedEvents.removeAll()
        return token
    }
    public func removeObserver(_ token: UUID) { observers.removeValue(forKey: token) }
    public func setAppActive(_ active: Bool) {
        let becameActive = active && !appActive
        appActive = active
        if becameActive, info != nil, intent == "recording", availability != "available" {
            try? attemptResume(automatic: true, retryOnFailure: availability != "blocked")
        }
    }
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
                try library.appendJournal(live.id, ["e": "owner", "t": wallClock.nowMilliseconds(),
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
        let now = wallClock.nowMilliseconds()
        let session = SessionInfo(id: UUID().uuidString.lowercased(), maxDurationMs: limit,
                                  source: source, owner: settings.accountDid,
                                  transitionGen: settings.transitionGen, options: selected,
                                  startedAt: now)
        try library.startSession(session)
        info = session; options = selected; intent = "recording"; availability = "available"
        transitions = CaptureTransitionMachine()
        reason = nil; spans = []; openSpan = nil; audioMs = 0; pausedMs = 0; pausedSince = nil
        currentInput = nil; currentInputRate = nil
        consecutiveStalls = 0; stallBackoffActive = false
        tapTimeLock.lock(); observedTapDeliveryCount = tapDeliveryCount; tapTimeLock.unlock()
        noSignalMs = 0; zeroSince = nil
        lastDiskCheck = Date()
        let ticket = attempts.startSession(session.id)
        limitTimer?.invalidate()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkDurationLimit() }
        RunLoop.main.add(timer, forMode: .common)
        limitTimer = timer
        #if DEBUG
        if !debugTesting { CaptureNotifications.requestOnFirstRecording() }
        #else
        CaptureNotifications.requestOnFirstRecording()
        #endif
        do { try activateGraph(ticket: ticket) }
        catch {
            if info?.id == session.id && intent == "recording" {
                limitTimer?.invalidate(); limitTimer = nil
                try? library.delete(session.id)
                info = nil; intent = "stopped"; attempts.stop()
            }
            throw error
        }
        emitState()
        if source != "in_app" { presentRecorder() }
        return ["id": session.id, "startedAt": now, "maxDurationMs": limit]
    }

    private func activateGraph(ticket: CaptureAttemptGate.Ticket) throws {
        guard let session = info else { throw CaptureError.notRecording }
        #if DEBUG
        debugActivationAttempts += 1
        if let debugActivationError { throw debugActivationError }
        #endif
        let audioSession = AVAudioSession.sharedInstance()
        var acquired = false
        var pendingEngine: AVAudioEngine?
        defer {
            if !acquired {
                pendingEngine?.stop()
                do {
                    try audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                    graphActive = false
                }
                catch { log.error("Audio session cleanup failed: \(String(describing: error), privacy: .public)") }
            }
        }
        _ = try inputRouter.list()
        try audioSession.setPrefersNoInterruptionsFromSystemAlerts(true)
        try audioSession.setPrefersInterruptionOnRouteDisconnect(false)
        try audioSession.setActive(true)
        graphActive = true
        try inputRouter.apply()
        let engine = AVAudioEngine()
        pendingEngine = engine
        let node = engine.inputNode
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw CaptureError.io("microphone input has no format") }
        // Verify the input can actually start before recording a successful acquisition.
        engine.prepare()
        try engine.start()
        #if DEBUG
        debugBeforeAttach?()
        #endif
        // `start.beforeAttach`: no journal event, writer segment or tap belongs to a cancelled
        // attempt. The pending engine is the only instance this cleanup may stop.
        guard attempts.mayAttach(ticket), info?.id == ticket.id, intent == "recording" else {
            throw CaptureError.cancelled
        }
        let acquiredAt = wallClock.nowMilliseconds()
        // The transition machine emits span_close, availability, and only a changed input.
        let input = inputRouter.active()
        if let input {
            currentInput = ["id": input.id, "name": input.name, "kind": input.kind]
        }
        currentInputRate = audioSession.sampleRate
        var next = transitions ?? CaptureTransitionMachine()
        for event in next.acquired(at: acquiredAt, audioMs: audioMs, generation: generation, input: input) {
            try library.appendJournal(session.id, event)
        }
        if openSpan != nil { closeSpan(at: acquiredAt, journal: false) }
        transitions = next
        let writer: AacAdtsWriter
        if let existing = self.writer { try existing.reopen(); writer = existing }
        else {
            let openedAt = wallClock.nowMilliseconds()
            try library.openFirstSegment(session.id, at: openedAt)
            writer = try AacAdtsWriter(library: library, id: session.id, segmentOpenedAt: openedAt,
                                       clock: wallClock)
            self.writer = writer
        }
        #if DEBUG
        debugSegmentOpenCount += 1
        #endif
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
        tapTimeLock.lock(); lastTapEndSample = nil; lastTapAt = retryNow; tapTimeLock.unlock()
        let attemptGeneration = generation
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, writer] buffer, when in
            self?.tapCallbacks.enter()
            defer { self?.tapCallbacks.leave() }
            var delivered = true
            self?.tapTimeLock.lock()
            #if DEBUG
            if self?.debugSuppressTapDelivery == true { delivered = false }
            #endif
            if let self {
                if delivered {
                    self.lastTapAt = ProcessInfo.processInfo.systemUptime
                    self.tapDeliveryCount &+= 1
                    if when.isSampleTimeValid {
                        self.lastTapEndSample = when.sampleTime + AVAudioFramePosition(buffer.frameLength)
                    }
                }
            }
            self?.tapTimeLock.unlock()
            if delivered { writer.enqueue(buffer, generation: attemptGeneration) }
        }
        audioEngine = engine
        acquired = true
        _ = attempts.succeeded(ticket)
        clearResumeNotification()
    }

    private func deactivateGraph(tapRemoved: Bool = false) {
        if let engine = audioEngine {
            if !tapRemoved { engine.inputNode.removeTap(onBus: 0) }
            engine.stop()
        }
        audioEngine = nil
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            graphActive = false
        }
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
        observedTapDeliveryCount = tapDeliveryCount
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
        if let session = info, intent == "recording",
           (status()["elapsedMs"] as? Int64 ?? 0) >= session.maxDurationMs {
            stop(reason: "max_duration") { [weak self] result in
                let recording: Any = (try? result.get()) ?? NSNull()
                self?.emit("autoStopped", ["reason": "max_duration", "maxDurationMs": session.maxDurationMs,
                                            "at": wallMilliseconds(), "recording": recording], retained: true)
            }
            return
        }
        if info != nil, intent == "recording", availability == "available" {
            tapTimeLock.lock()
            let last = lastTapAt
            let delivered = tapDeliveryCount
            tapTimeLock.unlock()
            if delivered != observedTapDeliveryCount {
                observedTapDeliveryCount = delivered
                consecutiveStalls = 0
                stallBackoffActive = false
                backoff.reset()
            }
            if last > 0 && retryNow - last > 3 {
                consecutiveStalls += 1
                if consecutiveStalls == 1 {
                    rebuildForRoute("stalled")
                } else {
                    stallBackoffActive = true
                    suspendForInterruption("stalled", notify: false)
                    if availability == "interrupted" { scheduleRetry() }
                }
                return
            }
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
        consecutiveStalls = 0; stallBackoffActive = false
        cancelRetry()
        clearResumeNotification()
        var next = transitions ?? CaptureTransitionMachine()
        let input = ClosureInputControl(stop: { [self] in stopInput() }, release: { [self] in
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            graphActive = false
        })
        let frames = ClosureFrameSink(close: { [self] in try writer?.closeForPause() })
        let journal = ClosureJournalSink(write: { [self] event, fullSync in
            try library.appendJournal(session.id, event, fullSync: fullSync)
        })
        let paused: (audioMs: Int64, at: Int64)
        do {
            paused = try next.pause(input: input, frames: frames, journal: journal,
                                    clock: wallClock, currentAudioMs: audioMs) { [self] error in
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
        intent = "paused"; availability = "available"; reason = "user"; pausedSince = paused.at
        attempts.pause()
        emitState()
    }

    public func resume() throws {
        try attemptResume(automatic: false)
    }

    private func attemptResume(automatic: Bool, allowedBackgroundIntent: Bool = false,
                               retryOnFailure: Bool = true) throws {
        guard let session = info else { throw CaptureError.notRecording }
        guard intent == "paused" || availability != "available" else { return }
        let wasPaused = intent == "paused"
        if !automatic && !isForeground && !allowedBackgroundIntent {
            if wasPaused {
                let now = wallClock.nowMilliseconds()
                var next = transitions ?? CaptureTransitionMachine()
                for event in next.resumed(at: now, audioMs: audioMs) { try library.appendJournal(session.id, event) }
                if let since = pausedSince { pausedMs += max(0, now - since) }
                pausedSince = nil; intent = "recording"; transitions = next
                _ = attempts.resumePaused()
            }
            markBlocked("resume_not_allowed")
            throw CaptureResumeError.failed
        }
        let ticket: CaptureAttemptGate.Ticket?
        if wasPaused {
            let now = wallClock.nowMilliseconds()
            var next = transitions ?? CaptureTransitionMachine()
            for event in next.resumed(at: now, audioMs: audioMs) { try library.appendJournal(session.id, event) }
            if let since = pausedSince { pausedMs += max(0, now - since) }
            pausedSince = nil
            intent = "recording"
            transitions = next
            ticket = attempts.resumePaused()
        } else {
            ticket = attempts.attempt()
        }
        guard let ticket else { throw CaptureError.cancelled }
        if !automatic {
            consecutiveStalls = 0; stallBackoffActive = false
            cancelRetry()
        }
        do {
            try activateGraph(ticket: ticket)
            availability = "available"; reason = nil
            cancelRetry(resetBackoff: !stallBackoffActive)
        } catch {
            log.error("Capture restart failed: \(String(describing: error), privacy: .public)")
            guard attempts.mayAttach(ticket) else { throw CaptureError.cancelled }
            let failureReason = Self.failureReason(error)
            if automatic && (!isForeground || failureReason == "resume_not_allowed") {
                cancelRetry()
                markBlocked("resume_not_allowed")
                return
            }
            if automatic && retryOnFailure { scheduleRetry(); return }
            cancelRetry()
            markBlocked(failureReason)
            if automatic { return }
            throw CaptureResumeError.failed
        }
        emitState()
    }

    public func interruptionBegan() {
        suspendForInterruption("interruption", notify: true)
    }

    public func appWasSuspended() { suspendForInterruption("app_suspended", notify: false) }

    private static func failureReason(_ error: Error) -> String {
        let code = (error as NSError).code
        if code == AVAudioSession.ErrorCode.cannotStartRecording.rawValue { return "resume_not_allowed" }
        if [AVAudioSession.ErrorCode.insufficientPriority.rawValue,
            AVAudioSession.ErrorCode.isBusy.rawValue,
            AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue].contains(code) {
            return "mic_unavailable"
        }
        return "resume_blocked"
    }

    private func suspendForInterruption(_ cause: String, notify: Bool) {
        guard let session = info, intent == "recording", availability == "available" else { return }
        let notice = attempts.interrupted()
        if cause != "stalled" { consecutiveStalls = 0; stallBackoffActive = false }
        cancelRetry(resetBackoff: !stallBackoffActive)
        guard stopInput() else {
            log.error("Could not stop capture input during interruption")
            return
        }
        do { audioMs = try writer?.closeForPause().audioMs ?? audioMs }
        catch { writerFailed(error); return }
        closeNoSignal()
        deactivateGraph(tapRemoved: true)
        let interruptedAt = wallClock.nowMilliseconds()
        if openSpan != nil { closeSpan(at: interruptedAt) }
        var next = transitions ?? CaptureTransitionMachine()
        let events = next.interrupted(at: interruptedAt, audioMs: audioMs,
                                      generation: generation, reason: cause)
        if events.first?["e"] as? String == "span_open" {
            openSpan = MissingAudioSpan(kind: "omitted", reason: cause,
                                        startedAt: interruptedAt, atAudioMs: audioMs)
        }
        availability = "interrupted"; reason = cause
        do {
            for event in events { try library.appendJournal(session.id, event) }
            transitions = next
        }
        catch { log.error("Journal interruption failed: \(String(describing: error), privacy: .public)") }
        if notify, let notice {
            scheduleResumeNotification(id: notice.id, epoch: notice.epoch, reason: cause)
            notificationPending = true
        }
        emitState()
    }

    public func interruptionEnded() {
        guard info != nil, intent == "recording", availability == "interrupted" else { return }
        do { try attemptResume(automatic: true) }
        catch { log.error("Interruption restart failed: \(String(describing: error), privacy: .public)") }
    }

    private func scheduleRetry() {
        guard info != nil, intent == "recording" else { return }
        guard let delay = backoff.nextDelay(at: retryNow) else {
            let reason = stallBackoffActive ? "stalled" : "resume_blocked"
            cancelRetry(); markBlocked(reason); return
        }
        retryTimer?.invalidate()
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            try? self?.attemptResume(automatic: true)
        }
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
        emitState()
    }

    private func cancelRetry(resetBackoff: Bool = true) {
        retryTimer?.invalidate(); retryTimer = nil
        if resetBackoff { backoff.reset() }
    }

    private func clearResumeNotification() {
        guard notificationPending, let id = info?.id else { return }
        notificationPending = false
        #if DEBUG
        if debugTesting { return }
        #endif
        CaptureNotifications.remove(id: id)
    }

    private func scheduleResumeNotification(id: String, epoch: Int, reason: String) {
        #if DEBUG
        if debugTesting {
            debugResumeNotices.append((id, epoch, reason))
            return
        }
        #endif
        CaptureNotifications.schedule(id: id, epoch: epoch, reason: reason)
    }

    private func notifyMediaServicesRestarted(id: String) {
        #if DEBUG
        if debugTesting { debugResetNotifications += 1; return }
        #endif
        CaptureNotifications.mediaServicesRestarted(id: id)
    }

    private func markBlocked(_ why: String) {
        guard let session = info else { return }
        if openSpan == nil { openOmittedSpan(why) }
        availability = "blocked"; reason = why; attempts.blocked()
        var next = transitions ?? CaptureTransitionMachine()
        do {
            for event in next.blocked(at: wallClock.nowMilliseconds(), audioMs: audioMs,
                                      generation: generation, reason: why) {
                try library.appendJournal(session.id, event, fullSync: true)
            }
            transitions = next
        } catch { log.error("Blocked-state journal failed: \(String(describing: error), privacy: .public)") }
        if !notificationPending {
            scheduleResumeNotification(id: session.id, epoch: attempts.epoch, reason: why)
            notificationPending = true
        }
        emitState()
    }

    public func resumeFromNotification(id: String, epoch: Int) {
        guard attempts.accepts(.init(id: id, epoch: epoch)) else { return }
        presentRecorder()
        // Notification taps open the app; input acquisition waits for foreground delivery.
        if isForeground { try? attemptResume(automatic: false) }
    }

    private func openOmittedSpan(_ why: String) {
        guard openSpan == nil, let session = info else { return }
        let at = wallClock.nowMilliseconds()
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
        span.endedAt = timestamp ?? wallClock.nowMilliseconds()
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
            let at = wallClock.nowMilliseconds()
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
        clearResumeNotification(); attempts.stop(); cancelRetry()
        guard stopInput() else {
            completion(.failure(CaptureError.io("stop capture input")))
            return
        }
        closeNoSignal()
        let stoppedAt = wallClock.nowMilliseconds()
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
        clearResumeNotification(); attempts.stop(); cancelRetry()
        try library.delete(session.id)
        _ = stopInput()
        deactivateGraph(tapRemoved: true)
        _ = try? writer?.finish(at: wallClock.nowMilliseconds())
        writer = nil; info = nil; intent = "stopped"; reason = "user"
        limitTimer?.invalidate(); limitTimer = nil
        emitState()
        return session.id
    }

    public func setRecordingOptions(_ changed: CaptureOptions) throws {
        guard let session = info else { throw CaptureError.notRecording }
        var actual = changed
        if session.owner == nil { actual.transcriber = "on-device" }
        try library.appendJournal(session.id, ["e": "options", "t": wallClock.nowMilliseconds(), "a": audioMs,
                                               "transcriber": actual.transcriber,
                                               "identifySpeakers": actual.identifySpeakers])
        options = actual
        info?.options = actual
    }

    public func status() -> [String: Any] {
        let state: String = intent == "stopped" ? "idle" : intent == "paused" ? "paused" :
            availability == "interrupted" ? "interrupted" : availability == "blocked" ? "needs_user" :
            openSpan?.kind == "silenced" ? "silenced" : "recording"
        let now = wallClock.nowMilliseconds()
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

    public func listInputs() throws -> [String: Any] { try inputRouter.list() }

    public func selectInput(_ id: String?) throws {
        let selected = inputRouter.selectedID
        try inputRouter.select(id)
        let active = currentInput?["id"] as? String
        if selected != id, id != active, info != nil && intent == "recording" && availability == "available" {
            rebuildForRoute("route_change")
        }
    }

    public func routeChanged() {
        guard info != nil else { return }
        if intent == "paused" {
            // The list is read afresh at Resume; an OS route event cannot activate the input.
            emitState()
        } else if availability == "available" {
            #if DEBUG
            let route = debugInputRoute ?? (inputRouter.active()?.id, AVAudioSession.sharedInstance().sampleRate)
            #else
            let route = (inputRouter.active()?.id, AVAudioSession.sharedInstance().sampleRate)
            #endif
            guard route.0 != currentInput?["id"] as? String ||
                    (route.1 != nil && route.1 != currentInputRate) else { return }
            rebuildForRoute("route_change")
        }
    }

    public func engineConfigurationChanged(_ engine: AVAudioEngine?) {
        guard engine != nil, engine === audioEngine else { return }
        if intent == "recording", availability == "available" { rebuildForRoute("route_change") }
    }

    public func mediaServicesReset() {
        guard info != nil else { return }
        if intent == "paused" { return }
        if availability == "available", rebuildForRoute("media_services_reset"), let id = info?.id {
            notifyMediaServicesRestarted(id: id)
            emit("captureAlert", ["id": id, "reason": "media_services_reset",
                                  "message": "Recording restarted after an audio system reset"], retained: true)
        }
    }

    @discardableResult private func rebuildForRoute(_ cause: String) -> Bool {
        suspendForInterruption(cause, notify: false)
        guard availability == "interrupted" else { return false }
        do { try attemptResume(automatic: true) }
        catch { log.error("Route restart failed: \(String(describing: error), privacy: .public)") }
        return availability == "available"
    }

    /// Deterministic simulator probe of the same generation/epoch gate used at attach and on tap.
    public func simulate(_ scenario: String) -> [String: Any] {
        guard scenario == "transitions" else { return ["error": "unknown_scenario"] }
        var gate = CaptureAttemptGate()
        let id = UUID().uuidString
        _ = gate.startSession(id)
        let notice = gate.interrupted()!
        let retry = gate.attempt()!
        let epochDuringRetry = gate.epoch == notice.epoch
        gate.pause()
        let staleTapIgnored = !gate.accepts(notice) && gate.intent == "paused"
        let staleAttachRejected = !gate.mayAttach(retry)
        let pausedCallIgnored = gate.interrupted() == nil && gate.intent == "paused"
        let resumed = gate.resumePaused()!
        let newSegmentAllowed = gate.mayAttach(resumed) && gate.succeeded(resumed)
        let noOldNotice = !gate.accepts(notice)
        gate.stop()
        let stopRejectsAttach = !gate.mayAttach(resumed)
        var manual = CaptureAttemptGate()
        _ = manual.startSession("manual")
        let noEndedNotice = manual.interrupted()!
        let failed = manual.attempt()!
        manual.blocked()
        let noEndedNoticeValid = manual.accepts(noEndedNotice)
        let manualTicket = manual.attempt()!
        let manualAfterFailedRestart = !manual.mayAttach(failed) && manual.succeeded(manualTicket)
        var stoppedBackoff = CaptureAttemptGate()
        _ = stoppedBackoff.startSession("backoff")
        _ = stoppedBackoff.interrupted()
        let pendingBackoff = stoppedBackoff.attempt()!
        stoppedBackoff.stop()
        var refused = CaptureTransitionMachine()
        _ = try? refused.paused(at: 1, audioMs: 0, inputStopped: true)
        _ = refused.resumed(at: 2, audioMs: 0)
        let refusal = refused.blocked(at: 3, audioMs: 0, generation: 2,
                                      reason: "resume_not_allowed")
        let elapsed = CaptureTiming.elapsedMilliseconds(startedAt: 0,
            closedPaused: 7_200_000, pausedSince: nil, now: 18_000_000)
        var result: [String: Any] = ["epochDuringRetry": epochDuringRetry, "staleTapIgnored": staleTapIgnored,
                "staleAttachRejected": staleAttachRejected, "pausedCallIgnored": pausedCallIgnored,
                "newSegmentAllowed": newSegmentAllowed, "noOldNotice": noOldNotice,
                "stopRejectsAttach": stopRejectsAttach, "recordedLimitMs": elapsed,
                "sessionInactive": !graphActive && audioEngine == nil,
                "noEndedNotice": noEndedNoticeValid,
                "manualAfterFailedRestart": manualAfterFailedRestart,
                "stopDuringBackoff": !stoppedBackoff.mayAttach(pendingBackoff),
                "backgroundRefusal": refusal.first?["reason"] as? String == "resume_not_allowed"]
        do { result["live"] = try simulateLivePause() }
        catch { result["live"] = ["error": String(describing: error)] }
        return result
    }

    private func simulateLivePause() throws -> [String: Any] {
        let started = try start(source: "in_app")
        let id = started["id"] as! String
        defer { if info?.id == id { _ = try? discard() } }
        try pause()
        let inactiveOnPause = audioEngine == nil && !graphActive && status()["state"] as? String == "paused"
        interruptionBegan(); interruptionEnded()
        let stayedPaused = status()["state"] as? String == "paused" && audioEngine == nil
        mediaServicesReset()
        try resume()
        let resumedRecording = status()["state"] as? String == "recording" && audioEngine?.isRunning == true
        let events = try library.readJournal(id)
        let segments = events.filter { $0["e"] as? String == "segment" }.count
        let noPauseSpan = !events.contains { $0["e"] as? String == "span_open" }
        let beforeUnchangedRoute = segments
        routeChanged()
        let routeUnchanged = try library.readJournal(id).filter { $0["e"] as? String == "segment" }.count == beforeUnchangedRoute
        audioEngine?.stop() // Simulate a graph that stopped without an interruption notification.
        tapTimeLock.lock(); lastTapAt = retryNow - 4; tapTimeLock.unlock()
        checkDurationLimit()
        let stalledEvents = try library.readJournal(id)
        let stalledRebuild = stalledEvents.contains {
            $0["e"] as? String == "span_open" && $0["reason"] as? String == "stalled"
        } && stalledEvents.filter { $0["e"] as? String == "segment" }.count == segments + 1
        inputMuteChanged(true)
        interruptionBegan()
        let silencedClosedForCall = spans.last?.kind == "silenced" &&
            openSpan?.kind == "omitted" && openSpan?.reason == "interruption"
        _ = try discard()
        return ["inactiveOnPause": inactiveOnPause, "stayedPaused": stayedPaused,
                "resumedRecording": resumedRecording, "newSegment": segments >= 2,
                "noPauseSpan": noPauseSpan, "routeUnchanged": routeUnchanged,
                "stalledRebuild": stalledRebuild, "silencedClosedForCall": silencedClosedForCall,
                "inactiveAfterDiscard": audioEngine == nil && !graphActive]
    }

    private func emitState() { emit("micState", status().merging(["at": wallClock.nowMilliseconds()]) { _, newer in newer }, retained: true) }

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
            if kind == .began {
                let reason = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
                if reason == AVAudioSession.InterruptionReason.appWasSuspended.rawValue {
                    CaptureEngine.shared.appWasSuspended()
                } else { CaptureEngine.shared.interruptionBegan() }
            }
            else { CaptureEngine.shared.interruptionEnded() }
        }
        center.addObserver(forName: AVAudioApplication.inputMuteStateChangeNotification, object: nil, queue: .main) { _ in
            CaptureEngine.shared.inputMuteChanged(AVAudioApplication.shared.isInputMuted)
        }
        center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                  reason != .categoryChange else { return }
            CaptureEngine.shared.routeChanged()
        }
        center.addObserver(forName: Notification.Name("AVAudioEngineConfigurationChangeNotification"), object: nil, queue: .main) { note in
            CaptureEngine.shared.engineConfigurationChanged(note.object as? AVAudioEngine)
        }
        center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { _ in
            CaptureEngine.shared.mediaServicesReset()
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            CaptureEngine.shared.setAppActive(true)
        }
        center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            CaptureEngine.shared.setAppActive(false)
        }
    }
}
