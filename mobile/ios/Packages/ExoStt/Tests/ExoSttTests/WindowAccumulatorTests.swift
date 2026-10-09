import XCTest
@testable import ExoStt

final class WindowAccumulatorTests: XCTestCase {
    func testEmitsExactlyOneWindowForExactlyOneWindowsWorthOfInput() throws {
        var windows: [[Float]] = []
        let accumulator = WindowAccumulator(windowSize: 4) { windows.append($0) }
        try [1, 2, 3, 4].withUnsafeBufferPointer { try accumulator.push($0) }
        XCTAssertEqual(windows, [[1, 2, 3, 4]])
    }

    func testAssemblesWindowsAcrossManySmallPushesRegardlessOfPushGranularity() throws {
        // Mirrors AVAudioConverter buffers arriving at sizes unrelated to the VAD window size.
        var windows: [[Float]] = []
        let accumulator = WindowAccumulator(windowSize: 512) { windows.append($0) }
        let input = (0..<(512 * 3 + 100)).map { Float($0) }
        let pushSizes = [37, 1, 900, 200]
        var offset = 0
        var i = 0
        while offset < input.count {
            let take = min(pushSizes[i % pushSizes.count], input.count - offset)
            let piece = Array(input[offset..<(offset + take)])
            try piece.withUnsafeBufferPointer { try accumulator.push($0) }
            offset += take
            i += 1
        }
        try accumulator.finish()
        XCTAssertEqual(windows.map(\.count), [512, 512, 512, 100])
        XCTAssertEqual(windows.flatMap { $0 }, input)
    }

    func testFinishFlushesAShorterFinalWindowExactlyOnce() throws {
        var windows: [[Float]] = []
        let accumulator = WindowAccumulator(windowSize: 10) { windows.append($0) }
        try [1, 2, 3].withUnsafeBufferPointer { try accumulator.push($0) }
        try accumulator.finish()
        try accumulator.finish()
        XCTAssertEqual(windows, [[1, 2, 3]])
    }

    func testFinishIsANoOpWhenNothingIsBuffered() throws {
        var windows: [[Float]] = []
        let accumulator = WindowAccumulator(windowSize: 10) { windows.append($0) }
        try [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].withUnsafeBufferPointer { try accumulator.push($0) }
        try accumulator.finish()
        XCTAssertEqual(windows.count, 1)
    }

    /// A 3-hour note's worth of samples, streamed through in small codec-sized pushes, without
    /// ever materializing the whole note: proves the design that fixed TC-836's whole-file OOM.
    func testStaysCorrectAcrossAThreeHourSyntheticNoteStreamedInSmallChunks() throws {
        let sampleRate = 16_000
        let totalSamples = 3 * 3600 * sampleRate // 172,800,000 samples
        let windowSize = 512
        var windowCount = 0
        var totalEmitted = 0
        var sawOversizedWindow = false
        let accumulator = WindowAccumulator(windowSize: windowSize) { window in
            windowCount += 1
            totalEmitted += window.count
            if window.count > windowSize { sawOversizedWindow = true }
        }

        let chunkSize = 4096
        var remaining = totalSamples
        let chunk = [Float](repeating: 0, count: chunkSize) // one small, reused buffer: the test itself stays bounded too
        while remaining > 0 {
            let take = min(chunkSize, remaining)
            if take == chunkSize {
                try chunk.withUnsafeBufferPointer { try accumulator.push($0) }
            } else {
                try Array(chunk[0..<take]).withUnsafeBufferPointer { try accumulator.push($0) }
            }
            remaining -= take
        }
        try accumulator.finish()

        XCTAssertEqual(totalEmitted, totalSamples)
        XCTAssertFalse(sawOversizedWindow, "no window may exceed windowSize")
        XCTAssertEqual(windowCount, totalSamples / windowSize) // exact: totalSamples is windowSize-aligned
    }
}
