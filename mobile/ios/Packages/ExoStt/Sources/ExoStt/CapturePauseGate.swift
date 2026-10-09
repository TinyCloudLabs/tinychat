import Foundation

/// The capture-priority signal (plan §2.5, round-2 finding 3 override): `CaptureEngine` pushes
/// `captureStarted` the instant a session begins — it never waits on this class, or anything else,
/// before opening the mic. The STT queue reads `isActive` between work units (never mid-unit: a
/// single ASR segment's recognize() call can't be interrupted) and, once it sees it, releases its
/// engine instead of starting another unit. A pause/resume cycle within the same session calls
/// `captureStarted` again, which leaves `isActive` exactly as it was — the queue stays idle through
/// a *paused* capture session too, not only a recording one. Only `captureEnded` (Stop or Discard,
/// or a start that never actually acquired the mic) clears it, which is when the queue resumes from
/// its checkpoint. Backed by a lock rather than a bare `var`, unlike the `intent` read this
/// replaces (round-2 finding 3): both methods are still plain, non-blocking writes, so pushing this
/// signal can never add latency to capture start. Mirrors Android's `core/CapturePauseGate.kt`.
final class CapturePauseGate {
    private let lock = NSLock()
    private var active = false

    func captureStarted() {
        lock.lock(); active = true; lock.unlock()
    }

    func captureEnded() {
        lock.lock(); active = false; lock.unlock()
    }

    func isActive() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active
    }
}
