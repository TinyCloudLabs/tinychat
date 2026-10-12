import XCTest
@testable import ExoStt

final class SpeechTranscriptTests: XCTestCase {
    func testSegmentsAreWholeMillisecondsInOrder() {
        let segments = SpeechTranscript.segments([
            SpeechPhrase(text: "Hello there.", startSeconds: 0.0004, endSeconds: 1.2506),
            SpeechPhrase(text: "How are you?", startSeconds: 2, endSeconds: 3.5),
        ])
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0]["start"] as? Int, 0)
        XCTAssertEqual(segments[0]["end"] as? Int, 1251)
        XCTAssertEqual(segments[0]["text"] as? String, "Hello there.")
        XCTAssertTrue(segments[0]["speaker"] is NSNull)
        XCTAssertEqual(segments[1]["start"] as? Int, 2000)
        XCTAssertEqual(segments[1]["end"] as? Int, 3500)
    }

    func testPhrasesWithoutWordsAreDropped() {
        let segments = SpeechTranscript.segments([
            SpeechPhrase(text: "  \n", startSeconds: 0, endSeconds: 1),
            SpeechPhrase(text: " Yes ", startSeconds: 1, endSeconds: 2),
        ])
        XCTAssertEqual(segments.map { $0["text"] as? String }, ["Yes"])
    }

    func testAnEndBeforeItsStartCollapsesToZeroLength() {
        let segments = SpeechTranscript.segments([SpeechPhrase(text: "Hi", startSeconds: 2, endSeconds: 1)])
        XCTAssertEqual(segments[0]["start"] as? Int, 2000)
        XCTAssertEqual(segments[0]["end"] as? Int, 2000)
    }

    func testPercentTracksRecognizedAudioAndStopsAtNinetyNine() {
        XCTAssertEqual(SpeechTranscript.percent(recognizedSeconds: 0, durationSeconds: 600), 0)
        XCTAssertEqual(SpeechTranscript.percent(recognizedSeconds: 150, durationSeconds: 600), 25)
        XCTAssertEqual(SpeechTranscript.percent(recognizedSeconds: 600, durationSeconds: 600), 99)
        XCTAssertEqual(SpeechTranscript.percent(recognizedSeconds: 900, durationSeconds: 600), 99)
    }

    func testPercentIsZeroWithoutAKnownDuration() {
        XCTAssertEqual(SpeechTranscript.percent(recognizedSeconds: 30, durationSeconds: nil), 0)
        XCTAssertEqual(SpeechTranscript.percent(recognizedSeconds: 30, durationSeconds: 0), 0)
    }
}
