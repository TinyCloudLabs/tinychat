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
        var events = intent == "recording" ? openedSpan(at: t, audioMs: a, kind: "omitted",
            reason: reason == "call" ? "interruption" : reason) : []
        availability = "interrupted"
        events.append(["e": "avail", "t": t, "a": a, "value": "interrupted",
                       "reason": reason, "gen": generation])
        return events
    }

    public mutating func openedSpan(at t: Int64, audioMs a: Int64,
                                    kind: String, reason: String) -> [[String: Any]] {
        guard openSpan == nil else { return [] }
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
        intent = "recording"
        return [["e": "intent", "t": t, "a": a, "value": "recording", "by": "user"]]
    }

    public mutating func blocked(at t: Int64, audioMs a: Int64, generation: Int) -> [[String: Any]] {
        availability = "blocked"
        return [["e": "avail", "t": t, "a": a, "value": "blocked",
                 "reason": "resume_blocked", "gen": generation]]
    }

    public mutating func stopped(at t: Int64, audioMs a: Int64,
                                 reason: String) -> [[String: Any]] {
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
