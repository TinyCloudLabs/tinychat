import XCTest
@testable import ExoStt

final class CaptureYieldingLoopTests: XCTestCase {
    private func loopOver(pending: inout [String], gate: CapturePauseGate, processed: inout [String]) -> Bool {
        CaptureYieldingLoop.run(
            hasNext: { !pending.isEmpty },
            next: { pending.removeFirst() },
            isPaused: { gate.isActive() }
        ) { unit in processed.append(unit) }
    }

    func testDrainsEverythingWhenNeverPaused() {
        var pending = ["a", "b", "c"]
        var processed: [String] = []
        let completed = loopOver(pending: &pending, gate: CapturePauseGate(), processed: &processed)
        XCTAssertTrue(completed)
        XCTAssertEqual(processed, ["a", "b", "c"])
        XCTAssertTrue(pending.isEmpty)
    }

    func testReleasesAfterTheCurrentUnitNotMidUnit() {
        // STT running -> capture starts: the gate flips active from inside the "a" unit's own
        // work (as a real recognize() call would notice mid-decode), not before it. The loop must
        // still let "a" finish -- the running work unit is never interrupted, only the next one
        // is withheld (plan §2.5's "finishes and checkpoints, then everything is released").
        var pending = ["a", "b", "c"]
        var processed: [String] = []
        let gate = CapturePauseGate()
        let completed = CaptureYieldingLoop.run(
            hasNext: { !pending.isEmpty },
            next: { pending.removeFirst() },
            isPaused: { gate.isActive() }
        ) { unit in
            processed.append(unit)
            if unit == "a" { gate.captureStarted() } // noticed mid-"a", takes effect at the next checkpoint
        }
        XCTAssertFalse(completed)
        XCTAssertEqual(processed, ["a"])
        XCTAssertEqual(pending, ["b", "c"]) // left exactly where it was, including "b" itself
    }

    func testNoReloadWhilePaused() {
        // Once paused, calling the loop again must not start a single further unit -- modelling
        // "the queue stays idle while any capture session exists, including a paused one".
        var pending = ["a", "b", "c"]
        var processed: [String] = []
        let gate = CapturePauseGate()
        gate.captureStarted()
        let first = loopOver(pending: &pending, gate: gate, processed: &processed)
        let second = loopOver(pending: &pending, gate: gate, processed: &processed) // pump() called again while still paused
        XCTAssertFalse(first)
        XCTAssertFalse(second)
        XCTAssertTrue(processed.isEmpty)
        XCTAssertEqual(pending, ["a", "b", "c"])
    }

    func testResumesFromTheCheckpointAfterCaptureEnds() {
        var pending = ["a", "b", "c"]
        var processed: [String] = []
        let gate = CapturePauseGate()
        let first = CaptureYieldingLoop.run(
            hasNext: { !pending.isEmpty },
            next: { pending.removeFirst() },
            isPaused: { gate.isActive() }
        ) { unit in
            processed.append(unit)
            if unit == "a" { gate.captureStarted() }
        }
        XCTAssertFalse(first)
        XCTAssertEqual(processed, ["a"])

        gate.captureEnded() // Stop: the queue resumes from its checkpoint, not from the top.
        let second = loopOver(pending: &pending, gate: gate, processed: &processed)
        XCTAssertTrue(second)
        XCTAssertEqual(processed, ["a", "b", "c"])
        XCTAssertTrue(pending.isEmpty)
    }

    func testNeverBlocks() {
        // Capture must never be blocked: the predicates are plain reads and `process` is the only
        // thing that can take real time, so a paused run returns practically instantly.
        var pending = ["a"]
        let gate = CapturePauseGate()
        gate.captureStarted()
        let startedAt = DispatchTime.now()
        CaptureYieldingLoop.run(hasNext: { !pending.isEmpty }, next: { pending.removeFirst() },
                                isPaused: { gate.isActive() }) { _ in }
        let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
        XCTAssertLessThan(elapsedMs, 50, "expected an effectively instant return, took \(elapsedMs)ms")
    }
}
