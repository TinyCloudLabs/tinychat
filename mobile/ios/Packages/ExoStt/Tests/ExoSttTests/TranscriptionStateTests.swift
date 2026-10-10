import XCTest
@testable import ExoStt

final class TranscriptionStateTests: XCTestCase {
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
        state.add("a"); state.add("b")
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

        XCTAssertLessThan(elapsedMs { state.add("c") }, 200)
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
        state.add("a")
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
        XCTAssertTrue(state.add("a"))
        XCTAssertFalse(state.add("a"))
        XCTAssertEqual(state.takeNext(), "a")
        XCTAssertFalse(state.add("a")) // a reconcile scan mid-decode still sees "a" as unfinished
        XCTAssertEqual(state.snapshot().count, 1)
        state.finishCurrent()
        XCTAssertTrue(state.add("a"))
    }

    func testYieldingToCaptureRequeuesTheRunningNoteAtTheHead() {
        let state = TranscriptionState()
        state.add("a"); state.add("b")
        XCTAssertEqual(state.takeNext(), "a")
        state.setProgress(50)
        state.requeueCurrentFirst()
        XCTAssertEqual(state.snapshot().map { $0["id"] as? String }, ["a", "b"])
        XCTAssertEqual(state.snapshot().map { $0["state"] as? String }, ["queued", "queued"])
    }

    func testWaitingForModelStateIsReportedForPendingNotes() {
        let state = TranscriptionState()
        state.add("a"); state.add("b")
        state.markAllPending(state: "waiting_for_model")
        XCTAssertEqual(state.snapshot().map { $0["state"] as? String }, ["waiting_for_model", "waiting_for_model"])
        XCTAssertEqual(state.removeAllPending(), ["a", "b"])
        XCTAssertFalse(state.hasPending)
    }
}
