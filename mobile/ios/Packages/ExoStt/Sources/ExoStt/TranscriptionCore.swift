import Foundation

/// The note store the queue reads and writes: the committed-note inventory, each note's sidecar
/// (`stt` block) and its transcript. `RecordingLibrary` on iOS; a fake in tests.
protocol TranscriptionLibrary: AnyObject {
    func listCommitted() throws -> [[String: Any]]
    func transcript(_ id: String) throws -> [String: Any]?
    func readSidecar(_ id: String) throws -> [String: Any]
    func updateStt(_ id: String, patch: [String: Any]) throws
    func putTranscript(_ id: String, object: [String: Any]) throws
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

enum TranscriptionQueueError: Error {
    case captureStarted
    case cancelled
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
    private let captureGate = CapturePauseGate()
    /// Orders the sidecar writes that are conditional on a note's queue state against every change to
    /// that state. A conditional write (`writeIfPending`) checks its precondition and writes while
    /// holding it; every transition that takes a note out of that state (`transition`) takes it too, so
    /// a transition either happens before the check (the write is skipped) or waits for the write to
    /// land (the transition's own, newer write follows). A conditional write can therefore never
    /// replace a newer state: running, done, failed or cancelled. Lock order: this, then the state's
    /// lock. Never taken by snapshot or any other main-thread read, only by the control and worker queues.
    private let transitionLock = NSLock()
    var onQueueChanged: (() -> Void)?
    var onProgress: ((String, Int) -> Void)?
    var onTranscribed: ((String, String) -> Void)?
    var onFailed: ((String, String, String) -> Void)?

    init(library: TranscriptionLibrary, backend: TranscriptionBackend, label: String = "xyz.tinycloud.exo.stt") {
        self.library = library
        self.backend = backend
        workQueue = DispatchQueue(label: "\(label).queue", qos: .utility)
        controlQueue = DispatchQueue(label: "\(label).control")
    }

    func reconcile() {
        controlQueue.async { [self] in
            let scanStartedAt = state.scanStarted()
            guard let notes = try? library.listCommitted() else { return }
            for note in notes {
                guard let id = note["id"] as? String,
                      let options = note["options"] as? [String: Any],
                      options["transcriber"] as? String == "on-device",
                      let stt = note["stt"] as? [String: Any],
                      let sttState = stt["state"] as? String,
                      ["waiting_for_model", "queued", "running"].contains(sttState) else { continue }
                if (try? library.transcript(id)) != nil { continue }
                state.addScanned(id, scanStartedAt: scanStartedAt)
            }
            kickWorker()
        }
    }

    func enqueue(id: String, accepted: ((Bool) -> Void)? = nil) {
        controlQueue.async { [self] in
            // Reserve first: a note that is already pending or decoding keeps its own sidecar. The
            // transcript is read after the reservation, so a note finishing meanwhile is seen.
            guard state.reserve(id) else { accepted?(true); return }
            guard (try? library.transcript(id)) == nil else { // already has one
                state.releaseReserved(id)
                accepted?(false)
                return
            }
            try? library.updateStt(id, patch: ["state": "queued", "error": NSNull(), "attempts": 0])
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
    private func pump() {
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
        CaptureYieldingLoop.run(
            hasNext: { state.hasPending },
            next: { transition { state.takeNext() } },
            isPaused: { captureGate.isActive() }
        ) { next in
            guard let id = next else { return } // cancelled between hasNext and next
            defer { state.finishCurrent() }
            if (try? library.transcript(id)) != nil { return } // finished while it was being re-queued
            let previousAttempts = ((try? library.readSidecar(id))?["stt"] as? [String: Any])?["attempts"] as? Int ?? 0
            switch AttemptGuard.next(previousAttempts: previousAttempts) {
            case .giveUp:
                fail(id, code: "too_many_attempts", message: "gave up after \(AttemptGuard.maxAttempts) attempts") { state.finishCurrent() }
                return
            case .proceed(let attempt):
                // Persisted before the risky decode starts: a crash mid-attempt still counts
                // against the cap next launch, instead of retrying the same note forever.
                var patch = session.runPatch
                patch["state"] = "running"
                patch["attempts"] = attempt
                try? library.updateStt(id, patch: patch)
            }
            onQueueChanged?()
            do {
                try process(id: id, session: session)
            } catch TranscriptionQueueError.captureStarted {
                // Not a failed attempt: an orderly yield to a resumed recording. Restore the
                // attempt count so being interrupted repeatedly never burns the crash-loop budget.
                try? library.updateStt(id, patch: ["state": "queued", "attempts": previousAttempts])
                if state.yieldCurrent() == .cancelled {
                    // A cancel accepted during the rollback wins: the note must not run again. It stays
                    // owned by this worker until `cancelled` is durable, so no scan can re-add it meanwhile.
                    try? library.updateStt(id, patch: ["state": "cancelled", "attempts": previousAttempts])
                    state.finishCurrent()
                    onQueueChanged?()
                }
            } catch TranscriptionQueueError.cancelled {
                try? library.updateStt(id, patch: ["state": "cancelled", "attempts": previousAttempts])
                state.finishCurrent()
                onQueueChanged?()
            } catch {
                fail(id, code: "decode_failed", message: String(describing: error)) { state.finishCurrent() }
            }
        }
        if state.hasPending { workQueue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.pump() } }
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
        return current.map { ["waiting_for_model", "queued", "running"].contains($0) } ?? false
    }

    /// Records a final `failed` state; `release` then hands the note back, before anyone is told.
    private func fail(_ id: String, code: String, message: String, release: () -> Void) {
        try? library.updateStt(id, patch: ["state": "failed", "error": code])
        release()
        NSLog("ExoStt transcription failed id=%@ code=%@ message=%@", id, code, message)
        onFailed?(id, code, message)
        onQueueChanged?()
    }

    private func process(id: String, session: TranscriptionSession) throws {
        let transcript = try session.transcribe(
            id: id,
            checkCapturing: { [self] in
                if state.isCancelRequested(id) { throw TranscriptionQueueError.cancelled }
                guard !captureGate.isActive() else { throw TranscriptionQueueError.captureStarted }
            },
            onProgress: { [self] percent, windowsDone in
                try? library.updateStt(id, patch: ["windowsDone": windowsDone])
                state.setProgress(percent)
                onProgress?(id, percent)
            },
            onSegment: { [self] segmentsDone in
                try? library.updateStt(id, patch: ["segmentsDone": segmentsDone])
            })
        // The decode's last stretch (final recognition, VAD flush) has no checkpoint: a cancel
        // accepted during it is honoured here, and a cancel after this point is too late.
        guard state.beginCommit() else { throw TranscriptionQueueError.cancelled }
        try library.putTranscript(id, object: transcript)
        try library.updateStt(id, patch: ["state": "done", "error": NSNull()])
        onProgress?(id, 100)
        onTranscribed?(id, transcript["outcome"] as? String ?? "")
        onQueueChanged?()
    }
}
