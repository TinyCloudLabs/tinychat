import Foundation

/// Caps how many times a note may re-enter transcription after a crash or failure. Without this, a
/// note whose decode crashes the process stays `running` forever (nothing ever moves it to
/// `failed`), and `reconcile()` requeues it on every launch: a crash loop (TC-836 incident). The
/// attempt count must be persisted *before* the risky work starts, so a crash mid-attempt still
/// counts against the cap on the next launch. Mirrors Android's `core/AttemptGuard.kt` exactly.
enum AttemptGuard {
    static let maxAttempts = 3

    enum Decision: Equatable {
        case proceed(attempt: Int)
        case giveUp
    }

    static func next(previousAttempts: Int) -> Decision {
        let attempt = previousAttempts + 1
        return attempt > maxAttempts ? .giveUp : .proceed(attempt: attempt)
    }
}
