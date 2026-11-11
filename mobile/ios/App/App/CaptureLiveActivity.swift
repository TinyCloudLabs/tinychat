import ActivityKit
import ExoCapture
import Foundation
import os

/// Keeps one recording Live Activity in step with the native capture engine: requested when a recording starts
/// (from any source), updated on pause/interruption, ended when it stops. A recording started by an
/// `AudioRecordingIntent` in the background must show one, or iOS stops the microphone.
enum CaptureLiveActivity {
    private static let log = Logger(subsystem: "xyz.tinycloud.exo", category: "live-activity")
    private static let lock = NSLock()
    /// Updates and ends run one after another, in the order the engine published them.
    private static var tail: Task<Void, Never>?

    static func install() {
        CaptureEngine.shared.micStateChanged = { update($0) }
        // An activity left by a process that died mid-recording; recovery owns that note now.
        update(CaptureEngine.shared.status())
    }

    static func content(for status: [String: Any], now: Date = Date()) -> RecordingActivityAttributes.ContentState? {
        let phase: RecordingActivityAttributes.ContentState.Phase
        switch status["state"] as? String {
        case "recording", "silenced": phase = .recording
        case "paused": phase = .paused
        case "interrupted", "needs_user": phase = .interrupted
        default: return nil
        }
        let elapsedMs = (status["elapsedMs"] as? Int64) ?? Int64((status["elapsedMs"] as? Int) ?? 0)
        return .init(phase: phase, recordingSince: now.addingTimeInterval(-Double(elapsedMs) / 1000),
                     elapsedSeconds: Int(elapsedMs / 1000))
    }

    /// Synchronous for a new recording: the request happens inside the engine's `start`, as AudioRecordingIntent needs.
    static func update(_ status: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        let activities = Activity<RecordingActivityAttributes>.activities
        guard let id = status["id"] as? String, let state = content(for: status) else {
            enqueue { for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) } }
            return
        }
        let stale = activities.filter { $0.attributes.recordingId != id }
        if !stale.isEmpty { enqueue { for activity in stale { await activity.end(nil, dismissalPolicy: .immediate) } } }
        let content = ActivityContent(state: state, staleDate: nil)
        if let current = activities.first(where: { $0.attributes.recordingId == id }) {
            enqueue { await current.update(content) }
            return
        }
        do {
            _ = try Activity.request(attributes: RecordingActivityAttributes(recordingId: id), content: content, pushType: nil)
            log.notice("EXO_LIVE_ACTIVITY started id=\(id, privacy: .public)")
        } catch {
            log.error("EXO_LIVE_ACTIVITY request failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Caller holds `lock`.
    private static func enqueue(_ work: @escaping @Sendable () async -> Void) {
        let previous = tail
        tail = Task {
            await previous?.value
            await work()
        }
    }
}
