import Foundation

/// Progress of a note's decode as the share of its audio already fed to the recognizer, so it tracks
/// the real position in the recording rather than a count estimated up front.
enum DecodeProgress {
    static let sampleRate = 16_000

    /// Whole percent, capped at 99: 100 is only reported once the transcript is published.
    static func percent(windowsDone: Int, windowSize: Int, durationSeconds: Double?) -> Int {
        guard let durationSeconds, durationSeconds > 0 else { return 0 }
        let consumedSeconds = Double(windowsDone * windowSize) / Double(sampleRate)
        return max(0, min(99, Int(consumedSeconds / durationSeconds * 100)))
    }
}
