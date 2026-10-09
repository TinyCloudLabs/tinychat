import Foundation

/// Buffers streamed samples into fixed-size windows, so a decoder can emit one AVAudioConverter
/// buffer's worth of audio at a time and still produce aligned VAD windows: the only state that
/// grows with time is this one window, not the note's length (TC-836 — the old whole-array decode
/// could OOM on a long recording left running). Mirrors Android's `core/WindowAccumulator.kt`.
final class WindowAccumulator {
    private let windowSize: Int
    private let onWindow: ([Float]) throws -> Void
    private var buffer: [Float]
    private var fill = 0

    init(windowSize: Int, onWindow: @escaping ([Float]) throws -> Void) {
        self.windowSize = windowSize
        self.onWindow = onWindow
        self.buffer = [Float](repeating: 0, count: windowSize)
    }

    func push(_ samples: UnsafeBufferPointer<Float>) throws {
        var offset = 0
        while offset < samples.count {
            let take = min(windowSize - fill, samples.count - offset)
            for index in 0..<take { buffer[fill + index] = samples[offset + index] }
            fill += take
            offset += take
            if fill == windowSize {
                try onWindow(buffer)
                fill = 0
            }
        }
    }

    /// Flushes a final, shorter-than-`windowSize` window if any samples are buffered.
    func finish() throws {
        if fill > 0 { try onWindow(Array(buffer[0..<fill])) }
        fill = 0
    }
}
