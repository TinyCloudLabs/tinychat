import XCTest
@testable import ExoStt

/// Drives the real queue orchestration (`TranscriptionCore`) against a fake note library and a fake
/// decoder whose every stage can be held, to reproduce the interleavings between the control queue
/// (cancel, enqueue, reconcile) and the decode worker deterministically.
final class TranscriptionCoreTests: XCTestCase {
    private final class FakeLibrary: TranscriptionLibrary {
        private let lock = NSLock()
        private var stt: [String: [String: Any]] = [:]
        private var committed: [String: String] = [:]
        var updateError: Error?
        private var transcripts: [String: [String: Any]] = [:]
        /// Runs (outside the lock) before a matching `updateStt` is applied, to hold it.
        var beforeUpdate: ((String, [String: Any]) -> Void)?
        /// One-shot, runs inside the next `transcript(_:)` read, after the read, to hold it.
        private var afterTranscriptRead: ((String) -> Void)?
        private var history: [(id: String, patch: [String: Any])] = []

        func seed(_ id: String, state: String, attempts: Int = 0, committed mode: String = "on-device") {
            lock.lock(); defer { lock.unlock() }
            stt[id] = ["state": state, "attempts": attempts]
            committed[id] = mode
        }

        func armAfterTranscriptRead(_ hook: @escaping (String) -> Void) {
            lock.lock(); defer { lock.unlock() }
            afterTranscriptRead = hook
        }

        func sidecar(_ id: String) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            return stt[id] ?? [:]
        }

        func seedTranscript(_ id: String, object: [String: Any]) {
            lock.lock(); defer { lock.unlock() }
            transcripts[id] = object
        }
        func transcriptObject(_ id: String) -> [String: Any]? {
            lock.lock(); defer { lock.unlock() }
            return transcripts[id]
        }
        func hasTranscript(_ id: String) -> Bool {
            lock.lock(); defer { lock.unlock() }
            return transcripts[id] != nil
        }

        func updates(_ id: String) -> [[String: Any]] {
            lock.lock(); defer { lock.unlock() }
            return history.filter { $0.id == id }.map(\.patch)
        }

        func listCommitted() throws -> [[String: Any]] {
            lock.lock(); defer { lock.unlock() }
            return stt.map { ["id": $0.key, "options": ["transcriber": committed[$0.key] ?? "on-device"], "stt": $0.value] }
        }

        func transcript(_ id: String) throws -> [String: Any]? {
            lock.lock()
            let value = transcripts[id]
            let hook = afterTranscriptRead
            afterTranscriptRead = nil
            lock.unlock()
            hook?(id)
            return value
        }

