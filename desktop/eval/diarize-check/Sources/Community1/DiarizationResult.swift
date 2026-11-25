// Copied from soniqo/speech-swift, commit 335a68c0db92564527881962ff11eb686863d2b8,
// Sources/SpeechVAD/DiarizationPipeline.swift lines 41-57: the result type only (the rest of that file uses MLX).
// Apache License 2.0: see LICENSE-speech-swift in this package.

import AudioCommon

// MARK: - Result

/// Result of speaker diarization.
public struct DiarizationResult: Sendable {
    /// Diarized speech segments with speaker IDs
    public let segments: [DiarizedSegment]
    /// Number of distinct speakers found
    public let numSpeakers: Int
    /// Centroid embedding for each speaker (speaker ID → 256-dim embedding)
    public let speakerEmbeddings: [[Float]]

    public init(segments: [DiarizedSegment], numSpeakers: Int, speakerEmbeddings: [[Float]]) {
        self.segments = segments
        self.numSpeakers = numSpeakers
        self.speakerEmbeddings = speakerEmbeddings
    }
}
