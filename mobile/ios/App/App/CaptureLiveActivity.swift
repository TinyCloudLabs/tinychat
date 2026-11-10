import ActivityKit
import ExoCapture
import Foundation
import os

/// Keeps one recording Live Activity in step with the native capture engine: requested when a recording starts
/// (from any source), updated on pause/interruption, ended when it stops. A recording started by an
/// `AudioRecordingIntent` in the background must show one, or iOS stops the microphone.
enum CaptureLiveActivity {
    private static let log = Logger(subsystem: "xyz.tinycloud.exo", category: "live-activity")

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

    static func update(_ status: [String: Any]) {
        let activities = Activity<RecordingActivityAttributes>.activities
        guard let id = status["id"] as? String, let state = content(for: status) else {
            for activity in activities { end(activity) }
            return
        }
        for activity in activities where activity.attributes.recordingId != id { end(activity) }
        let content = ActivityContent(state: state, staleDate: nil)
        if let current = activities.first(where: { $0.attributes.recordingId == id }) {
            Task { await current.update(content) }
            return
        }
        do {
            _ = try Activity.request(attributes: RecordingActivityAttributes(recordingId: id), content: content, pushType: nil)
            log.notice("EXO_LIVE_ACTIVITY started id=\(id, privacy: .public)")
        } catch {
            log.error("EXO_LIVE_ACTIVITY request failed: \(String(describing: error), privacy: .public)")
        }
    }

    private static func end(_ activity: Activity<RecordingActivityAttributes>) {
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}
