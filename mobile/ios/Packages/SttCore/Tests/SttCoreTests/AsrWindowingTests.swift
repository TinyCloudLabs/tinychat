import XCTest
@testable import SttCore

final class AsrWindowingTests: XCTestCase {
    func testLongSpeechSplitsAtQuietFrameWithOverlapAndNoOwnershipGap() {
        let rate = 1_000
        var samples = [Float](repeating: 0.7, count: 34 * rate)
        for index in 13_400..<13_700 { samples[index] = 0.01 }
        let windows = AsrWindowing.plan(samples: samples, sampleRate: rate,
                                        maxSeconds: 15, overlapSeconds: 0.6)
        XCTAssertGreaterThan(windows.count, 2)
        XCTAssertEqual(windows.first?.ownedStart, 0)
        XCTAssertEqual(windows.last?.ownedEnd, samples.count)
        for (index, window) in windows.enumerated() {
            XCTAssertLessThanOrEqual(window.end - window.start, 15 * rate)
            XCTAssertLessThanOrEqual(window.start, window.ownedStart)
            XCTAssertGreaterThanOrEqual(window.end, window.ownedEnd)
            if index > 0 {
                XCTAssertEqual(windows[index - 1].ownedEnd, window.ownedStart)
                XCTAssertLessThan(window.start, windows[index - 1].end)
            }
        }
        XCTAssertTrue((13_400..<13_700).contains(windows[0].ownedEnd))
    }
}
