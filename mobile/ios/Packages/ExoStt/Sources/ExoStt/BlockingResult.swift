import Foundation

enum BlockingResultError: Error {
    case timedOut
}

/// Bridges Apple Speech async work to the serial decode queue without an unbounded semaphore wait.
final class BlockingResult<Value>: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var result: Result<Value, Error>?

    func finish(_ value: Result<Value, Error>) {
        let first = lock.withLock { () -> Bool in
            guard result == nil else { return false }
            result = value
            return true
        }
        if first { semaphore.signal() }
    }

    func wait(timeout: TimeInterval, check: () throws -> Void) throws -> Value {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(max(0, timeout) * 1_000_000_000)
        while true {
            try check()
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw BlockingResultError.timedOut }
            let remaining = min(50_000_000, deadline - now)
            if semaphore.wait(timeout: .now() + .nanoseconds(Int(remaining))) == .success {
                try check() // Cancellation wins even if a collector finishes in the same interval.
                return try lock.withLock { try result!.get() }
            }
        }
    }
}
