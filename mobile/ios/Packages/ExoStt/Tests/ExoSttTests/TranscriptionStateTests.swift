import XCTest
@testable import ExoStt

final class TranscriptionStateTests: XCTestCase {
    private func add(_ state: TranscriptionState, _ id: String) -> Bool {
        guard state.reserve(id) else { return false }
        state.publishReserved(id)
        return true
    }

    private func elapsedMs(_ body: () -> Void) -> Double {
        let startedAt = DispatchTime.now()
        body()
        return Double(DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
    }

    /// Runs the queue's drain loop on a worker thread whose "decode" of `blockedId` blocks until
    /// `release` is signalled, the way a note inside onnxruntime does for minutes on a phone.
    private func startBlockedDecode(state: TranscriptionState, blockedId: String, release: DispatchSemaphore,
                                    entered: XCTestExpectation, done: XCTestExpectation) {
        Thread.detachNewThread {
            CaptureYieldingLoop.run(
                hasNext: { state.hasPending },
                next: { state.takeNext() },
                isPaused: { false }
            ) { next in
                guard let id = next else { return }
                defer { state.finishCurrent() }
                if id == blockedId {
                    state.setProgress(37)
                    entered.fulfill()
                    release.wait()
                }
            }
            done.fulfill()
        }
    }

    func testSnapshotEnqueueAndCancelReturnPromptlyWhileADecodeIsBlocked() {
        let state = TranscriptionState()
        _ = add(state, "a"); _ = add(state, "b")
        let release = DispatchSemaphore(value: 0)
        let entered = expectation(description: "decode entered")
        let done = expectation(description: "drain finished")
        startBlockedDecode(state: state, blockedId: "a", release: release, entered: entered, done: done)
        wait(for: [entered], timeout: 5)

        var snapshot: [[String: Any]] = []
        XCTAssertLessThan(elapsedMs { snapshot = state.snapshot() }, 200)
        XCTAssertEqual(snapshot.map { $0["id"] as? String }, ["a", "b"])
        XCTAssertEqual(snapshot[0]["state"] as? String, "running")
        XCTAssertEqual(snapshot[0]["percent"] as? Int, 37)
        XCTAssertEqual(snapshot[1]["state"] as? String, "queued")
        XCTAssertTrue(snapshot[1]["percent"] is NSNull)

        XCTAssertLessThan(elapsedMs { _ = add(state, "c") }, 200)
        var outcome = TranscriptionState.CancelOutcome.notFound
        XCTAssertLessThan(elapsedMs { outcome = state.cancel("b") }, 200)
        XCTAssertEqual(outcome, .removedPending)
        XCTAssertEqual(state.snapshot().map { $0["id"] as? String }, ["a", "c"])

        release.signal()
        wait(for: [done], timeout: 5)
        XCTAssertTrue(state.snapshot().isEmpty)
    }

    func testCancellingTheRunningNoteFlagsItInsteadOfRemovingIt() {
        let state = TranscriptionState()
        _ = add(state, "a")
        XCTAssertEqual(state.takeNext(), "a")
        XCTAssertFalse(state.isCancelRequested("a"))
        XCTAssertEqual(state.cancel("a"), .flaggedRunning)
        XCTAssertTrue(state.isCancelRequested("a"))
        XCTAssertEqual(state.snapshot().first?["state"] as? String, "running")
        state.finishCurrent()
        XCTAssertFalse(state.isCancelRequested("a"))
        XCTAssertEqual(state.cancel("a"), .notFound)
    }

    func testTheRunningNoteIsNeverQueuedAgain() {
        let state = TranscriptionState()
        XCTAssertTrue(add(state, "a"))
        XCTAssertFalse(add(state, "a"))
        XCTAssertEqual(state.takeNext(), "a")
        XCTAssertFalse(add(state, "a")) // a duplicate enqueue mid-decode must not touch it
        XCTAssertFalse(state.addScanned("a", scanStartedAt: state.scanStarted())) // nor a scan that still sees it unfinished
        XCTAssertEqual(state.snapshot().count, 1)
        state.finishCurrent()
        XCTAssertTrue(add(state, "a")) // an explicit retry after it finished is allowed
    }

    func testYieldingToCaptureRequeuesTheRunningNoteAtTheHead() {
        let state = TranscriptionState()
        _ = add(state, "a"); _ = add(state, "b")
        XCTAssertEqual(state.takeNext(), "a")
        state.setProgress(50)
        XCTAssertEqual(state.yieldCurrent(), .requeued)
        XCTAssertEqual(state.snapshot().map { $0["id"] as? String }, ["a", "b"])
        XCTAssertEqual(state.snapshot().map { $0["state"] as? String }, ["queued", "queued"])
        state.finishCurrent() // the worker's defer after a yield must not count as a final state
        XCTAssertTrue(state.addScanned("c", scanStartedAt: 0))
        XCTAssertEqual(state.cancel("a"), .removedPending)
    }

    func testACancelAcceptedBeforeAYieldWinsAndTheNoteIsNotRequeued() {
        let state = TranscriptionState()
        _ = add(state, "a")
        _ = state.takeNext()
        XCTAssertEqual(state.cancel("a"), .flaggedRunning)
        XCTAssertEqual(state.yieldCurrent(), .cancelled)
        XCTAssertFalse(state.hasPending)
        XCTAssertTrue(state.snapshot().isEmpty)
    }

    func testCancelAndCommitHaveExactlyOneWinner() {
        let cancelFirst = TranscriptionState()
        _ = add(cancelFirst, "a")
        _ = cancelFirst.takeNext()
        XCTAssertEqual(cancelFirst.cancel("a"), .flaggedRunning)
        XCTAssertFalse(cancelFirst.beginCommit())

        let commitFirst = TranscriptionState()
        _ = add(commitFirst, "a")
        _ = commitFirst.takeNext()
        XCTAssertTrue(commitFirst.beginCommit())
        XCTAssertEqual(commitFirst.cancel("a"), .tooLate)
        XCTAssertFalse(commitFirst.isCancelRequested("a"))
    }

    func testAScanThatStraddlesANoteFinishingCannotAddItBack() {
        let state = TranscriptionState()
        _ = add(state, "a")
        let scanStartedAt = state.scanStarted()
        _ = state.takeNext()
        state.finishCurrent()
        XCTAssertFalse(state.addScanned("a", scanStartedAt: scanStartedAt))
        XCTAssertTrue(state.addScanned("a", scanStartedAt: state.scanStarted())) // a later scan may
    }

    func testAScanThatStraddlesAModelLoadFailureCannotAddTheNoteBack() {
        let state = TranscriptionState()
        _ = add(state, "a")
        let scanStartedAt = state.scanStarted()
        XCTAssertEqual(state.removeAllPending(), ["a"])
        XCTAssertFalse(state.addScanned("a", scanStartedAt: scanStartedAt))
    }

    func testAReservedNoteIsInvisibleToTheWorkerUntilPublished() {
        let state = TranscriptionState()
        XCTAssertTrue(state.reserve("a"))
        XCTAssertFalse(state.reserve("a"))
        XCTAssertFalse(state.addScanned("a", scanStartedAt: state.scanStarted()))
        XCTAssertFalse(state.hasPending)
        XCTAssertNil(state.takeNext())
        state.publishReserved("a")
        XCTAssertEqual(state.takeNext(), "a")
        XCTAssertTrue(state.reserve("b"))
        state.releaseReserved("b")
        XCTAssertTrue(state.reserve("b"))
    }

    func testWaitingForModelStateIsReportedForPendingNotes() {
        let state = TranscriptionState()
        _ = add(state, "a"); _ = add(state, "b")
        state.markAllPending(state: "waiting_for_model")
        XCTAssertEqual(state.snapshot().map { $0["state"] as? String }, ["waiting_for_model", "waiting_for_model"])
        XCTAssertEqual(state.removeAllPending(), ["a", "b"])
        XCTAssertFalse(state.hasPending)
    }
}
