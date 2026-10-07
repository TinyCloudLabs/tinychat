/// Wall-clock duration excludes only intervals whose intent is paused. Interruptions and
/// blocked input attempts continue to count toward the recording limit.
public enum CaptureTiming {
    public static func pausedMilliseconds(closed: Int64, since: Int64?, now: Int64) -> Int64 {
        closed + (since.map { max(0, now - $0) } ?? 0)
    }

    public static func elapsedMilliseconds(startedAt: Int64, closedPaused: Int64,
                                           pausedSince: Int64?, now: Int64) -> Int64 {
        max(0, now - startedAt - pausedMilliseconds(closed: closedPaused, since: pausedSince, now: now))
    }
}
