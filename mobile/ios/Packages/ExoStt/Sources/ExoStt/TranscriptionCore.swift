import Foundation

/// The note store the queue reads and writes: the committed-note inventory, each note's sidecar
/// (`stt` block) and its transcript. `RecordingLibrary` on iOS; a fake in tests.
protocol TranscriptionLibrary: AnyObject {
    func listCommitted() throws -> [[String: Any]]
    func transcript(_ id: String) throws -> [String: Any]?
    func readSidecar(_ id: String) throws -> [String: Any]
    func updateStt(_ id: String, patch: [String: Any]) throws
    func updateRunning(_ id: String, generation: Int, patch: [String: Any],
                       stillValid: () -> Bool) throws
    /// The storage implementation serializes these with deletion and all sidecar writes.
    func yieldToOS(_ id: String, generation: Int, attempts: Int, stillValid: () -> Bool) throws -> Bool
    func commitTranscript(_ id: String, generation: Int, object: [String: Any],
                          stillValid: () -> Bool) throws -> Bool
}

/// Where the models come from. `makeSession` returns nil while they are not usable.
protocol TranscriptionBackend: AnyObject {
    var isChecking: Bool { get }
    func makeSession() throws -> TranscriptionSession?
}

/// One loaded recognizer, scoped to a single `pump()` pass.
protocol TranscriptionSession {
    /// Written to a note's sidecar when an attempt starts (which model pack ran it).
    var runPatch: [String: Any] { get }
    /// Decodes the note and returns its transcript object. `checkCapturing` is called at every
    /// checkpoint and throws to stop the decode; `onProgress(percent, windowsDone)` when the percent
    /// moves; `onSegment(segmentsDone)` after each recognized speech segment.
    func transcribe(id: String, checkCapturing: @escaping () throws -> Void,
                    onProgress: @escaping (Int, Int) -> Void,
                    onSegment: @escaping (Int) -> Void) throws -> [String: Any]
}

/// A finite iOS background assertion. `false` means acquisition was denied and must never be ended.
protocol TranscriptionActivity: AnyObject {
    func begin(expired: @escaping () -> Void) -> Bool
    func end()
}

private final class NoTranscriptionActivity: TranscriptionActivity {
    func begin(expired: @escaping () -> Void) -> Bool { false }
    func end() {}
}

/// Shared between OS expiry and checkpoint-free finalization. Once expiry owns the assertion,
/// the worker cannot release it before the bounded storage attempt finishes.
private final class DecodeLease {
    private let lock = NSLock()
    private var stopped = false
    private var ended = false
    private var acquired = false
    private var pendingExpiry = false

    /// Returns true if expiration arrived synchronously before acquisition completed.
    func acquired(_ value: Bool) -> Bool {
        lock.withLock {
            acquired = value
            return value && pendingExpiry
        }
    }

    func stop() -> Bool {
        lock.withLock {
            guard !ended, !stopped else { return false }
            if !acquired {
                pendingExpiry = true
                return false
            }
            stopped = true
            return true
        }
    }

    var isStopped: Bool { lock.withLock { stopped } }

    func end(_ activity: TranscriptionActivity, fromExpiry: Bool = false) {
        let shouldEnd = lock.withLock { () -> Bool in
            guard !ended, !stopped || fromExpiry else { return false }
            ended = true
            return acquired
        }
        if shouldEnd { activity.end() }
    }
}

/// Whether a note's sidecar says on-device transcription is owed. A note committed to on-device always
/// is; a note committed to another mode is too once the user chose Local for it, which `enqueue`
/// records as `stt.requested` so the choice survives the app dying.
enum ResumableWork {
    static let unfinished = ["waiting_for_model", "queued", "running", "yielded_by_os"]

    static func owed(_ note: [String: Any]) -> Bool {
        guard let stt = note["stt"] as? [String: Any], (stt["rerunRev"] as? Int) == nil,
              let state = stt["state"] as? String, unfinished.contains(state) else { return false }
        let committed = (note["options"] as? [String: Any])?["transcriber"] as? String
        return committed == "on-device" || stt["requested"] as? Bool == true
    }

