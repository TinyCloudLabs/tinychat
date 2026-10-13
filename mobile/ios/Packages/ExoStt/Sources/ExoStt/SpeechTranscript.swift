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
        phrases.flatMap { phrase -> [[String: Any]] in
            let text = phrase.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return [] }
            let start = Int((phrase.startSeconds * 1000).rounded())
            let end = max(start, Int((phrase.endSeconds * 1000).rounded()))
            let words = text.split(whereSeparator: \.isWhitespace)
            let needed = max(1, Int(ceil(Double(end - start) / 30_000)))
            let byCharacter = words.count < needed
            let tokens = byCharacter ? text.map(String.init) : words.map(String.init)
            let count = min(tokens.count, needed)
            return (0..<count).map { index in
                let from = index * tokens.count / count
                let to = (index + 1) * tokens.count / count
                let pieceStart = start + (end - start) * index / count
                let pieceEnd = start + (end - start) * (index + 1) / count
                return ["start": pieceStart, "end": pieceEnd,
                        "text": tokens[from..<to].joined(separator: byCharacter ? "" : " "), "speaker": NSNull(),
                        "timing": count == 1 ? "engine" : "coarse"]
            }
        }
    }

    /// Whole percent of the note's audio already recognized, capped at 99: 100 is only reported once the
    /// transcript is published.
    static func percent(recognizedSeconds: Double, durationSeconds: Double?) -> Int {
        guard let durationSeconds, durationSeconds > 0 else { return 0 }
        return max(0, min(99, Int(recognizedSeconds / durationSeconds * 100)))
    }
}
