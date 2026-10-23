#if os(iOS)
import Foundation
import UIKit

/// One instance per decode; an old expiration cannot release a newer note's assertion.
final class UIKitTranscriptionActivity: TranscriptionActivity {
    private let lock = NSLock()
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    func begin(expired: @escaping () -> Void) -> Bool {
        let task = UIApplication.shared.beginBackgroundTask(withName: "Finish local voice transcription", expirationHandler: expired)
        lock.withLock { identifier = task }
        return task != .invalid
    }

    func end() {
        let task = lock.withLock { () -> UIBackgroundTaskIdentifier in
            defer { identifier = .invalid }
            return identifier
        }
        guard task != .invalid else { return }
        if Thread.isMainThread {
            UIApplication.shared.endBackgroundTask(task)
        } else {
            DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(task) }
        }
    }
}
#endif
