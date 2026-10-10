import Foundation

/// The transcription queue's observable state: what is pending, which note is decoding right now and
/// how far along it is. Guarded by one short-held lock and deliberately free of any I/O or decode
/// work, so the snapshot the UI polls (`OnDeviceStt.status()`, every status/progress notification on
/// the main thread) and enqueue/cancel answer immediately while a note is mid-decode. The decode
/// itself runs on the queue's worker, outside this lock.
final class TranscriptionState {
    enum CancelOutcome: Equatable {
        case removedPending
        case flaggedRunning
        case notFound
    }

    private struct PendingNote {
        let id: String
        var state: String
    }

    private let lock = NSLock()
    private var pending: [PendingNote] = []
    private var current: (id: String, percent: Int)?
    private var cancelRequestedFor: String?

    var hasPending: Bool {
        lock.lock(); defer { lock.unlock() }
        return !pending.isEmpty
    }

    var pendingIds: [String] {
        lock.lock(); defer { lock.unlock() }
        return pending.map(\.id)
    }

    /// Adds `id` unless it is already pending or is the note decoding right now.
    @discardableResult
    func add(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard current?.id != id, !pending.contains(where: { $0.id == id }) else { return false }
        pending.append(PendingNote(id: id, state: "queued"))
        return true
    }

    /// Moves the head of the queue into the running slot (progress 0) and returns its id.
    func takeNext() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard !pending.isEmpty else { return nil }
        let note = pending.removeFirst()
        current = (note.id, 0)
        cancelRequestedFor = nil
        return note.id
    }

    /// Puts the running note back at the head of the queue (an orderly yield to capture).
    func requeueCurrentFirst() {
        lock.lock(); defer { lock.unlock() }
        if let running = current { pending.insert(PendingNote(id: running.id, state: "queued"), at: 0) }
        current = nil
        cancelRequestedFor = nil
    }

    func finishCurrent() {
        lock.lock(); defer { lock.unlock() }
        current = nil
        cancelRequestedFor = nil
    }

    func markAllPending(state: String) {
        lock.lock(); defer { lock.unlock() }
        for index in pending.indices { pending[index].state = state }
    }

    /// Empties the queue and returns the ids that were in it.
    func removeAllPending() -> [String] {
        lock.lock(); defer { lock.unlock() }
        let ids = pending.map(\.id)
        pending.removeAll()
        return ids
    }

    /// Drops a pending note, or asks the running decode to stop at its next window.
    func cancel(_ id: String) -> CancelOutcome {
        lock.lock(); defer { lock.unlock() }
        if let index = pending.firstIndex(where: { $0.id == id }) {
            pending.remove(at: index)
            return .removedPending
        }
        if current?.id == id {
            cancelRequestedFor = id
            return .flaggedRunning
        }
        return .notFound
    }

    func isCancelRequested(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelRequestedFor == id
    }

    func setProgress(_ percent: Int) {
        lock.lock(); defer { lock.unlock() }
        if let running = current { current = (running.id, percent) }
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
