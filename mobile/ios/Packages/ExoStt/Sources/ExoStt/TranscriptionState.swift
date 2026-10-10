import Foundation

/// The transcription queue's observable state: what is pending, which note is decoding right now and
/// how far along it is. Guarded by one short-held lock and deliberately free of any I/O or decode
/// work, so the snapshot the UI polls (`OnDeviceStt.status()`, every status/progress notification on
/// the main thread) and enqueue/cancel answer immediately while a note is mid-decode. The decode
/// itself runs on the queue's worker, outside this lock.
///
/// Every transition that decides a note's fate is one atomic step under the lock, so the control
/// queue (cancel, enqueue, reconcile) and the worker can race freely and still agree on one winner:
/// - cancel vs. publishing the transcript (`beginCommit`),
/// - cancel vs. yielding to capture (`yieldCurrent`),
/// - an explicit enqueue vs. the worker reserving the note (`reserve` … `publishReserved`),
/// - a reconcile scan vs. the worker finishing a note the scan saw as unfinished (`addScanned`).
/// While a note is current, the worker owns its sidecar; the control queue never writes it.
final class TranscriptionState {
    enum CancelOutcome: Equatable {
        case removedPending
        case flaggedRunning
        /// The transcript is already being published: the note will finish as `done`.
        case tooLate
        case notFound
    }

    enum YieldOutcome: Equatable {
        case requeued
        case cancelled
    }

    private struct PendingNote {
        let id: String
        var state: String
    }

    private struct Running {
        let id: String
        var percent = 0
        var committing = false
        var cancelRequested = false
    }

    private let lock = NSLock()
    private var pending: [PendingNote] = []
    private var current: Running?
    /// Explicit enqueues whose sidecar is being initialised; invisible to the worker until published.
    private var reserved: Set<String> = []
    private var sequence: UInt64 = 0
    private var finishedAt: [String: UInt64] = [:]

    var hasPending: Bool {
        lock.lock(); defer { lock.unlock() }
        return !pending.isEmpty
    }

    var pendingIds: [String] {
        lock.lock(); defer { lock.unlock() }
        return pending.map(\.id)
    }

    /// Marks the start of a reconcile scan; pass it to `addScanned`.
    func scanStarted() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        return sequence
    }

    /// Adds a note a reconcile scan found unfinished, unless it is already known or reached a final
    /// state (done, cancelled, failed) after the scan began: the scan's read of it is stale then.
    @discardableResult
    func addScanned(_ id: String, scanStartedAt: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !isKnown(id), (finishedAt[id] ?? 0) <= scanStartedAt else { return false }
        pending.append(PendingNote(id: id, state: "queued"))
        return true
    }

    /// First step of an explicit enqueue: claims `id` unless it is pending, decoding or already being
    /// enqueued, so a duplicate is a no-op and cannot touch the sidecar of a note it does not own.
    /// Every `true` must be followed by `publishReserved` or `releaseReserved`.
    func reserve(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !isKnown(id) else { return false }
        reserved.insert(id)
        return true
    }

    /// Makes a reserved note visible to the worker (its sidecar is initialised by now).
    func publishReserved(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        guard reserved.remove(id) != nil else { return }
        pending.append(PendingNote(id: id, state: "queued"))
    }

    func releaseReserved(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        reserved.remove(id)
    }

    private func isKnown(_ id: String) -> Bool {
        current?.id == id || reserved.contains(id) || pending.contains(where: { $0.id == id })
    }

    /// Moves the head of the queue into the running slot (progress 0) and returns its id.
    func takeNext() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard !pending.isEmpty else { return nil }
        let note = pending.removeFirst()
        current = Running(id: note.id)
        return note.id
    }

    /// The running note is done decoding: either publishes its transcript (`true`; a cancel arriving
    /// now is too late) or a cancel got there first (`false`; nothing may be published).
    func beginCommit() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard var running = current, !running.cancelRequested else { return false }
        running.committing = true
        current = running
        return true
    }

    /// Ends an orderly yield to capture: puts the running note back at the head of the queue, unless a
    /// cancel was accepted meanwhile, in which case the note is finished and the caller records it.
    func yieldCurrent() -> YieldOutcome {
        lock.lock(); defer { lock.unlock() }
        guard let running = current else { return .requeued }
        current = nil
        if running.cancelRequested {
            markFinished(running.id)
            return .cancelled
        }
        pending.insert(PendingNote(id: running.id, state: "queued"), at: 0)
        return .requeued
    }

    func finishCurrent() {
        lock.lock(); defer { lock.unlock() }
        guard let running = current else { return }
        current = nil
        markFinished(running.id)
    }

    private func markFinished(_ id: String) {
        sequence += 1
        finishedAt[id] = sequence
    }

    func markAllPending(state: String) {
        lock.lock(); defer { lock.unlock() }
        for index in pending.indices { pending[index].state = state }
    }

    /// Empties the queue and returns the ids that were in it (they are all given a final state).
    func removeAllPending() -> [String] {
        lock.lock(); defer { lock.unlock() }
        let ids = pending.map(\.id)
        pending.removeAll()
        for id in ids { markFinished(id) }
        return ids
    }

    /// Drops a pending note, or asks the running decode to stop at its next checkpoint.
    func cancel(_ id: String) -> CancelOutcome {
        lock.lock(); defer { lock.unlock() }
        if let index = pending.firstIndex(where: { $0.id == id }) {
            pending.remove(at: index)
            return .removedPending
        }
        if var running = current, running.id == id {
            if running.committing { return .tooLate }
            running.cancelRequested = true
            current = running
            return .flaggedRunning
        }
        return .notFound
    }

    func isCancelRequested(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return current?.id == id && current?.cancelRequested == true
    }

    func setProgress(_ percent: Int) {
        lock.lock(); defer { lock.unlock() }
        current?.percent = percent
    }

    /// The running note first (state `running`, last reported percent), then the pending ones in order.
    func snapshot() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        var entries: [[String: Any]] = []
        if let running = current {
            entries.append(["id": running.id, "state": "running", "percent": running.percent, "error": NSNull()])
        }
        for note in pending {
            entries.append(["id": note.id, "state": note.state, "percent": NSNull(), "error": NSNull()])
        }
        return entries
    }
}
