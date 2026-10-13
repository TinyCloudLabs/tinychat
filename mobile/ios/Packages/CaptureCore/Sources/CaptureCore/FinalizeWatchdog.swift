import Foundation

/// Decides whether a running mux has stopped making progress. Progress is anything the worker
/// reports (a stage reached, a sample appended) or any growth of the staged output; elapsed time
/// alone never fails a mux that is still moving, however slow the host is.
public struct MuxWatchdog {
    public enum Verdict: Equatable { case running, stalled, ceilingReached }

    public static let defaultStallSeconds: TimeInterval = 45

    /// Last-resort bound for a mux that keeps making tiny progress forever.
    public static func ceilingSeconds(forAudioMs audioMs: Int64) -> TimeInterval {
        min(14_400, max(600, Double(audioMs) / 1_000 * 3))
    }

    public let stallSeconds: TimeInterval
    public let ceilingSeconds: TimeInterval
    private let startedAt: TimeInterval
    private var lastChangeAt: TimeInterval
    private var lastTicks: Int
    private var lastBytes: Int64

    public init(startedAt: TimeInterval, stallSeconds: TimeInterval, ceilingSeconds: TimeInterval) {
        self.startedAt = startedAt
        self.stallSeconds = stallSeconds
        self.ceilingSeconds = ceilingSeconds
        lastChangeAt = startedAt
        lastTicks = 0
        lastBytes = 0
    }

    /// `ticks` and `bytes` are read before `now`, so a change is never dated earlier than it happened.
    public mutating func observe(ticks: Int, bytes: Int64, now: TimeInterval) -> Verdict {
        if ticks != lastTicks || bytes != lastBytes {
            lastTicks = ticks; lastBytes = bytes; lastChangeAt = now
        }
        if now - startedAt >= ceilingSeconds { return .ceilingReached }
        if now - lastChangeAt >= stallSeconds { return .stalled }
        return .running
    }
}

/// Automatic re-finalization after a timed-out Stop: back off, then leave it to the next launch.
public enum FinalizeRetrySchedule {
    public static let delays: [TimeInterval] = [2, 30]

    public static func delay(afterFailures failures: Int) -> TimeInterval? {
        failures >= 0 && failures < delays.count ? delays[failures] : nil
    }
}
