import Foundation

public struct WordErrorRateResult: Sendable {
    public let errors: Int
    public let referenceWords: Int
    public let hypothesisWords: Int
    public var rate: Double { Double(errors) / Double(referenceWords) }
}

public enum WordErrorRate {
    public static func score(reference: String, hypothesis: String) -> WordErrorRateResult? {
        let ref = normalizedWords(reference)
        guard !ref.isEmpty else { return nil }
        let hyp = normalizedWords(hypothesis)
        var row = Array(0...hyp.count)
        for (index, word) in ref.enumerated() {
            var next = [index + 1]
            for (column, other) in hyp.enumerated() {
                next.append(min(next[column] + 1, row[column + 1] + 1,
                                row[column] + (word == other ? 0 : 1)))
            }
            row = next
        }
        return WordErrorRateResult(errors: row[hyp.count], referenceWords: ref.count,
                                   hypothesisWords: hyp.count)
    }

    private static func normalizedWords(_ text: String) -> [String] {
        let folded = text.precomposedStringWithCompatibilityMapping.lowercased()
        let normalized = String(String.UnicodeScalarView(folded.unicodeScalars.map { scalar in
            CharacterSet.alphanumerics.contains(scalar) || CharacterSet.whitespacesAndNewlines.contains(scalar)
                ? scalar : Unicode.Scalar(32)!
        }))
        return normalized.split(whereSeparator: \.isWhitespace).map(String.init)
    }
}
