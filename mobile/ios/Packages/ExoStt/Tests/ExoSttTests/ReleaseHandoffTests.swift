import XCTest
@testable import ExoStt

final class ReleaseHandoffTests: XCTestCase {
    func testReturnsImmediatelyWhenNothingIsRunning() {
        let handoff = ReleaseHandoff()
        let started = Date()
        handoff.awaitRelease(timeout: 1.0)
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.1, "should not have waited at all")
    }

    func testReturnsAsSoonAsReleaseHappensWellBeforeTheBound() {
        let handoff = ReleaseHandoff()
        let semaphore = handoff.begin()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { handoff.release(semaphore) }
        let started = Date()
        handoff.awaitRelease(timeout: 5.0)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.0, "should have returned promptly once released, not waited for the full bound")
    }

    func testNeverWaitsPastTheBoundWhenReleaseNeverHappens() {
        let handoff = ReleaseHandoff()
        _ = handoff.begin() // never released: simulates a VAD segment's uninterruptible recognize() call
        let started = Date()
        handoff.awaitRelease(timeout: 0.15)
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertGreaterThanOrEqual(elapsed, 0.14)
        XCTAssertLessThan(elapsed, 2.0, "must not wait past the bound")
    }

    func testASecondBeginReplacesTheFirstSoAFreshUnitOfWorkGetsItsOwnHandoff() {
        let handoff = ReleaseHandoff()
        let first = handoff.begin()
        handoff.release(first)
        let second = handoff.begin()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { handoff.release(second) }
        let started = Date()
        handoff.awaitRelease(timeout: 5.0)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.0, "should track the second, still-live unit of work")
    }
}