    /// What an ordinary explicit enqueue writes: a fresh attempt and a resumable Local choice.
    static let requested: [String: Any] = ["state": "queued", "error": NSNull(), "attempts": 0, "requested": true,
        "yieldGeneration": 0, "rerunRev": NSNull(), "rerunBaseRev": NSNull(), "rerunBaseHash": NSNull()]

    static func rerun(rev: Int, baseRev: Int, baseHash: String) -> [String: Any] {
        ["state": "queued", "error": NSNull(), "attempts": 0, "requested": false,
         "yieldGeneration": 0, "rerunRev": rev, "rerunBaseRev": baseRev, "rerunBaseHash": baseHash]
    }
}

enum TranscriptionQueueError: Error {
    case captureStarted
    case cancelled
    case yieldedByOS
    case modelFilesMissing
    case decodeFailed
}

/// The queue's orchestration, free of any platform or model dependency so its races can be tested:
/// a serial `workQueue` that decodes one note at a time and a separate `controlQueue` for
/// reconcile/enqueue/cancel, tied together by the atomic transitions in `TranscriptionState`.
/// Nothing ever waits on `workQueue`, so a decode can never stall the main thread or the bridge.
final class TranscriptionCore {
    let state = TranscriptionState()
    /// Runs the model load and the decode loop (the only long work); nothing ever `sync`s onto it.
    let workQueue: DispatchQueue
    /// Short bookkeeping (reconcile scan, enqueue, cancel): never queued behind a decode, so a
    /// cancel or a freshly committed note is seen by the running pass right away.
    let controlQueue: DispatchQueue
    private let library: TranscriptionLibrary
    private let backend: TranscriptionBackend
    private let makeActivity: () -> TranscriptionActivity
    private let clock: () -> Date
    private let expiryBudget: TimeInterval
    private let captureGate = CapturePauseGate()
    /// Orders the sidecar writes that are conditional on a note's queue state against every change to
    /// that state. A conditional write (`writeIfPending`) checks its precondition and writes while
    /// holding it; every transition that takes a note out of that state (`transition`) takes it too, so
    /// a transition either happens before the check (the write is skipped) or waits for the write to
    /// land (the transition's own, newer write follows). A conditional write can therefore never
    /// replace a newer state: running, done, failed or cancelled. Lock order: this, then the state's
    /// lock. Never taken by snapshot or any other main-thread read, only by the control and worker queues.
    private let transitionLock = NSLock()
    private let opportunityLock = NSLock()
    private var waitingForOpportunity = false
    var onQueueChanged: (() -> Void)?
    var onProgress: ((String, Int) -> Void)?
    var onTranscribed: ((String, String) -> Void)?
    var onFailed: ((String, String, String) -> Void)?

    init(library: TranscriptionLibrary, backend: TranscriptionBackend,
         activity: @escaping () -> TranscriptionActivity = { NoTranscriptionActivity() },
         clock: @escaping () -> Date = Date.init, expiryBudget: TimeInterval = 1,
         label: String = "xyz.tinycloud.exo.stt") {
        self.library = library
        self.backend = backend
        self.makeActivity = activity
        self.clock = clock
        self.expiryBudget = expiryBudget
        workQueue = DispatchQueue(label: "\(label).queue", qos: .utility)
        controlQueue = DispatchQueue(label: "\(label).control")
    }

    func reconcile() {
        controlQueue.async { [self] in
            opportunityLock.withLock { waitingForOpportunity = false }
            let scanStartedAt = state.scanStarted()
            guard let notes = try? library.listCommitted() else { return }
            for note in notes {
                guard let id = note["id"] as? String, ResumableWork.owed(note) else { continue }
                if (try? library.transcript(id)) != nil { continue }
                state.addScanned(id, scanStartedAt: scanStartedAt)
            }
            kickWorker()
        }
    }

