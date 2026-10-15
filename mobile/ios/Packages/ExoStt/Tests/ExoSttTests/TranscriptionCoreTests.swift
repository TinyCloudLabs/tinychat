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
        private var durations: [String: Int] = [:]
        var updateError: Error?
        private var transcripts: [String: [String: Any]] = [:]
        /// Runs (outside the lock) before a matching `updateStt` is applied, to hold it.
        var beforeUpdate: ((String, [String: Any]) -> Void)?
        /// One-shot, runs inside the next `transcript(_:)` read, after the read, to hold it.
        private var afterTranscriptRead: ((String) -> Void)?
        private var history: [(id: String, patch: [String: Any])] = []

        func seed(_ id: String, state: String, attempts: Int = 0, committed mode: String = "on-device", durationMs: Int = 15_000) {
            lock.lock(); defer { lock.unlock() }
            stt[id] = ["state": state, "attempts": attempts]
            committed[id] = mode
            durations[id] = durationMs
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
            return ["stt": stt[id] ?? [:], "durationMs": durations[id] ?? 0]
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

        func updateRunning(_ id: String, generation: Int, patch: [String: Any],
                           stillValid: () -> Bool) throws {
            lock.lock(); defer { lock.unlock() }
            guard stillValid(), stt[id]?["state"] as? String == "running",
                  stt[id]?["yieldGeneration"] as? Int == generation else { return }
            stt[id]?.merge(patch) { _, newer in newer }
        }


        func yieldToOS(_ id: String, generation: Int, attempts: Int, stillValid: () -> Bool) throws -> Bool {
            beforeUpdate?(id, ["state": "yielded_by_os"])
            if let updateError { throw updateError }
            lock.lock(); defer { lock.unlock() }
            guard stillValid(), stt[id]?["state"] as? String == "running",
                  stt[id]?["yieldGeneration"] as? Int == generation else { return false }
            stt[id]?["state"] = "yielded_by_os"
            stt[id]?["attempts"] = attempts
            history.append((id, ["state": "yielded_by_os", "attempts": attempts]))
            return true
        }

        func commitTranscript(_ id: String, generation: Int, object: [String: Any],
                              stillValid: () -> Bool) throws -> Bool {
            beforePut?(id)
            lock.lock(); defer { lock.unlock() }
            guard stillValid(), stt[id]?["state"] as? String == "running",
                  stt[id]?["yieldGeneration"] as? Int == generation else { return false }
            transcripts[id] = object
            stt[id]?["state"] = "done"
            stt[id]?["error"] = NSNull()
            history.append((id, ["state": "done"]))
            return true
        }

        var beforePut: ((String) -> Void)?
    }

    private final class FakeActivity: TranscriptionActivity {
        private let lock = NSLock()
        var allowed = true
        var expireOnBegin = false
        private var expiry: (() -> Void)?
        private(set) var begins = 0
        private(set) var ends = 0
        var onEnd: (() -> Void)?

        func begin(expired: @escaping () -> Void) -> Bool {
            lock.withLock { begins += 1; expiry = expired }
            if expireOnBegin { expired() }
            return allowed
        }
        func end() {
            lock.withLock { ends += 1 }
            onEnd?()
        }
        func expire() { let callback = lock.withLock { expiry }; callback?() }
    }

    private final class FakeClock {
        private let lock = NSLock()
        private var date = Date(timeIntervalSince1970: 100)
        func now() -> Date { lock.withLock { date } }
        func advance(_ seconds: TimeInterval) { lock.withLock { date.addTimeInterval(seconds) } }
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

    func testYieldedJobRemainsOwedAndKeepsItsPriorAttemptBudget() {
        let note: [String: Any] = ["id": "a", "options": ["transcriber": "on-device"],
            "stt": ["state": "yielded_by_os", "attempts": 2, "yieldGeneration": 7]]
        XCTAssertTrue(ResumableWork.owed(note))
        XCTAssertEqual(AttemptGuard.next(previousAttempts: 2), .proceed(attempt: 3))
    }

    private func withActivity(_ activity: FakeActivity, expiryBudget: TimeInterval = 1,
                              clock: @escaping () -> Date = Date.init) {
        core = TranscriptionCore(library: library, backend: backend, activity: { activity },
            clock: clock, expiryBudget: expiryBudget,
            label: "xyz.tinycloud.exo.stt.activity.\(UUID().uuidString)")
        core.onTranscribed = { [events] id, outcome in events!.add("transcribed:\(id):\(outcome)") }
    }

    func testExpiryDuringCheckpointFreeFinalizationPersistsBeforeReleaseAndFencesLateResult() {
        library.seed("a", state: "queued")
        let activity = FakeActivity()
        activity.onEnd = { [library] in
            XCTAssertEqual(library!.sidecar("a")["state"] as? String, "yielded_by_os")
            XCTAssertEqual(library!.sidecar("a")["attempts"] as? Int, 0)
        }
        withActivity(activity)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        activity.expire()
        XCTAssertEqual(activity.ends, 1)
        release.signal()
        settle()
        XCTAssertFalse(library.hasTranscript("a"))
        XCTAssertEqual(session.startedIds, ["a"])
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "yielded_by_os")
        XCTAssertTrue(core.queueSnapshot().isEmpty)
        relaunch()
        core.reconcile()
        settle()
        XCTAssertEqual(session.startedIds, ["a", "a"])
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 1)
        XCTAssertTrue(library.hasTranscript("a"))
    }

    func testFailedExpiryPersistenceRetainsCrashAttemptAndFencesResult() {
        library.seed("a", state: "queued")
        let activity = FakeActivity()
        withActivity(activity)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        library.updateError = TranscriptionQueueError.decodeFailed
        activity.expire()
        XCTAssertEqual(activity.ends, 1)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "running")
        release.signal()
        settle()
        XCTAssertFalse(library.hasTranscript("a"))
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 1)
        library.updateError = nil
        relaunch()
        core.reconcile()
        settle()
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 2)
    }

    func testInvalidAssertionAcquisitionNeverEndsInvalidTask() {
        library.seed("a", state: "queued")
        let activity = FakeActivity()
        activity.allowed = false
        withActivity(activity)
        core.enqueue(id: "a")
        settle()
        XCTAssertTrue(library.hasTranscript("a"))
        XCTAssertEqual(activity.ends, 0)
    }

    func testExpiryDuringAssertionAcquisitionYieldsBeforeDecode() {
        library.seed("a", state: "queued")
        let activity = FakeActivity()
        activity.expireOnBegin = true
        withActivity(activity)
        core.enqueue(id: "a")
        waitUntil("assertion released") { activity.ends == 1 }
        settle()
        XCTAssertEqual(activity.begins, 1)
        XCTAssertEqual(activity.ends, 1)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "yielded_by_os")
        XCTAssertFalse(library.hasTranscript("a"))
    }

    func testLongDecodeDoesNotAcquireShortBackgroundAssertion() {
        library.seed("long", state: "queued", durationMs: 30_001)
        let activity = FakeActivity()
        withActivity(activity)
        core.enqueue(id: "long")
        settle()
        XCTAssertTrue(library.hasTranscript("long"))
        XCTAssertEqual(activity.begins, 0)
        XCTAssertEqual(activity.ends, 0)
    }

    func testCancelAcceptedBeforeExpiryWinsWithoutPublishing() {
        library.seed("a", state: "queued")
        let activity = FakeActivity()
        withActivity(activity)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        core.cancel(id: "a")
        waitUntil("cancel accepted") { core.state.isCancelRequested("a") }
        activity.expire()
        release.signal()
        settle()
        XCTAssertFalse(library.hasTranscript("a"))
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "cancelled")
        XCTAssertEqual(activity.ends, 1)
    }

    func testAssertionEndsOnceAfterNormalCommitAndDecodeError() {
        for throwsError in [false, true] {
            let id = throwsError ? "error" : "success"
            library.seed(id, state: "queued")
            let activity = FakeActivity()
            withActivity(activity)
            if throwsError {
                session.decode = { _, _ in throw TranscriptionQueueError.decodeFailed }
            } else {
                session.decode = { _, _ in }
                activity.onEnd = { [library] in
                    XCTAssertEqual(library!.sidecar(id)["state"] as? String, "done")
                    XCTAssertNotNil(library!.transcriptObject(id))
                }
            }
            core.enqueue(id: id)
            settle()
            XCTAssertEqual(activity.ends, 1)
            XCTAssertEqual(library.sidecar(id)["state"] as? String, throwsError ? "failed" : "done")
            activity.expire()
            XCTAssertEqual(activity.ends, 1)
        }
    }

    func testWorkerCannotReleaseAssertionBeforeExpiryStorageFinishes() {
        library.seed("a", state: "queued")
        let activity = FakeActivity()
        withActivity(activity)
        let decodeEntered = DispatchSemaphore(value: 0), decodeRelease = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: decodeEntered, release: decodeRelease)
        core.enqueue(id: "a")
        XCTAssertEqual(decodeEntered.wait(timeout: .now() + 5), .success)
        let writeEntered = DispatchSemaphore(value: 0), writeRelease = DispatchSemaphore(value: 0)
        library.beforeUpdate = { _, patch in
            if patch["state"] as? String == "yielded_by_os" { writeEntered.signal(); writeRelease.wait() }
        }
        let expiryFinished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { activity.expire(); expiryFinished.signal() }
        XCTAssertEqual(writeEntered.wait(timeout: .now() + 5), .success)
        decodeRelease.signal()
        settle()
        XCTAssertEqual(activity.ends, 0)
        library.beforeUpdate = nil
        writeRelease.signal()
        XCTAssertEqual(expiryFinished.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(activity.ends, 1)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "yielded_by_os")
    }

    func testTimedOutPersistenceCannotLaterClaimAnOrderlyYield() {
        library.seed("a", state: "queued")
        let activity = FakeActivity()
        withActivity(activity, expiryBudget: 0.05)
        let decodeEntered = DispatchSemaphore(value: 0), decodeRelease = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: decodeEntered, release: decodeRelease)
        core.enqueue(id: "a")
        XCTAssertEqual(decodeEntered.wait(timeout: .now() + 5), .success)
        let writeEntered = DispatchSemaphore(value: 0), writeRelease = DispatchSemaphore(value: 0)
        library.beforeUpdate = { _, patch in
            if patch["state"] as? String == "yielded_by_os" { writeEntered.signal(); writeRelease.wait() }
        }
        let expiryFinished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { activity.expire(); expiryFinished.signal() }
        XCTAssertEqual(writeEntered.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(expiryFinished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(activity.ends, 1)
        library.beforeUpdate = nil
        writeRelease.signal()
        decodeRelease.signal()
        settle()
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "running")
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 1)
        XCTAssertFalse(library.hasTranscript("a"))
    }

    func testClockDeadlineRejectsLateYieldEvenBeforeSemaphoreTimeout() {
        library.seed("a", state: "queued")
        let activity = FakeActivity()
        let clock = FakeClock()
        withActivity(activity, clock: { clock.now() })
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        library.beforeUpdate = { _, patch in
            if patch["state"] as? String == "yielded_by_os" { clock.advance(2) }
        }
        activity.expire()
        release.signal()
        settle()
        XCTAssertEqual(activity.ends, 1)
        XCTAssertEqual(library.sidecar("a")["state"] as? String, "running")
        XCTAssertEqual(library.sidecar("a")["attempts"] as? Int, 1)
        XCTAssertFalse(library.hasTranscript("a"))
    }

    func testOSYieldDoesNotRepumpAnotherNoteAfterTwoSeconds() {
        library.seed("a", state: "queued")
        library.seed("b", state: "queued")
        let activity = FakeActivity()
        withActivity(activity)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        holdDecode(of: "a", entered: entered, release: release)
        core.enqueue(id: "a")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        core.enqueue(id: "b")
        core.controlQueue.sync {}
        activity.expire()
        release.signal()
        settle()
        Thread.sleep(forTimeInterval: 2.1)
        settle()
        XCTAssertEqual(session.startedIds, ["a"])
        XCTAssertFalse(library.hasTranscript("b"))
        core.reconcile() // A new foreground opportunity admits the owed job.
        settle()
        XCTAssertTrue(library.hasTranscript("b"))
    }

    // MARK: a Local choice on a note committed to another mode survives a restart

    func testInterruptedRerunIsCancelledAndItsMarkerClearedAtLaunchRecovery() {
        for state in ["queued", "running", "waiting_for_model", "yielded_by_os"] {
            let id = "rerun-\(state)"
            library.seed(id, state: state)
            try? library.updateStt(id, patch: ["rerunRev": 2, "rerunBaseRev": 1, "rerunBaseHash": "old-hash"])
        }
        core.recoverInterruptedReruns()
        settle()
        for state in ["queued", "running", "waiting_for_model", "yielded_by_os"] {
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
