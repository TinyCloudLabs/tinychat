import Foundation

/// One recognized phrase from Apple's speech modules, with the audio range it covers in seconds.
struct SpeechPhrase: Equatable {
    let text: String
    let startSeconds: Double
    let endSeconds: Double
}

/// Turns recognized phrases into the transcript's segments and the decode's progress.
enum SpeechTranscript {
    /// Milliseconds, not fractional seconds: CanonicalJSON only accepts whole-integer NSNumbers (TC-836 —
    /// the only type every other timestamp in this schema already uses). Phrases without any words are dropped.
    static func segments(_ phrases: [SpeechPhrase]) -> [[String: Any]] {
        phrases.compactMap { phrase in
            let text = phrase.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let start = Int((phrase.startSeconds * 1000).rounded())
            let end = max(start, Int((phrase.endSeconds * 1000).rounded()))
            return ["start": start, "end": end, "text": text, "speaker": NSNull()]
        }
    }

    /// Whole percent of the note's audio already recognized, capped at 99: 100 is only reported once the
    /// transcript is published.
    static func percent(recognizedSeconds: Double, durationSeconds: Double?) -> Int {
        guard let durationSeconds, durationSeconds > 0 else { return 0 }
        return max(0, min(99, Int(recognizedSeconds / durationSeconds * 100)))
    }
}
