import AVFoundation
import XCTest
@testable import ExoStt

final class AudioDecoderTests: XCTestCase {
    /// Writes `seconds` of a quiet tone as AAC in an .m4a, the container the recorder produces.
    private func writeM4a(sampleRate: Double, channels: AVAudioChannelCount, seconds: Int) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: 64_000,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = file.processingFormat
        let chunkFrames = AVAudioFrameCount(sampleRate)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames)!
        buffer.frameLength = chunkFrames
        for second in 0..<seconds {
            for channel in 0..<Int(channels) {
                let samples = buffer.floatChannelData![channel]
                for frame in 0..<Int(chunkFrames) {
                    samples[frame] = 0.2 * sinf(2 * .pi * 220 * Float(second * Int(chunkFrames) + frame) / Float(sampleRate))
                }
            }
            try file.write(from: buffer)
        }
        return url
    }

    /// Decodes on a background thread so a decoder that never returns fails the test instead of hanging it.
    private func decode(_ url: URL) throws -> (windows: Int, samples: Int, peak: Float) {
        var windows = 0, samples = 0
        var peak: Float = 0
        var failure: Error?
        let done = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            do {
                try AudioDecoder.decodeWindows(url, windowSize: 512) { window in
                    windows += 1
                    samples += window.count
                    peak = max(peak, window.map(abs).max() ?? 0)
                }
            } catch { failure = error }
            done.signal()
        }
        XCTAssertEqual(done.wait(timeout: .now() + 30), .success, "decodeWindows did not return")
        if let failure { throw failure }
        return (windows, samples, peak)
    }

    func testDecodesAMultiChunkNoteToItsFullLengthAndReturns() throws {
        let url = try writeM4a(sampleRate: 48_000, channels: 1, seconds: 25) // > 2 read chunks of 10 s
        defer { try? FileManager.default.removeItem(at: url) }
        let result = try decode(url)
        XCTAssertEqual(Double(result.samples), 25 * 16_000, accuracy: 16_000 * 0.1)
        XCTAssertEqual(result.windows, Int((Double(result.samples) / 512).rounded(.up)))
        XCTAssertGreaterThan(result.peak, 0.05, "the audio content must survive the conversion")
    }

    func testDecodesAStereo44kNoteThatEndsMidChunk() throws {
        let url = try writeM4a(sampleRate: 44_100, channels: 2, seconds: 13)
        defer { try? FileManager.default.removeItem(at: url) }
        let result = try decode(url)
        XCTAssertEqual(Double(result.samples), 13 * 16_000, accuracy: 16_000 * 0.1)
    }

    func testDecodesAShortNote() throws {
        let url = try writeM4a(sampleRate: 48_000, channels: 1, seconds: 1)
        defer { try? FileManager.default.removeItem(at: url) }
        let result = try decode(url)
        XCTAssertEqual(Double(result.samples), 16_000, accuracy: 16_000 * 0.1)
    }

    func testAMissingFileThrows() {
        XCTAssertThrowsError(try AudioDecoder.decodeWindows(URL(fileURLWithPath: "/nonexistent.m4a"), windowSize: 512) { _ in })
    }
}

final class DecodeProgressTests: XCTestCase {
    func testPercentIsTheShareOfAudioConsumed() {
        // 10 minutes = 600 s = 18_750 windows of 512 samples at 16 kHz.
        XCTAssertEqual(DecodeProgress.percent(windowsDone: 0, windowSize: 512, durationSeconds: 600), 0)
        XCTAssertEqual(DecodeProgress.percent(windowsDone: 9_375, windowSize: 512, durationSeconds: 600), 50)
        XCTAssertEqual(DecodeProgress.percent(windowsDone: 1_875, windowSize: 512, durationSeconds: 600), 10)
    }

    func testPercentNeverReportsDoneBeforeThePublish() {
        XCTAssertEqual(DecodeProgress.percent(windowsDone: 18_750, windowSize: 512, durationSeconds: 600), 99)
        XCTAssertEqual(DecodeProgress.percent(windowsDone: 99_999, windowSize: 512, durationSeconds: 600), 99)
    }

    func testPercentIsZeroWhenTheDurationIsUnknown() {
        XCTAssertEqual(DecodeProgress.percent(windowsDone: 500, windowSize: 512, durationSeconds: nil), 0)
        XCTAssertEqual(DecodeProgress.percent(windowsDone: 500, windowSize: 512, durationSeconds: 0), 0)
    }
}
