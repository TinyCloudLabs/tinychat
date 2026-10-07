import XCTest
@testable import SttCore

final class TimedWordTests: XCTestCase {
    func testCropUsesOneOriginAndClipsTurnsOnly() {
        XCTAssertEqual(SttTiming.clippedTurn(.init(start: 299, end: 301, speaker: "A"),
                                             cropStart: 300, cropEnd: 900),
                       .init(start: 0, end: 1, speaker: "A"))
        XCTAssertEqual(SttTiming.wholeWord(.init(start: 299.9, end: 300.1, text: "edge"),
                                           cropStart: 300, cropEnd: 900), nil)
        XCTAssertEqual(SttTiming.wholeWord(.init(start: 899, end: 899.5, text: "end"),
                                           cropStart: 300, cropEnd: 900),
                       .init(start: 599, end: 599.5, text: "end"))
    }

    func testTimingBounds() {
        XCTAssertTrue(SttTiming.validate([.init(start: 0, end: 600, text: "ok")], duration: 600))
        XCTAssertFalse(SttTiming.validate([.init(start: 599, end: 601, text: "late")], duration: 600))
    }
}
