import XCTest
@testable import ExoStt

final class CapturePauseGateTests: XCTestCase {
    func testIdleBeforeAnyCapture() {
        XCTAssertFalse(CapturePauseGate().isActive())
    }

    func testActiveAsSoonAsCaptureStarts() {
        let gate = CapturePauseGate()
        gate.captureStarted()
        XCTAssertTrue(gate.isActive())
    }

    func testStaysActiveThroughAPauseResumeCycleWithinTheSameSession() {
        // A paused capture session still counts as capture (plan §2.5): CaptureEngine pushes
        // captureStarted() again on resume-from-interruption paths too, and that must not look
        // like a fresh session the gate has to "re-arm" from a cleared state.
        let gate = CapturePauseGate()
        gate.captureStarted()
        gate.captureStarted()
        XCTAssertTrue(gate.isActive())
    }

    func testClearsOnlyOnCaptureEnded() {
        let gate = CapturePauseGate()
        gate.captureStarted()
        gate.captureEnded()
        XCTAssertFalse(gate.isActive())
    }

    func testCaptureEndedWithoutAPriorStartIsANoOpNotAnError() {
        let gate = CapturePauseGate()
        gate.captureEnded()
        XCTAssertFalse(gate.isActive())
    }
}