    /// Cancels reruns interrupted by process death. Called only once from app launch; reruns are
    /// deliberately not reconciled into the queue.
    func recoverInterruptedReruns() {
        controlQueue.async { [self] in
            guard let notes = try? library.listCommitted() else { return }
            for note in notes {
                guard let id = note["id"] as? String,
                      let stt = note["stt"] as? [String: Any],
                      stt["rerunRev"] as? Int != nil,
                      let status = stt["state"] as? String,
                      ResumableWork.unfinished.contains(status) else { continue }
                try? library.updateStt(id, patch: ["state": "cancelled", "rerunRev": NSNull(),
                    "rerunBaseRev": NSNull(), "rerunBaseHash": NSNull()])
            }
        }
    }

    func enqueue(id: String, accepted: ((Bool) -> Void)? = nil, failed: ((Error) -> Void)? = nil) {
        enqueue(id: id, rerunRev: nil, baseRev: nil, baseHash: nil, accepted: accepted, failed: failed)
    }

    func enqueueAgain(id: String, rev: Int, baseRev: Int, baseHash: String,
                      accepted: ((Bool) -> Void)? = nil, failed: ((Error) -> Void)? = nil) {
        guard rev > 0, baseRev > 0, !baseHash.isEmpty else { failed?(TranscriptionQueueError.decodeFailed); return }
        enqueue(id: id, rerunRev: rev, baseRev: baseRev, baseHash: baseHash, accepted: accepted, failed: failed)
    }

    private func enqueue(id: String, rerunRev: Int?, baseRev: Int?, baseHash: String?,
                         accepted: ((Bool) -> Void)?, failed: ((Error) -> Void)?) {
        controlQueue.async { [self] in
            guard state.reserve(id) else { accepted?(true); return }
            if rerunRev == nil, (try? library.transcript(id)) != nil {
                state.releaseReserved(id)
                accepted?(false)
                return
            }
            do {
                let patch: [String: Any]
                if let rev = rerunRev, let baseRev = baseRev, let baseHash = baseHash {
                    patch = ResumableWork.rerun(rev: rev, baseRev: baseRev, baseHash: baseHash)
                } else {
                    patch = ResumableWork.requested
                }
                try library.updateStt(id, patch: patch)
            } catch {
                state.releaseReserved(id)
                failed?(error)
                return
            }
            state.publishReserved(id)
            onQueueChanged?()
            accepted?(true)
            kickWorker()
        }
    }

    func cancel(id: String) {
        controlQueue.async { [self] in
            switch transition({ state.cancel(id) }) {
            case .removedPending:
                try? library.updateStt(id, patch: ["state": "cancelled"])
            case .notFound:
                // Only a note nobody is working on that is still unfinished (interrupted) is cancelled;
                // a note that already reached done, failed or cancelled keeps that state.
                if (try? library.transcript(id)) == nil, isUnfinished(id) {
                    try? library.updateStt(id, patch: ["state": "cancelled"])
                }
            case .flaggedRunning, .tooLate, .owned:
                break // The worker (or admitter) records the outcome itself.
            }
            onQueueChanged?()
        }
    }

    func queueSnapshot() -> [[String: Any]] {
        state.snapshot()
    }

    func captureStarted() {
        captureGate.captureStarted()
    }

    func captureEnded() {
        captureGate.captureEnded()
        kickWorker()
    }

    func initialCheckFinished() {
        onQueueChanged?()
        kickWorker()
    }

    func kickWorker() {
        workQueue.async { [self] in pump() }
    }

    /// Runs on `workQueue` only, so there is never more than one decode at a time.
    private func pauseUntilReconcile() {
        opportunityLock.withLock { waitingForOpportunity = true }
    }

