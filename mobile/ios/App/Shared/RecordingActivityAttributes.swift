import ActivityKit
import Foundation

/// The recording Live Activity (Lock Screen and Dynamic Island). The app starts it with every recording
/// (App/CaptureLiveActivity.swift); `AudioRecordingIntent` requires one for a recording started in the background.
struct RecordingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, Hashable {
            case recording, paused, interrupted
        }

        var phase: Phase
        /// Recorded time is `now - recordingSince` while recording: the start, shifted later by any pauses.
        var recordingSince: Date
        /// Recorded time when the state was published; what a paused or interrupted activity shows.
        var elapsedSeconds: Int
    }

    var recordingId: String
}
