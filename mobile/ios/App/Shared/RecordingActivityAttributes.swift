import ActivityKit

struct RecordingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: String
        var count: Int
    }

    var label: String
}