    private func pump() {
        guard !opportunityLock.withLock({ waitingForOpportunity }) else { return }
        guard state.hasPending else { return }
        guard !captureGate.isActive() else { return } // Resumed by `captureEnded()`.
        guard !backend.isChecking else { return } // Resumed by the store's `onInitialCheckFinished`.
        let session: TranscriptionSession?
        do {
            session = try backend.makeSession()
        } catch {
            for id in transition({ state.removeAllPending() }) {
                fail(id, code: "model_load_failed", message: String(describing: error)) { state.finishRemoved(id) }
            }
            onQueueChanged?()
            return
        }
        guard let session else {
            transition { state.markAllPending(state: "waiting_for_model") }
            publishWaitingState(state.pendingIds)
            onQueueChanged?()
            return
        }
        transition { state.markAllPending(state: "queued") }
        var expiredThisPass = false
        CaptureYieldingLoop.run(
            hasNext: { state.hasPending },
            next: { transition { state.takeNext() } },
            isPaused: { captureGate.isActive() || expiredThisPass }
        ) { next in
            guard let id = next else { return }
            defer { state.finishCurrent() }
            guard let sidecar = try? library.readSidecar(id),
                  let sidecarStt = sidecar["stt"] as? [String: Any] else { return }
            if (try? library.transcript(id)) != nil, sidecarStt["rerunRev"] as? Int == nil { return }
            let previousAttempts = sidecarStt["attempts"] as? Int ?? 0
            let generation = (sidecarStt["yieldGeneration"] as? Int ?? 0) + 1
            switch AttemptGuard.next(previousAttempts: previousAttempts) {
            case .giveUp:
                fail(id, code: "too_many_attempts", message: "gave up after \(AttemptGuard.maxAttempts) attempts") { state.finishCurrent() }
                return
            case .proceed(let attempt):
                // A crash mid-decode counts only after this write is durable.
                var patch = session.runPatch
                patch["state"] = "running"
                patch["attempts"] = attempt
                patch["yieldGeneration"] = generation
                do { try library.updateStt(id, patch: patch) }
                catch { return }
            }
            onQueueChanged?()
            let lease = DecodeLease()
            let activity = makeActivity()
            let eligible = (sidecar["durationMs"] as? Int).map { $0 > 0 && $0 <= 30_000 } ?? false
            if eligible {
                let expiredDuringAcquisition = lease.acquired(activity.begin { [self, lease, weak activity] in
                    guard let activity else { return }
                    expire(id: id, generation: generation, previousAttempts: previousAttempts,
                           lease: lease, activity: activity)
                })
                if expiredDuringAcquisition {
                    expire(id: id, generation: generation, previousAttempts: previousAttempts,
                           lease: lease, activity: activity)
                }
            }
            defer { lease.end(activity) }
            do {
                try process(id: id, generation: generation, session: session, lease: lease)
            } catch TranscriptionQueueError.yieldedByOS {
                expiredThisPass = true
                pauseUntilReconcile()
                onQueueChanged?()
            } catch TranscriptionQueueError.captureStarted {
                // Capture remains higher priority; an orderly yield does not consume an attempt.
                try? library.updateStt(id, patch: ["state": "queued", "attempts": previousAttempts])
                if state.yieldCurrent() == .cancelled {
                    try? library.updateStt(id, patch: ["state": "cancelled", "attempts": previousAttempts])
                    state.finishCurrent()
                    onQueueChanged?()
                }
            } catch TranscriptionQueueError.cancelled {
                try? library.updateStt(id, patch: ["state": "cancelled", "attempts": previousAttempts])
                state.finishCurrent()
                onQueueChanged?()
            } catch {
                if lease.isStopped {
                    expiredThisPass = true // Failed persistence is a crash attempt, not an orderly yield.
                    pauseUntilReconcile()
                } else {
                    fail(id, code: "decode_failed", message: String(describing: error)) { state.finishCurrent() }
                }
            }
        }
        if !expiredThisPass && state.hasPending {
            workQueue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.pump() }
        }
    }

    /// Writes the pending notes' `waiting_for_model` state on the control queue, where it is ordered
    /// with cancel and enqueue: a note cancelled (or taken for decoding) in the meantime is skipped
    /// instead of having its newer state overwritten.
    private func publishWaitingState(_ ids: [String]) {
        controlQueue.async { [self] in
            for id in ids { writeIfPending(id, state: "waiting_for_model") }
        }
    }

    /// Runs a change to a note's queue state, ordered against in-flight conditional writes.
    private func transition<T>(_ body: () -> T) -> T {
        transitionLock.lock(); defer { transitionLock.unlock() }
        return body()
    }

    /// Writes `state` to the note's sidecar only if the note is still pending in that same state.
    private func writeIfPending(_ id: String, state newState: String) {
        transitionLock.lock(); defer { transitionLock.unlock() }
        guard state.isPending(id, state: newState) else { return }
        try? library.updateStt(id, patch: ["state": newState])
    }

    private func isUnfinished(_ id: String) -> Bool {
        let current = ((try? library.readSidecar(id))?["stt"] as? [String: Any])?["state"] as? String
        return current.map { ResumableWork.unfinished.contains($0) } ?? false
    }

    /// Records a final `failed` state; `release` then hands the note back, before anyone is told.
    private func fail(_ id: String, code: String, message: String, release: () -> Void) {
        try? library.updateStt(id, patch: ["state": "failed", "error": code])
        release()
        NSLog("ExoStt transcription failed id=%@ code=%@ message=%@", id, code, message)
        onFailed?(id, code, message)
        onQueueChanged?()
    }

    /// Expiration is delivered on the main thread, including during checkpoint-free recognition.
    /// Bounded persistence runs separately; a failed or timed-out yield retains its crash attempt.
    private func expire(id: String, generation: Int, previousAttempts: Int,
                        lease: DecodeLease, activity: TranscriptionActivity) {
        guard lease.stop() else { return }
        let deadline = clock().addingTimeInterval(expiryBudget)
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            defer { finished.signal() }
            guard !state.isCancelRequested(id) else { return }
            do {
                _ = try library.yieldToOS(id, generation: generation, attempts: previousAttempts) {
                    clock() < deadline && !state.isCancelRequested(id)
                }
            } catch {
                NSLog("ExoStt expiry yield persistence failed id=%@", id)
            }
        }
        _ = finished.wait(timeout: .now() + expiryBudget)
        lease.end(activity, fromExpiry: true)
    }

    private func process(id: String, generation: Int, session: TranscriptionSession,
                         lease: DecodeLease) throws {
        var transcript = try session.transcribe(
            id: id,
            checkCapturing: { [self] in
                if state.isCancelRequested(id) { throw TranscriptionQueueError.cancelled }
                if lease.isStopped { throw TranscriptionQueueError.yieldedByOS }
                guard !captureGate.isActive() else { throw TranscriptionQueueError.captureStarted }
            },
            onProgress: { [self] percent, windowsDone in
                try? library.updateRunning(id, generation: generation, patch: ["windowsDone": windowsDone]) {
                    !lease.isStopped && !state.isCancelRequested(id)
                }
                guard !lease.isStopped else { return }
                state.setProgress(percent)
                onProgress?(id, percent)
            },
            onSegment: { [self] segmentsDone in
                try? library.updateRunning(id, generation: generation, patch: ["segmentsDone": segmentsDone]) {
                    !lease.isStopped && !state.isCancelRequested(id)
                }
            })
        // An explicit rerun's revision and base are stored in the non-resumable queue marker before work starts.
        let rerun = (try? library.readSidecar(id))?["stt"] as? [String: Any]
        transcript["rev"] = (rerun?["rerunRev"] as? Int) ?? 1
        if let baseRev = rerun?["rerunBaseRev"] as? Int,
           let baseHash = rerun?["rerunBaseHash"] as? String {
            transcript["rerunBase"] = ["rev": baseRev, "hash": baseHash]
        }
        // The generation check and durable commit share the library's serial transaction with expiry.
        if state.isCancelRequested(id) { throw TranscriptionQueueError.cancelled }
        if lease.isStopped { throw TranscriptionQueueError.yieldedByOS }
        guard state.beginCommit() else { throw TranscriptionQueueError.cancelled }
        guard try library.commitTranscript(id, generation: generation, object: transcript,
                                           stillValid: { !lease.isStopped }) else {
            throw TranscriptionQueueError.yieldedByOS
        }
        onProgress?(id, 100)
        onTranscribed?(id, transcript["outcome"] as? String ?? "")
        onQueueChanged?()
    }
}
