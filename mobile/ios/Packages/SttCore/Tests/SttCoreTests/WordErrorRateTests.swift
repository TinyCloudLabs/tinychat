import XCTest
@testable import SttCore

final class WordErrorRateTests: XCTestCase {
    func testPunctuationAndCaseNormalizationMatchesFixtureScorer() {
        let result = WordErrorRate.score(reference: "A kind-of word. HELLO!",
                                         hypothesis: "a kind of word hello")
        XCTAssertEqual(result?.errors, 0)
        XCTAssertEqual(result?.referenceWords, 5)
        XCTAssertEqual(result?.hypothesisWords, 5)
    }

    func testDeletionIsReported() {
        let result = WordErrorRate.score(reference: "one two three", hypothesis: "one three")
        XCTAssertEqual(result?.errors, 1)
        XCTAssertEqual(result?.rate, 1.0 / 3.0)
    }
}
