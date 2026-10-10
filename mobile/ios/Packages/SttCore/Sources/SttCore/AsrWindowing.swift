import Foundation

public struct AsrWindow: Equatable, Sendable {
    /// Sample offsets within one VAD segment. Audio windows overlap; owned
    /// ranges partition the source so a word is emitted from only one window.
    public let start: Int
    public let end: Int
    public let ownedStart: Int
    public let ownedEnd: Int

    public init(start: Int, end: Int, ownedStart: Int, ownedEnd: Int) {
        self.start = start
        self.end = end
        self.ownedStart = ownedStart
        self.ownedEnd = ownedEnd
    }
}

public enum AsrWindowing {
    public static func plan(samples: [Float], sampleRate: Int, maxSeconds: Double,
                            overlapSeconds: Double = 0.6) -> [AsrWindow] {
        guard !samples.isEmpty else { return [] }
        let maxSamples = Int(maxSeconds * Double(sampleRate))
        let halfOverlap = Int(overlapSeconds * Double(sampleRate) / 2)
        precondition(maxSamples > 4 * halfOverlap && sampleRate > 0)
        let frame = max(1, sampleRate / 50) // 20 ms energy frames.
        var result: [AsrWindow] = []
        var start = 0
        var ownedStart = 0
        while samples.count - start > maxSamples {
            let latestCut = start + maxSamples - halfOverlap
            let earliestCut = max(start + halfOverlap + frame, latestCut - 2 * sampleRate)
            var cut = latestCut
            var bestEnergy = Double.infinity
            for candidate in stride(from: earliestCut, through: latestCut, by: frame) {
                let left = max(0, candidate - frame / 2)
                let right = min(samples.count, candidate + frame / 2)
                let energy = samples[left..<right].reduce(0.0) { $0 + Double($1) * Double($1) }
                if energy < bestEnergy {
                    bestEnergy = energy
                    cut = candidate
                }
            }
            result.append(AsrWindow(start: start, end: cut + halfOverlap,
                                    ownedStart: ownedStart, ownedEnd: cut))
            start = cut - halfOverlap
            ownedStart = cut
        }
        result.append(AsrWindow(start: start, end: samples.count,
                                ownedStart: ownedStart, ownedEnd: samples.count))
        return result
    }
}
