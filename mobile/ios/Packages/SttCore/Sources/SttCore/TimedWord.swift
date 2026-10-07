import Foundation

public struct TimedWord: Codable, Equatable, Sendable {
    public let start: Double
    public let end: Double
    public let text: String
    public let speaker: String?

    public init(start: Double, end: Double, text: String, speaker: String? = nil) {
        self.start = start
        self.end = end
        self.text = text
        self.speaker = speaker
    }
}

public struct SpeakerTurn: Codable, Equatable, Sendable {
    public let start: Double
    public let end: Double
    public let speaker: String

    public init(start: Double, end: Double, speaker: String) {
        self.start = start
        self.end = end
        self.speaker = speaker
    }
}

public enum SttTiming {
    /// Crop a reference turn to an audio excerpt, then rebase to its first sample.
    public static func clippedTurn(_ turn: SpeakerTurn, cropStart: Double, cropEnd: Double) -> SpeakerTurn? {
        let start = max(turn.start, cropStart)
        let end = min(turn.end, cropEnd)
        guard end > start else { return nil }
        return SpeakerTurn(start: start - cropStart, end: end - cropStart, speaker: turn.speaker)
    }

    /// A clipped word no longer has the same acoustic evidence, so exclude it.
    public static func wholeWord(_ word: TimedWord, cropStart: Double, cropEnd: Double) -> TimedWord? {
        guard word.start >= cropStart, word.end <= cropEnd, word.end > word.start else { return nil }
        return TimedWord(start: word.start - cropStart, end: word.end - cropStart,
                         text: word.text, speaker: word.speaker)
    }

    public static func validate(_ words: [TimedWord], duration: Double) -> Bool {
        words.allSatisfy { $0.start.isFinite && $0.end.isFinite && $0.start >= 0 && $0.end <= duration && $0.end >= $0.start }
    }
}
