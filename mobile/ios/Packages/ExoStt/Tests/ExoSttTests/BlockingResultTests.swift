import XCTest
@testable import ExoStt

final class BlockingResultTests: XCTestCase {
    func testWaitStopsWhenDecodeIsCancelledBeforeCollectorFinishes() {
        let result = BlockingResult<Int>()
        let start = Date()
        var checks = 0
        XCTAssertThrowsError(try result.wait(timeout: 1) {
            checks += 1
            if checks == 2 { throw TranscriptionQueueError.cancelled }
        }) { error in
            guard case TranscriptionQueueError.cancelled = error else { return XCTFail("wrong cancellation") }
        }
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.5)
        result.finish(.success(42)) // A late collector must not unblock or publish a cancelled caller.
    }

    func testWaitHasFiniteDeadlineEvenWhenCollectorNeverFinishes() {
        let result = BlockingResult<Int>()
        let start = Date()
        XCTAssertThrowsError(try result.wait(timeout: 0.05, check: {})) { error in
            guard case BlockingResultError.timedOut = error else { return XCTFail("wrong deadline") }
        }
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.5)
    }
}
