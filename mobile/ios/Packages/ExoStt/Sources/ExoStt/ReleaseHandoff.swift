import Foundation

/// Coordinates capture-start against an in-progress on-device decode (plan capture-priority
/// handoff, §2.5). Capture must never wait unboundedly for STT to release its native engine: a
/// single VAD segment's recognize() call isn't interruptible mid-call, so the most STT can promise
/// is to release at its next checkpoint. `awaitRelease` blocks up to a bound either way, so a long
/// recognize() call can never delay the microphone opening indefinitely — capture always wins.
/// Mirrors Android's `core/ReleaseHandoff.kt` exactly.
final class ReleaseHandoff {
    private let lock = NSLock()
    private var current: DispatchSemaphore?

    /// Called when STT begins a unit of work that holds its native engine; pair with `release`.
    func begin() -> DispatchSemaphore {
        let semaphore = DispatchSemaphore(value: 0)
        lock.lock()
        current = semaphore
        lock.unlock()
        return semaphore
    }

    /// Called once STT has released its native engine.
    func release(_ started: DispatchSemaphore) {
        started.signal()
        lock.lock()
        if current === started { current = nil }
        lock.unlock()
    }

    /// Called by capture before opening the mic. Returns as soon as STT releases, or after
    /// `timeout` — whichever comes first; capture proceeds either way.
    func awaitRelease(timeout: TimeInterval) {
        lock.lock()
        let semaphore = current
        lock.unlock()
        _ = semaphore?.wait(timeout: .now() + timeout)
    }
}
