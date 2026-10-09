import XCTest
@testable import ExoStt

final class AttemptGuardTests: XCTestCase {
    func testProceedsWithAnIncrementingAttemptNumberUpToTheCap() {
        var attempts = 0
        for expected in 1...AttemptGuard.maxAttempts {
            guard case .proceed(let attempt) = AttemptGuard.next(previousAttempts: attempts) else {
                return XCTFail("expected .proceed")
            }
            XCTAssertEqual(attempt, expected)
            attempts = attempt
        }
    }

    func testGivesUpOncePreviousAttemptsReachesTheCap() {
        XCTAssertEqual(AttemptGuard.next(previousAttempts: AttemptGuard.maxAttempts), .giveUp)
    }

    func testNeverProceedsAgainOnceItHasGivenUp() {
        // A crash that never updates `previousAttempts` past the cap must still never resume:
        // simulates a note that keeps crashing at the same attempt count forever.
        for _ in 0..<5 {
            XCTAssertEqual(AttemptGuard.next(previousAttempts: AttemptGuard.maxAttempts + 10), .giveUp)
        }
    }
}
