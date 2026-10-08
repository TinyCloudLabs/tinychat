import Foundation

/// The ordered journal transitions shared by the live engine and deterministic fixture tests.
/// Frame checkpoints and segment creation are performed by the caller between these transitions.
public struct CaptureTransitionMachine {
    public private(set) var intent = "recording"
    public private(set) var availability = "available"
    public private(set) var openSpan: (kind: String, reason: String)?
    private var inputID: String?

    public init() {}

    public mutating func acquired(at t: Int64, audioMs a: Int64, generation: Int,
                                  input: (id: String, name: String, kind: String)?) -> [[String: Any]] {
        guard intent == "recording" else { return [] }
        var events: [[String: Any]] = []
        if let span = openSpan {
            events.append(["e": "span_close", "t": t, "a": a,
                           "kind": span.kind, "reason": span.reason])
            openSpan = nil
        }
        availability = "available"
        events.append(["e": "avail", "t": t, "a": a, "value": "available",
                       "reason": NSNull(), "gen": generation])
        if let input, input.id != inputID {
            inputID = input.id
            events.append(["e": "input", "t": t, "a": a,
                           "id": input.id, "name": input.name, "kind": input.kind])
        }
        return events
    }

    public mutating func interrupted(at t: Int64, audioMs a: Int64, generation: Int,
                                     reason: String) -> [[String: Any]] {
        guard intent == "recording" else { return [] }
        var events = openedSpan(at: t, audioMs: a, kind: "omitted",
            reason: reason == "call" ? "interruption" : reason)
        availability = "interrupted"
        events.append(["e": "avail", "t": t, "a": a, "value": "interrupted",
                       "reason": reason, "gen": generation])
        return events
    }

    public mutating func openedSpan(at t: Int64, audioMs a: Int64,
                                    kind: String, reason: String) -> [[String: Any]] {
        guard intent == "recording", openSpan == nil else { return [] }
        openSpan = (kind, reason)
        return [["e": "span_open", "t": t, "a": a, "kind": kind, "reason": reason]]
    }

    public mutating func closedSpan(at t: Int64, audioMs a: Int64) -> [[String: Any]] {
        guard let span = openSpan else { return [] }
        openSpan = nil
        return [["e": "span_close", "t": t, "a": a, "kind": span.kind, "reason": span.reason]]
    }

    public mutating func paused(at t: Int64, audioMs a: Int64, inputStopped: Bool) throws -> [[String: Any]] {
        guard inputStopped else { throw CaptureError.pauseFailed }
        guard intent == "recording" else { return [] }
        var events: [[String: Any]] = []
        if let span = openSpan {
            events.append(["e": "span_close", "t": t, "a": a,
                           "kind": span.kind, "reason": span.reason])
            openSpan = nil
        }
        intent = "paused"
        events.append(["e": "intent", "t": t, "a": a, "value": "paused", "by": "user"])
        return events
    }

    /// Stop input, drain and full-sync the segment, append the final pause transition, sync
    /// the journal, and only then release the input. Release failure is reported but resolves paused.
    public mutating func pause(input: CaptureInputControl, frames: CaptureFrameSink,
                               journal: CaptureJournalSink, clock: CaptureClock,
                               currentAudioMs: Int64,
                               onReleaseFailure: (Error) -> Void) throws -> (audioMs: Int64, at: Int64) {
        guard input.stopInput() else { throw CaptureError.pauseFailed }
        let closed = try frames.closeSegment()
        let a = closed?.audioMs ?? currentAudioMs
        let t = closed?.at ?? clock.nowMilliseconds()
        var next = self
        let events = try next.paused(at: t, audioMs: a, inputStopped: true)
        for (index, event) in events.enumerated() {
            try journal.append(event, fullSync: index == events.count - 1)
        }
        self = next
        do { try input.releaseInput() } catch { onReleaseFailure(error) }
        return (a, t)
    }

    public mutating func resumed(at t: Int64, audioMs a: Int64) -> [[String: Any]] {
        guard intent == "paused" else { return [] }
        intent = "recording"
        return [["e": "intent", "t": t, "a": a, "value": "recording", "by": "user"]]
    }

    public mutating func blocked(at t: Int64, audioMs a: Int64, generation: Int,
                                 reason: String = "resume_blocked") -> [[String: Any]] {
        guard intent == "recording" else { return [] }
        availability = "blocked"
        return [["e": "avail", "t": t, "a": a, "value": "blocked",
                 "reason": reason, "gen": generation]]
    }

    public mutating func stopped(at t: Int64, audioMs a: Int64,
                                 reason: String) -> [[String: Any]] {
        guard intent != "stopped" else { return [] }
        var events: [[String: Any]] = []
        if let span = openSpan {
            events.append(["e": "span_close", "t": t, "a": a,
                           "kind": span.kind, "reason": span.reason])
            openSpan = nil
        }
        intent = "stopped"
        let by = reason == "max_duration" ? "limit" : reason == "disk_full" ? "disk" : reason
        events.append(["e": "intent", "t": t, "a": a, "value": "stopped", "by": by])
        events.append(["e": "stop", "t": t, "a": a, "reason": reason])
        return events
    }
}

/// A start owns its generation; a notification owns a separate epoch. Backoff changes only
/// the former, so a notification remains useful until capture succeeds or the user cancels it.
public struct CaptureAttemptGate {
    public struct Ticket: Equatable {
        public let id: String
        public let generation: Int
        public init(id: String, generation: Int) { self.id = id; self.generation = generation }
    }
    public struct Notice: Equatable {
        public let id: String
        public let epoch: Int
        public init(id: String, epoch: Int) { self.id = id; self.epoch = epoch }
    }

    public private(set) var id: String?
    public private(set) var generation = 0
    public private(set) var epoch = 0
    public private(set) var intent = "stopped"
    public private(set) var availability = "available"

    public init() {}
    public mutating func startSession(_ id: String) -> Ticket {
        self.id = id; intent = "recording"; availability = "available"
        generation += 1
        return Ticket(id: id, generation: generation)
    }
    public mutating func attempt() -> Ticket? {
        guard let id, intent == "recording" else { return nil }
        generation += 1
        return Ticket(id: id, generation: generation)
    }
    public func mayAttach(_ ticket: Ticket) -> Bool {
        id == ticket.id && generation == ticket.generation && intent == "recording"
    }
    public mutating func interrupted() -> Notice? {
        guard let id, intent == "recording" else { return nil }
        generation += 1; availability = "interrupted"
        return Notice(id: id, epoch: epoch)
    }
    public mutating func blocked() { if intent == "recording" { availability = "blocked" } }
    public mutating func succeeded(_ ticket: Ticket) -> Bool {
        guard mayAttach(ticket) else { return false }
        availability = "available"; epoch += 1
        return true
    }
    public mutating func pause() {
        guard id != nil, intent == "recording" else { return }
        generation += 1; epoch += 1; intent = "paused"; availability = "available"
    }
    public mutating func resumePaused() -> Ticket? {
        guard let id, intent == "paused" else { return nil }
        generation += 1; intent = "recording"
        return Ticket(id: id, generation: generation)
    }
    public mutating func stop() {
        generation += 1; epoch += 1; intent = "stopped"; availability = "available"; id = nil
    }
    public func accepts(_ notice: Notice) -> Bool {
        id == notice.id && epoch == notice.epoch && intent == "recording" && availability != "available"
    }
}
