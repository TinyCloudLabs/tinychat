import Foundation

public protocol CaptureClock { func nowMilliseconds() -> Int64 }
public protocol CaptureInputControl {
    func stopInput() -> Bool
    func releaseInput() throws
}
public protocol CaptureFrameSink {
    func closeSegment() throws -> (audioMs: Int64, at: Int64)?
}
public protocol CaptureJournalSink {
    func append(_ event: [String: Any], fullSync: Bool) throws
}

public struct SystemCaptureClock: CaptureClock {
    public init() {}
    public func nowMilliseconds() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }
}

public struct ClosureInputControl: CaptureInputControl {
    public let stop: () -> Bool
    public let release: () throws -> Void
    public init(stop: @escaping () -> Bool, release: @escaping () throws -> Void) {
        self.stop = stop; self.release = release
    }
    public func stopInput() -> Bool { stop() }
    public func releaseInput() throws { try release() }
}

public struct ClosureFrameSink: CaptureFrameSink {
    public let close: () throws -> (audioMs: Int64, at: Int64)?
    public init(close: @escaping () throws -> (audioMs: Int64, at: Int64)?) { self.close = close }
    public func closeSegment() throws -> (audioMs: Int64, at: Int64)? { try close() }
}

public struct ClosureJournalSink: CaptureJournalSink {
    public let write: ([String: Any], Bool) throws -> Void
    public init(write: @escaping ([String: Any], Bool) throws -> Void) { self.write = write }
    public func append(_ event: [String: Any], fullSync: Bool) throws { try write(event, fullSync) }
}
