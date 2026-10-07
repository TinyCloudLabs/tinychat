import XCTest
@testable import SttCore

final class TimedWordTests: XCTestCase {
    func testBpeTokenTimesBecomeWholeWordTimes() throws {
        let words = try TokenWordAlignment.align(tokens: ["▁un", "believ", "able", " world", "!"],
                                                 timestamps: [0.2, 0.35, 0.6, 1.1, 1.4],
                                                 durations: [0.1, 0.15, 0.2, 0.2, 0.05], origin: 25)
        XCTAssertEqual(words.map(\.text), ["unbelievable", "world!"])
        XCTAssertEqual(words[0].start, 25.2, accuracy: 0.001)
        XCTAssertEqual(words[0].end, 25.8, accuracy: 0.001)
        XCTAssertEqual(words[1].start, 26.1, accuracy: 0.001)
        XCTAssertEqual(words[1].end, 26.45, accuracy: 0.001)
        XCTAssertThrowsError(try TokenWordAlignment.align(tokens: ["▁one"], timestamps: [],
                                                       durations: [], origin: 0))
    }

    func testSpeakerAttributionAcrossOverlapAndGap() {
        let turns = [SpeakerTurn(start: 0, end: 2, speaker: "A"),
                     SpeakerTurn(start: 1.5, end: 3, speaker: "B")]
        let words = [TimedWord(start: 1.7, end: 1.9, text: "overlap"),
                     TimedWord(start: 2.3, end: 2.5, text: "second"),
                     TimedWord(start: 3.1, end: 3.2, text: "near")]
        XCTAssertEqual(SpeakerAttribution.assign(words, turns: turns).map(\.speaker), ["A", "B", "B"])
        XCTAssertEqual(SpeakerAttribution.assign([.init(start: 0.95, end: 1.15, text: "cross")],
                                               turns: [.init(start: 0, end: 1, speaker: "A"),
                                                       .init(start: 1, end: 2, speaker: "B")]).first?.speaker, "A")
    }
}