        func readSidecar(_ id: String) throws -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            return ["stt": stt[id] ?? [:]]
        }

        func updateStt(_ id: String, patch: [String: Any]) throws {
            beforeUpdate?(id, patch)
            if let updateError { throw updateError }
            lock.lock(); defer { lock.unlock() }
            var merged = stt[id] ?? [:]
            for (key, value) in patch { merged[key] = value }
            stt[id] = merged
            history.append((id, patch))
        }

        func putTranscript(_ id: String, object: [String: Any]) throws {
            beforePut?(id)
            lock.lock(); defer { lock.unlock() }
            transcripts[id] = object
        }

        var beforePut: ((String) -> Void)?
    }

    private final class FakeBackend: TranscriptionBackend {
        var isChecking = false
        var session: FakeSession?
        var loadError: Error?
        func makeSession() throws -> TranscriptionSession? {
            if let loadError { throw loadError }
            return session
        }
    }

    private final class FakeSession: TranscriptionSession {
        let runPatch: [String: Any] = ["pack": "small", "engine": "parakeet"]
        private let lock = NSLock()
        private var started: [String] = []
        /// What a decode does between checkpoints; may block, may throw. Receives the id and the
        /// session's checkpoint closure.
        var decode: (String, () throws -> Void) throws -> Void = { _, _ in }

        var startedIds: [String] {
            lock.lock(); defer { lock.unlock() }
            return started
        }

        func transcribe(id: String, checkCapturing: @escaping () throws -> Void,
                        onProgress: @escaping (Int, Int) -> Void, onSegment: @escaping (Int) -> Void) throws -> [String: Any] {
            lock.lock(); started.append(id); lock.unlock()
            try decode(id, checkCapturing)
            return ["outcome": "transcribed", "noteId": id, "segments": []]
        }
    }

    private final class Recorder {
        private let lock = NSLock()
        private var items: [String] = []
        @discardableResult
        func add(_ item: String) -> Int { lock.lock(); defer { lock.unlock() }; items.append(item); return items.filter { $0 == item }.count }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
    }

    private var library: FakeLibrary!
    private var backend: FakeBackend!
    private var session: FakeSession!
    private var core: TranscriptionCore!
    private var events: Recorder!

    override func setUp() {
        library = FakeLibrary()
        backend = FakeBackend()
        session = FakeSession()
        backend.session = session
        events = Recorder()
        core = TranscriptionCore(library: library, backend: backend, label: "xyz.tinycloud.exo.stt.test.\(UUID().uuidString)")
        core.onTranscribed = { [events] id, outcome in events!.add("transcribed:\(id):\(outcome)") }
        core.onProgress = { [events] id, percent in if percent == 100 { events!.add("progress100:\(id)") } }
        core.onFailed = { [events] id, code, _ in events!.add("failed:\(id):\(code)") }
    }

    /// Waits until every task already queued on both queues has run.
    private func settle() {
        core.controlQueue.sync {}
        core.workQueue.sync {}
        core.controlQueue.sync {}
    }

    private func waitUntil(_ description: String, timeout: TimeInterval = 5, _ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { XCTFail("timed out waiting for \(description)"); return }
            Thread.sleep(forTimeInterval: 0.005)
        }
    }

    /// Blocks a decode of `id` until `release` is signalled; `entered` fires when it gets there.
    private func holdDecode(of heldId: String, entered: DispatchSemaphore, release: DispatchSemaphore,
                            thenThrow error: Error? = nil) {
        // Only the first decode of the note is held, so a decode that wrongly runs again cannot hang the test.
        let held = Recorder()
        session.decode = { id, checkpoint in
            try checkpoint()
            if id == heldId, held.add(id) == 1 {
                entered.signal()
                release.wait()
                if let error { throw error }
            }
        }
    }

    // MARK: a Local choice on a note committed to another mode survives a restart

    func testInterruptedRerunIsCancelledAndItsMarkerClearedAtLaunchRecovery() {
        for state in ["queued", "running"] {
            let id = "rerun-\(state)"
            library.seed(id, state: state)
            try? library.updateStt(id, patch: ["rerunRev": 2, "rerunBaseRev": 1, "rerunBaseHash": "old-hash"])
        }
        core.recoverInterruptedReruns()
        settle()
        for state in ["queued", "running"] {
            let sidecar = library.sidecar("rerun-\(state)")
            XCTAssertEqual(sidecar["state"] as? String, "cancelled")
            XCTAssertTrue(sidecar["rerunRev"] is NSNull)
            XCTAssertTrue(sidecar["rerunBaseRev"] is NSNull)
            XCTAssertTrue(sidecar["rerunBaseHash"] is NSNull)
        }
        XCTAssertTrue(session.startedIds.isEmpty)
    }


    private func relaunch() {
        core = TranscriptionCore(library: library, backend: backend, label: "xyz.tinycloud.exo.stt.test.\(UUID().uuidString)")
        core.onTranscribed = { [events] id, outcome in events!.add("transcribed:\(id):\(outcome)") }
    }

    func testALocalChoiceOnAnOffNoteIsResumedAfterARestartWhileTheModelIsMissing() {
        for mode in ["off", "private-cloud"] {
            let id = "note-\(mode)"
            library.seed(id, state: "waiting_for_model", committed: mode)
            backend.session = nil // the model is not usable: the attempt parks at waiting_for_model
            core.enqueue(id: id)
            settle()
            XCTAssertEqual(library.sidecar(id)["requested"] as? Bool, true)

            relaunch()
            backend.session = session // the model has arrived by the next launch
            core.reconcile()
            settle()
            XCTAssertTrue(library.hasTranscript(id), "\(mode)")
            XCTAssertEqual(library.sidecar(id)["state"] as? String, "done")
        }
    }

    func testALocalChoiceThatWasRunningWhenTheAppDiedIsResumed() {
        library.seed("a", state: "running", committed: "off")
        try? library.updateStt("a", patch: ["requested": true])
        core.reconcile()
        settle()
        XCTAssertTrue(library.hasTranscript("a"))
    }

    func testAnOffNoteNobodyChoseLocalForIsNotResumed() {
        library.seed("a", state: "running", committed: "off")
        library.seed("b", state: "waiting_for_model", committed: "private-cloud")
        core.reconcile()
        settle()
        XCTAssertEqual(session.startedIds, [])
        XCTAssertFalse(library.hasTranscript("a"))
    }

    func testAnEnqueueThatCannotWriteTheNoteReportsFailureAndLeavesNothingQueued() {
        struct Gone: Error {}
        library.seed("a", state: "failed", committed: "off")
        library.updateError = Gone()
        var outcome: String?
        let finished = DispatchSemaphore(value: 0)
        core.enqueue(id: "a", accepted: { _ in outcome = "accepted"; finished.signal() }, failed: { _ in outcome = "failed"; finished.signal() })
        XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
        settle()
        XCTAssertEqual(outcome, "failed")
        XCTAssertTrue(core.queueSnapshot().isEmpty)
        library.updateError = nil
        core.enqueue(id: "a") // the reservation was released: a retry is accepted
        settle()
        XCTAssertTrue(library.hasTranscript("a"))
    }

    // MARK: finding 1 — a cancel during the final decode

    func testACancelDuringTheFinalDecodeWinsAndNothingIsPublished() {
        library.seed("a", state: "queued")
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release) // returns normally: the "flush" finished
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)

        core.cancel(id: "a")
        waitUntil("cancel accepted") { core.state.isCancelRequested("a") }
        release.signal()
        settle()

        XCTAssertFalse(library.hasTranscript("a"))
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "cancelled")
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 0)
        XCTAssertEqual(events.all, [])
        XCTAssertTrue(core.queueSnapshot().isEmpty)
    }

    func testACancelOnceThePublicationHasBegunIsTooLateAndTheNoteFinishesDone() {
        library.seed("a", state: "queued")
        let putEntered = DispatchSemaphore(value: 0), putRelease = DispatchSemaphore(value: 0)
        library.beforePut = { _ in putEntered.signal(); putRelease.wait() }
        core.enqueue(id: "a")
        XCTAssertEqual(putEntered.wait(timeout: .now() + 5), .success)

        core.cancel(id: "a")
        core.controlQueue.sync {}
        putRelease.signal()
        settle()

        XCTAssertTrue(library.hasTranscript("a"))
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "done")
        XCTAssertEqual(events.all, ["progress100:a", "transcribed:a:transcribed"])
    }

    // MARK: finding 2 — a cancel during the capture rollback

    func testACancelAcceptedWhileTheCaptureRollbackIsWrittenIsNotLostWhenCaptureEnds() {
        library.seed("a", state: "queued")
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let calls = Recorder()
        session.decode = { id, checkpoint in
            try checkpoint()
            guard calls.add(id) == 1 else { return }
            entered.signal()
            release.wait()
            try checkpoint() // capture is active by now: the decode yields
        }
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)

        // Hold the write that rolls the sidecar back to `queued`.
        let rollbackEntered = DispatchSemaphore(value: 0), rollbackRelease = DispatchSemaphore(value: 0)
        library.beforeUpdate = { _, patch in
            if patch["state"] as? String == "queued" { rollbackEntered.signal(); rollbackRelease.wait() }
        }
        core.captureStarted()
        release.signal()
        XCTAssertEqual(rollbackEntered.wait(timeout: .now() + 5), .success)

        core.cancel(id: "a")
        waitUntil("cancel accepted") { core.state.isCancelRequested("a") }
        library.beforeUpdate = nil
        rollbackRelease.signal()
        core.captureEnded()
        settle()

        XCTAssertEqual(session.startedIds, ["a"], "the cancelled note must not decode again")
        XCTAssertFalse(library.hasTranscript("a"))
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "cancelled")
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 0)
        XCTAssertTrue(core.queueSnapshot().isEmpty)
    }

    func testAnUncancelledYieldStillRequeuesAndResumesAfterCapture() {
        library.seed("a", state: "queued")
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release, thenThrow: TranscriptionQueueError.captureStarted)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        core.captureStarted()
        session.decode = { _, _ in }
        release.signal()
        waitUntil("requeued") { core.queueSnapshot().first?["state"] as? String == "queued" }
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "queued")
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 0)

        core.captureEnded()
        waitUntil("finished after capture") { library.hasTranscript("a") }
        settle()
        XCTAssertEqual(session.startedIds, ["a", "a"])
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "done")
    }

    func testACancelledYieldIsNotReAddedByAScanBeforeItsCancelledStateIsDurable() {
        library.seed("a", state: "queued")
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let calls = Recorder()
        session.decode = { id, checkpoint in
            try checkpoint()
            guard calls.add(id) == 1 else { return }
            entered.signal()
            release.wait()
            try checkpoint()
        }
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)

        // Hold the rollback write so the cancel is accepted first, then the final `cancelled` write.
        let rollbackEntered = DispatchSemaphore(value: 0), rollbackRelease = DispatchSemaphore(value: 0)
        let cancelledEntered = DispatchSemaphore(value: 0), cancelledRelease = DispatchSemaphore(value: 0)
        library.beforeUpdate = { _, patch in
            switch patch["state"] as? String {
            case "queued": rollbackEntered.signal(); rollbackRelease.wait()
            case "cancelled": cancelledEntered.signal(); cancelledRelease.wait()
            default: break
            }
        }
        core.captureStarted()
        release.signal()
        XCTAssertEqual(rollbackEntered.wait(timeout: .now() + 5), .success)
        core.cancel(id: "a")
        waitUntil("cancel accepted") { core.state.isCancelRequested("a") }
        rollbackRelease.signal()
        XCTAssertEqual(cancelledEntered.wait(timeout: .now() + 5), .success)

        // The sidecar still says `queued`; a scan starting now must not take the note back.
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "queued")
        core.reconcile()
        core.controlQueue.sync {}
        XCTAssertEqual(core.queueSnapshot().map { $0["state"] as? String }, ["running"], "only the worker's own, still-owned note")

        library.beforeUpdate = nil
        cancelledRelease.signal()
        core.captureEnded()
        settle()
        XCTAssertEqual(session.startedIds, ["a"])
        XCTAssertFalse(library.hasTranscript("a"))
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "cancelled")
        XCTAssertTrue(core.queueSnapshot().isEmpty)
    }

    func testAModelLoadFailureNoteIsNotReAddedByAScanBeforeItsFailureIsDurable() {
        library.seed("a", state: "queued")
        backend.loadError = TranscriptionQueueError.modelFilesMissing
        let failedEntered = DispatchSemaphore(value: 0), failedRelease = DispatchSemaphore(value: 0)
        library.beforeUpdate = { _, patch in
            if patch["state"] as? String == "failed" { failedEntered.signal(); failedRelease.wait() }
        }
        core.enqueue(id: "a")
        XCTAssertEqual(failedEntered.wait(timeout: .now() + 5), .success)

        core.reconcile()
        core.controlQueue.sync {}
        XCTAssertEqual(core.queueSnapshot().count, 0, "the failing note must not be queued again")

        library.beforeUpdate = nil
        failedRelease.signal()
        settle()
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "failed")
        XCTAssertEqual(session.startedIds, [])
        XCTAssertEqual(events.all, ["failed:a:model_load_failed"])
    }

    // MARK: waiting_for_model must not undo a cancel

    func testALateWaitingForModelWriteDoesNotUndoACancelAndNoLaterScanRestartsTheNote() {
        library.seed("a", state: "queued")
        backend.session = nil // no usable model
        let waitingEntered = DispatchSemaphore(value: 0), waitingRelease = DispatchSemaphore(value: 0)
        library.beforeUpdate = { _, patch in
            if patch["state"] as? String == "waiting_for_model" { waitingEntered.signal(); waitingRelease.wait() }
        }
        core.enqueue(id: "a")
        XCTAssertEqual(waitingEntered.wait(timeout: .now() + 5), .success)

        core.cancel(id: "a") // accepted while the waiting-state write is in flight
        library.beforeUpdate = nil
        waitingRelease.signal()
        settle()
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "cancelled")
        XCTAssertTrue(core.queueSnapshot().isEmpty)

        // The model becomes usable and a download-complete reconcile runs.
        backend.session = session
        core.reconcile()
        settle()
        XCTAssertEqual(session.startedIds, [])
        XCTAssertFalse(library.hasTranscript("a"))
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "cancelled")
    }

    // MARK: a stale waiting_for_model write must not replace a newer state

    /// Holds the pending note `a`'s `waiting_for_model` publication after it was admitted and returns
    /// the signal that lets it land.
    private func holdWaitingPublication() -> DispatchSemaphore {
        library.seed("a", state: "queued")
        backend.session = nil // no usable model
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        library.beforeUpdate = { _, patch in
            if patch["state"] as? String == "waiting_for_model" { entered.signal(); release.wait() }
        }
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        library.beforeUpdate = nil
        return release
    }

    func testAHeldWaitingWriteDoesNotUndoAModelLoadFailureAndNoLaterScanRestartsTheNote() {
        let release = holdWaitingPublication()
        backend.loadError = TranscriptionQueueError.modelFilesMissing
        core.kickWorker() // a direct worker wakeup (e.g. capture ended) whose model load now throws
        Thread.sleep(forTimeInterval: 0.2) // lets the failing pass run ahead of the held write, if it can
        release.signal()
        settle()

        XCTAssertEqual(library.sidecar("a")["state"] as? String, "failed")
        XCTAssertEqual(library.sidecar("a")["error"] as? String, "model_load_failed")
        XCTAssertEqual(events.all, ["failed:a:model_load_failed"])

        backend.loadError = nil
        backend.session = session
        core.reconcile()
        settle()
        XCTAssertEqual(session.startedIds, [], "a failed note is only restarted by an explicit retry")
        XCTAssertFalse(library.hasTranscript("a"))
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "failed")
    }

    func testAHeldWaitingWriteNeverOverwritesRunningOrDone() {
        let release = holdWaitingPublication()
        backend.session = session
        let entered = DispatchSemaphore(value: 0), decodeRelease = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: decodeRelease)
        core.kickWorker() // the model arrived; the note is up next while the old write is still in flight
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(session.startedIds, [], "the note must not start in the middle of a status write meant for it")

        release.signal()
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "running")

        decodeRelease.signal()
        settle()
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "done")
        XCTAssertTrue(library.hasTranscript("a"))
        let states = library.updates("a").compactMap { $0["state"] as? String }
        XCTAssertEqual(states, ["queued", "waiting_for_model", "running", "done"])
    }

    func testACancelNeverOverwritesAFinalState() {
        library.seed("failed", state: "failed", attempts: 3)
        library.seed("interrupted", state: "running", attempts: 1)
        core.cancel(id: "failed")
        core.cancel(id: "interrupted")
        settle()
        XCTAssertEqual(library.sidecar("failed")["state"] as? String, "failed")
        XCTAssertEqual(library.sidecar("interrupted")["state"] as? String, "cancelled", "an unfinished note nobody is working on can be cancelled")
    }

    func testACancelOfANoteBeingFailedLeavesTheFailureToItsOwner() {
        library.seed("a", state: "queued")
        backend.loadError = TranscriptionQueueError.modelFilesMissing
        let failedEntered = DispatchSemaphore(value: 0), failedRelease = DispatchSemaphore(value: 0)
        library.beforeUpdate = { _, patch in
            if patch["state"] as? String == "failed" { failedEntered.signal(); failedRelease.wait() }
        }
        core.enqueue(id: "a")
        XCTAssertEqual(failedEntered.wait(timeout: .now() + 5), .success)

        core.cancel(id: "a")
        core.controlQueue.sync {}
        library.beforeUpdate = nil
        failedRelease.signal()
        settle()
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "failed")
        XCTAssertEqual(events.all, ["failed:a:model_load_failed"])
    }

    func testPendingNotesWaitingForAModelAreStoredAsSuchAndRunOnceItArrives() {
        library.seed("a", state: "queued")
        backend.session = nil
        core.enqueue(id: "a")
        waitUntil("waiting state stored") { library.sidecar("a")["state"] as? String == "waiting_for_model" }
        XCTAssertEqual(core.queueSnapshot().first?["state"] as? String, "waiting_for_model")

        backend.session = session
        core.reconcile()
        waitUntil("decoded") { library.hasTranscript("a") }
        settle()
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "done")
    }

    // MARK: finding 3 — a stale reconcile scan

    private func staleScan(finishingWith error: Error?, expectedState: String) {
        library.seed("a", state: "queued")
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release, thenThrow: error)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)

        if error == nil { // the cancel is accepted first; the decode only notices it later
            core.cancel(id: "a")
            waitUntil("cancel accepted") { core.state.isCancelRequested("a") }
        }
        // A scan reads the note as `running` with no transcript, then stalls before adding it.
        let scanRead = DispatchSemaphore(value: 0), scanRelease = DispatchSemaphore(value: 0)
        library.armAfterTranscriptRead { _ in scanRead.signal(); scanRelease.wait() }
        core.reconcile()
        XCTAssertEqual(scanRead.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "running")

        // Meanwhile the note reaches its final state and the worker moves on.
        release.signal()
        waitUntil("final state") { library.sidecar("a")["state"] as? String == expectedState }
        waitUntil("worker idle") { core.queueSnapshot().isEmpty }

        scanRelease.signal()
        settle()
        XCTAssertEqual(session.startedIds, ["a"], "a stale scan must not start another decode")
        XCTAssertEqual(library.sidecar("a")["state"] as? String, expectedState)
        XCTAssertTrue(core.queueSnapshot().isEmpty)
    }

    func testAStaleScanDoesNotRestartANoteThatWasCancelledMeanwhile() {
        staleScan(finishingWith: nil, expectedState: "cancelled")
    }

    func testAStaleScanDoesNotRestartANoteThatFailedMeanwhile() {
        staleScan(finishingWith: TranscriptionQueueError.decodeFailed, expectedState: "failed")
    }

    func testALaterScanStillPicksUpAnUnfinishedNote() {
        library.seed("a", state: "running", attempts: 1)
        core.reconcile()
        waitUntil("decoded") { library.hasTranscript("a") }
        settle()
        XCTAssertEqual(session.startedIds, ["a"])
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 2)
    }

    // MARK: finding 4 — a duplicate enqueue

    func testADuplicateEnqueueDuringAnAttemptLeavesItsDurableStateAlone() {
        library.seed("a", state: "running", attempts: 2)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release)
        core.reconcile()
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "running")
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 3)

        core.enqueue(id: "a")
        core.controlQueue.sync {}
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "running")
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 3)
        XCTAssertEqual(core.queueSnapshot().map { $0["id"] as? String }, ["a"])

        release.signal()
        settle()
        XCTAssertEqual(session.startedIds, ["a"])
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "done")
    }

    func testADuplicateEnqueueOfAPendingNoteKeepsItsSidecar() {
        library.seed("a", state: "queued")
        library.seed("b", state: "queued", attempts: 2)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        core.reconcile() // b is pending behind the running a
        waitUntil("b pending") { core.queueSnapshot().count == 2 }

        core.enqueue(id: "b")
        core.controlQueue.sync {}
        XCTAssertEqual(library.sidecar("b")["attempts"] as? Int, 2)
        XCTAssertEqual(core.queueSnapshot().count, 2)
        release.signal()
        settle()
    }

    func testAnExplicitRetryOfAFailedNoteResetsItAndRunsIt() {
        library.seed("a", state: "failed", attempts: 3)
        core.enqueue(id: "a")
        waitUntil("decoded") { library.hasTranscript("a") }
        settle()
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 1)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "done")
    }
    func testExplicitRerunCommitsRequestedRevisionAndIsNotResumable() {
        library.seed("a", state: "done")
        library.seedTranscript("a", object: ["rev": 4, "body": "old"])
        core.enqueueAgain(id: "a", rev: 5, baseRev: 4, baseHash: "base-hash")
        waitUntil("rerun decoded") { session.startedIds == ["a"] && library.transcriptObject("a")?["rev"] as? Int == 5 }
        settle()
        XCTAssertEqual(library.transcriptObject("a")?["rev"] as? Int, 5)
        let rerunBase = library.transcriptObject("a")?["rerunBase"] as? [String: Any]
        XCTAssertEqual(rerunBase?["rev"] as? Int, 4)
        XCTAssertEqual(rerunBase?["hash"] as? String, "base-hash")
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "done")
        XCTAssertFalse(ResumableWork.owed(["id": "a", "options": ["transcriber": "on-device"],
            "stt": ["state": "queued", "rerunRev": 5]]))
    }

    func testFailedExplicitRerunLeavesTheCommittedTranscriptUntouched() {
        library.seed("a", state: "done")
        library.seedTranscript("a", object: ["rev": 4, "body": "old"])
        session.decode = { _, _ in throw TranscriptionQueueError.decodeFailed }
        core.enqueueAgain(id: "a", rev: 5, baseRev: 4, baseHash: "base-hash")
        waitUntil("rerun failed") { events.all.contains("failed:a:decode_failed") }
        settle()
        XCTAssertEqual(library.transcriptObject("a")?["rev"] as? Int, 4)
        XCTAssertEqual(library.transcriptObject("a")?["body"] as? String, "old")
    }


    func testEnqueueOfANoteThatAlreadyHasATranscriptLeavesItDone() {
        library.seed("a", state: "queued")
        core.enqueue(id: "a")
        waitUntil("decoded") { library.hasTranscript("a") }
        settle()
        let updatesBefore = library.updates("a").count
        core.enqueue(id: "a")
        core.cancel(id: "a")
        settle()
        XCTAssertEqual(library.updates("a").count, updatesBefore)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "done")
    }

    // MARK: the freeze guarantee

    func testSnapshotEnqueueAndCancelStayPromptWhileADecodeIsHeld() {
        library.seed("a", state: "queued")
        library.seed("b", state: "queued")
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)

        let startedAt = DispatchTime.now()
        core.enqueue(id: "b")
        core.cancel(id: "b")
        core.controlQueue.sync {}
        let snapshot = core.queueSnapshot()
        let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
        XCTAssertLessThan(elapsedMs, 500)
        XCTAssertEqual(snapshot.map { $0["id"] as? String }, ["a"])
        XCTAssertEqual(snapshot.first?["state"] as? String, "running")
        release.signal()
        settle()
    }
}
