import Foundation

public struct JournalRecovery {
    public let wallMs: Int64
    public let pausedMs: Int64
    public let lastHeartbeatAt: Int64?
    public let firstAudioAt: Int64?
    public let captureStoppedAt: Int64?
    public let endedUnexpectedly: Bool
    public let spans: [MissingAudioSpan]
    public let owner: String?
    public let input: [String: Any]?

    public init(events: [[String: Any]]) throws {
        guard let first = events.first, first["e"] as? String == "session",
              let startedAt = first["t"] as? Int64 else { throw CaptureError.io("missing session event") }
        let lastT = max(startedAt, events.last?["t"] as? Int64 ?? startedAt)
        wallMs = lastT - startedAt
        lastHeartbeatAt = events.last(where: { $0["e"] as? String == "hb" })?["t"] as? Int64
        firstAudioAt = events.first(where: { $0["e"] as? String == "first_audio" })?["t"] as? Int64
        captureStoppedAt = events.last(where: { $0["e"] as? String == "capture_stopped" })?["t"] as? Int64
        endedUnexpectedly = !events.contains { $0["e"] as? String == "stop" }
        owner = events.last(where: { $0["e"] as? String == "owner" })?["did"] as? String
            ?? first["owner"] as? String
        input = events.last(where: { $0["e"] as? String == "input" }).map {
            ["id": $0["id"] ?? "", "name": $0["name"] ?? "", "kind": $0["kind"] ?? "other"]
        }
        var pauseStart: Int64?
        var paused: Int64 = 0
        var completed: [MissingAudioSpan] = []
        var open: MissingAudioSpan?
        for event in events {
            guard let type = event["e"] as? String, let t = event["t"] as? Int64 else { continue }
            let a = event["a"] as? Int64 ?? 0
            switch type {
            case "intent":
                let value = event["value"] as? String
                if value == "paused" { pauseStart = t }
                else if let since = pauseStart, value == "recording" || value == "stopped" {
                    paused += max(0, t - since); pauseStart = nil
                }
            case "span_open":
                if let kind = event["kind"] as? String, let reason = event["reason"] as? String {
                    open = MissingAudioSpan(kind: kind, reason: reason, startedAt: t, atAudioMs: a)
                }
            case "span_close":
                if var span = open {
                    span.endedAt = t
                    span.audioMs = span.kind == "silenced" ? max(0, a - span.atAudioMs) : 0
                    completed.append(span); open = nil
                }
            default: break
            }
        }
        if let since = pauseStart { paused += max(0, lastT - since) }
        pausedMs = min(wallMs, paused)
        if var span = open {
            span.endedAt = lastT
            span.audioMs = span.kind == "silenced"
                ? max(0, (events.last?["a"] as? Int64 ?? span.atAudioMs) - span.atAudioMs) : 0
            completed.append(span)
        }
        spans = completed
    }
}
