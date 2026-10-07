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

public enum TokenWordAlignmentError: Error {
    case mismatchedCounts
    case invalidTiming
}

public enum TokenWordAlignment {
    /// Sherpa timestamps are per BPE token. Word boundaries are marked by a
    /// leading space or SentencePiece's leading U+2581 marker.
    public static func align(tokens: [String], timestamps: [Float], durations: [Float],
                             origin: Double) throws -> [TimedWord] {
        guard tokens.count == timestamps.count, tokens.count == durations.count else {
            throw TokenWordAlignmentError.mismatchedCounts
        }
        var words: [TimedWord] = []
        var text = ""
        var start = 0.0
        var end = 0.0
        for index in tokens.indices {
            let token = tokens[index]
            let boundary = token.hasPrefix(" ") || token.hasPrefix("▁")
            let piece = token.replacingOccurrences(of: "▁", with: " ")
                .trimmingCharacters(in: .whitespaces)
            let tokenStart = origin + Double(timestamps[index])
            let tokenEnd = tokenStart + Double(durations[index])
            guard tokenStart.isFinite, tokenEnd.isFinite, tokenEnd >= tokenStart else {
                throw TokenWordAlignmentError.invalidTiming
            }
            if boundary && !text.isEmpty {
                words.append(.init(start: start, end: end, text: text))
                text = ""
            }
            guard !piece.isEmpty else { continue }
            if text.isEmpty {
                start = tokenStart
                end = tokenEnd
            }
            text += piece
            end = max(end, tokenEnd)
        }
        if !text.isEmpty { words.append(.init(start: start, end: end, text: text)) }
        return words
    }
}

public enum SpeakerAttribution {
    /// Uses the earlier-started floor holder when turns overlap.
    public static func assign(_ words: [TimedWord], turns: [SpeakerTurn]) -> [TimedWord] {
        let ordered = turns.sorted { $0.start == $1.start ? $0.speaker < $1.speaker : $0.start < $1.start }
        var previous: String?
        return words.map { word in
            let tokenStart = word.start
            let covering = ordered.first { $0.start <= tokenStart && tokenStart < $0.end }
            let nearest = ordered.min { left, right in
                distance(tokenStart, to: left) < distance(tokenStart, to: right)
            }
            let speaker = covering?.speaker ?? ((nearest.map { distance(tokenStart, to: $0) <= 0.5 } ?? false)
                ? nearest?.speaker : previous)
            previous = speaker
            return TimedWord(start: word.start, end: word.end, text: word.text, speaker: speaker)
        }
    }

    private static func distance(_ time: Double, to turn: SpeakerTurn) -> Double {
        max(turn.start - time, time - turn.end, 0)
    }
}
