public struct HeartbeatSchedule {
    public private(set) var nextDueAt: Int64

    public init(segmentOpenedAt: Int64) { nextDueAt = segmentOpenedAt + 2_000 }

    /// A close owns its instant, even when a periodic heartbeat is due at the same time.
    public mutating func periodicDue(at: Int64, closing: Bool) -> Bool {
        guard !closing, at >= nextDueAt else { return false }
        repeat { nextDueAt += 2_000 } while nextDueAt <= at
        return true
    }
}
