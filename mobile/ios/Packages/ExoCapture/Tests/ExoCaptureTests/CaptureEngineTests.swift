import AVFoundation
import CaptureCore
import XCTest
@testable import ExoCapture

@MainActor final class CaptureEngineTests: XCTestCase {
    private final class TestClock: CaptureClock {
        private let lock = NSLock()
        private var value: Int64 = 1_700_000_000_000

        func nowMilliseconds() -> Int64 {
            lock.lock(); defer { lock.unlock() }
            return value
        }

        func advance(by milliseconds: Int64) {
            lock.lock(); defer { lock.unlock() }
            value += milliseconds
        }
    }

    private func withEngine(clock: CaptureClock = SystemCaptureClock(),
                            _ body: (CaptureEngine) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-engine-\(UUID().uuidString)")
        let engine = try CaptureEngine(testRoot: root, clock: clock)
        engine.debugForeground = true
        defer {
            _ = try? engine.discard()
            try? FileManager.default.removeItem(at: root)
        }
        try body(engine)
    }

    /// Device engines would deliver live mic taps, so they are suppressed. The Debug simulator engine
    /// uses a manually driven silent source that delivers nothing until `deliverTap` is called.
    private func suppressLiveTaps(_ engine: CaptureEngine) {
        #if !targetEnvironment(simulator)
        engine.debugSuppressTaps()
        #endif
    }

    private func deliverTap(_ engine: CaptureEngine) {
        #if targetEnvironment(simulator)
        engine.debugDeliverSilentTaps(1)
        XCTAssertTrue(engine.debugSilentInputRunning)
        #else
        engine.debugRecordDeliveredTap()
        #endif
    }

    private func events(_ engine: CaptureEngine, _ id: String) throws -> [[String: Any]] {
        try engine.library.readJournal(id)
    }

    private func segmentCount(_ engine: CaptureEngine, _ id: String) throws -> Int {
        try events(engine, id).filter { $0["e"] as? String == "segment" }.count
    }

    private func enqueueTone(_ engine: CaptureEngine, buffers: Int = 8) throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        for batch in 0..<buffers {
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096))
            buffer.frameLength = 4096
            let samples = try XCTUnwrap(buffer.floatChannelData?[0])
            for frame in 0..<4096 {
                samples[frame] = 0.2 * sin(Float(2 * Double.pi * 440 * Double(batch * 4096 + frame) / 48_000))
            }
            try engine.debugEnqueue(buffer)
        }
    }

    func testColdStartUsesOnlyDurableAccountStatus() throws {
        for status in ["transitioning", "signed_out"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-account-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: root) }
            let first = try CaptureEngine(testRoot: root)
            try first.library.setAccountState(CaptureAccountState(status: status,
                accountDid: status == "transitioning" ? "did:test" : nil, transitionGen: 4,
                options: CaptureOptions(transcriber: "assemblyai")))
            let cold = try CaptureEngine(testRoot: root)
            cold.debugForeground = true
            let id = try XCTUnwrap(cold.start()["id"] as? String)
            XCTAssertNil(cold.status()["owner"] as? String)
            XCTAssertEqual((cold.status()["options"] as? [String: Any])?["transcriber"] as? String, "on-device")
            let session = try cold.library.readJournal(id).first
            XCTAssertTrue(session?["owner"] == nil || session?["owner"] is NSNull)
            _ = try cold.discard()
        }
    }

    func testPreferenceWriteKeepsTransitioningStatusAndDid() throws {
        try withEngine { engine in
            try engine.library.setAccountState(CaptureAccountState(status: "transitioning", accountDid: "did:test",
                transitionGen: 5, options: CaptureOptions(transcriber: "assemblyai")))
            _ = try engine.setDefaults(CaptureDefaults(accountDid: nil, transitionGen: 5,
                transcriber: "on-device", identifySpeakers: true))
            XCTAssertEqual(try engine.accountState().status, "transitioning")
            XCTAssertEqual(try engine.accountState().accountDid, "did:test")
        }
    }

    func testAccountDebugFailureTargetsOnlyRequestedHandoffWrite() throws {
        try withEngine { engine in
            let key = "exo.debug.failAccountState"
            defer { UserDefaults.standard.removeObject(forKey: key) }
            UserDefaults.standard.set("3", forKey: key)
            try engine.setAccountState(status: "transitioning", accountDid: "did:test", transitionGen: 1)
            XCTAssertThrowsError(try engine.setAccountState(status: "signed_out", accountDid: nil, transitionGen: 2))
            XCTAssertEqual(try engine.accountState().status, "transitioning")
            UserDefaults.standard.set("compensation", forKey: key)
            XCTAssertThrowsError(try engine.setAccountState(status: "signed_in", accountDid: "did:test", transitionGen: 2))
            UserDefaults.standard.set("1", forKey: key)
            try engine.setAccountState(status: "signed_in", accountDid: "did:test", transitionGen: 2)
            XCTAssertThrowsError(try engine.setAccountState(status: "transitioning", accountDid: "did:test", transitionGen: 3))
        }
    }

    func testStopKeepsLiveMarkWhileRecoveryRacesAtStageBegin() throws {
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            try enqueueTone(engine)
            let entered = expectation(description: "commit reached stage.begin")
            let completed = expectation(description: "stop committed")
            let release = DispatchSemaphore(value: 0)
            var sttWakeups = 0
            engine.captureSessionEnded = { sttWakeups += 1 }
            engine.library.gate = { point in
                if point == "stage.begin" {
                    entered.fulfill()
                    _ = release.wait(timeout: .now() + 5)
                }
            }
            var recovered = false
            let token = engine.observe { name, _, _ in if name == "recovered" || name == "recoveryFailed" { recovered = true } }
            engine.stop { result in
                if case .success(let note) = result {
                    XCTAssertEqual(note["recovered"] as? Bool, false)
                } else { XCTFail("Stop failed: \(result)") }
                completed.fulfill()
            }
            wait(for: [entered], timeout: 5)
            XCTAssertEqual(sttWakeups, 0, "STT must wait for the committed audio")
            XCTAssertThrowsError(try engine.retryRecovery(id)) {
                XCTAssertEqual($0 as? CaptureError, .recordingInProgress)
            }
            release.signal()
            wait(for: [completed], timeout: 10)
            XCTAssertEqual(sttWakeups, 1)
            XCTAssertFalse(recovered)
            XCTAssertEqual(try engine.library.listCommitted().filter { $0["id"] as? String == id }.count, 1)
            engine.removeObserver(token)
        }
    }

    func testParkedPauseIsAdoptedThenTimesOutOnNextLaunch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-parked-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = TestClock()
        let first = try CaptureEngine(testRoot: root, clock: clock)
        first.debugForeground = true
        let id = try XCTUnwrap(first.start()["id"] as? String)
        try enqueueTone(first)
        try first.pause()
        clock.advance(by: 5_000)
        try first.library.appendJournal(id, ["e": "options", "t": clock.nowMilliseconds(), "a": 0,
                                             "transcriber": "on-device", "identifySpeakers": false])
        let resumed = try CaptureEngine(testRoot: root, clock: clock)
        resumed.debugForeground = true
        resumed.recoverOnce()
        let adopted = expectation(description: "parked session adopted")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            XCTAssertEqual(resumed.status()["id"] as? String, id)
            XCTAssertEqual(resumed.status()["state"] as? String, "paused")
            XCTAssertEqual(resumed.status()["pausedMs"] as? Int64, 5_000)
            adopted.fulfill()
        }
        wait(for: [adopted], timeout: 5)
        clock.advance(by: 3_600_001)
        let expired = try CaptureEngine(testRoot: root, clock: clock)
        expired.recoverOnce()
        try expired.awaitRecovery()
        let saved = try expired.library.readSidecar(id)
        XCTAssertEqual(saved["exitReason"] as? String, "pause_timeout")
        XCTAssertEqual(saved["endedUnexpectedly"] as? Bool, false)
    }

    func testFirstAudioAndCaptureStoppedReachJournalAndSidecar() throws {
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            try engine.debugFirstAudio()
            try enqueueTone(engine)
            var journal: [[String: Any]] = []
            engine.library.gate = { point in
                if point == "stage.begin" { journal = (try? engine.library.readJournal(id)) ?? [] }
            }
            let stopped = expectation(description: "stop committed")
            engine.stop { result in
                if case .failure(let error) = result { XCTFail("Stop failed: \(error)") }
                stopped.fulfill()
            }
            wait(for: [stopped], timeout: 10)
            let first = try XCTUnwrap(journal.first { $0["e"] as? String == "first_audio" }?["t"] as? Int64)
            let end = try XCTUnwrap(journal.last { $0["e"] as? String == "capture_stopped" }?["t"] as? Int64)
            XCTAssertGreaterThanOrEqual(end, first)
            let sidecar = try engine.library.readSidecar(id)
            XCTAssertEqual(sidecar["firstAudioAt"] as? Int64, first)
            XCTAssertEqual(sidecar["captureStoppedAt"] as? Int64, end)
        }
    }

    func testQuarantinedAudioIsNeverLegacyImportedOrReannounced() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-quarantine-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let initial = try CaptureEngine(testRoot: root)
        let id = UUID().uuidString.lowercased()
        try initial.library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
            transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        initial.library.endLiveCapture(id)
        for _ in 0..<3 {
            try initial.library.beginRecoveryAttempt(id)
        }
        try Data("orphan".utf8).write(to: initial.library.url("\(id).m4a"))
        for launch in 0..<2 {
            let engine = try CaptureEngine(testRoot: root)
            var probes = 0
            var failures = 0
            let announced = expectation(description: "new quarantine announced")
            if launch == 1 { announced.isInverted = true }
            engine.library.gate = { if $0 == "probe.afterLoad" { probes += 1 } }
            let token = engine.observe { name, _, _ in
                if name == "recoveryFailed" { failures += 1; announced.fulfill() }
            }
            engine.recoverOnce()
            try engine.awaitRecovery()
            wait(for: [announced], timeout: launch == 0 ? 2 : 0.1)
            XCTAssertEqual(probes, 0)
            XCTAssertEqual(failures, launch == 0 ? 1 : 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sidecarURL(id).path))
            engine.removeObserver(token)
        }
    }

    func testBackgroundRefusalAndForegroundBlockedAttempt() throws {
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            try engine.pause()
            engine.debugForeground = false
            XCTAssertThrowsError(try engine.resume()) {
                XCTAssertEqual(($0 as? CaptureResumeError)?.code, "resume_failed")
            }
            XCTAssertEqual(engine.status()["state"] as? String, "needs_user")
            XCTAssertEqual(engine.status()["reason"] as? String, "resume_not_allowed")
            XCTAssertEqual((engine.status()["openSpan"] as? [String: Any])?["reason"] as? String,
                           "resume_not_allowed")
            XCTAssertTrue(try events(engine, id).contains {
                $0["e"] as? String == "avail" && $0["value"] as? String == "blocked" &&
                $0["reason"] as? String == "resume_not_allowed"
            })
            XCTAssertTrue(try events(engine, id).contains {
                $0["e"] as? String == "span_open" && $0["reason"] as? String == "resume_not_allowed"
            })
            engine.debugForeground = true
            engine.debugActivationError = NSError(domain: "AVAudioSessionErrorDomain",
                                                  code: AVAudioSession.ErrorCode.cannotStartRecording.rawValue)
            let before = engine.debugActivationAttempts
            engine.setAppActive(true)
            XCTAssertEqual(engine.debugActivationAttempts, before + 1)
            engine.setAppActive(true)
            XCTAssertEqual(engine.debugActivationAttempts, before + 1)
            XCTAssertFalse(engine.debugRetryPending)
            XCTAssertEqual(engine.status()["state"] as? String, "needs_user")
            try engine.pause()
            XCTAssertEqual(engine.status()["availability"] as? String, "available")
        }
    }

    func testManualResumeClassifiesAudioSessionAndOtherErrors() throws {
        try withEngine { engine in
            _ = try engine.start()
            try engine.pause()
            engine.debugActivationError = NSError(domain: "AVAudioSessionErrorDomain",
                                                  code: AVAudioSession.ErrorCode.isBusy.rawValue)
            XCTAssertThrowsError(try engine.resume()) {
                XCTAssertEqual(($0 as? CaptureResumeError)?.code, "resume_failed")
            }
            XCTAssertEqual(engine.status()["reason"] as? String, "mic_unavailable")
            try engine.pause()
            engine.debugActivationError = NSError(domain: "test", code: 42)
            XCTAssertThrowsError(try engine.resume()) {
                XCTAssertEqual(($0 as? CaptureResumeError)?.code, "resume_failed")
            }
            XCTAssertEqual(engine.status()["reason"] as? String, "resume_blocked")
        }
    }

    func testAutomaticBackgroundRestartRefusalDoesNotBackOff() throws {
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            engine.interruptionBegan()
            let epoch = engine.debugEpoch
            engine.debugForeground = false
            engine.debugActivationError = NSError(domain: "test", code: 42)
            engine.interruptionEnded()
            XCTAssertEqual(engine.status()["state"] as? String, "needs_user")
            XCTAssertEqual(engine.status()["reason"] as? String, "resume_not_allowed")
            XCTAssertFalse(engine.debugRetryPending)
            XCTAssertEqual(engine.debugResumeNotices.count, 1)
            XCTAssertEqual(engine.debugResumeNotices.first?.epoch, epoch)
            XCTAssertTrue(try events(engine, id).contains {
                $0["e"] as? String == "avail" && $0["value"] as? String == "blocked" &&
                $0["reason"] as? String == "resume_not_allowed"
            })
        }
    }

    func testBackoffCapStaleNotificationAndStop() throws {
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            var clock: TimeInterval = 1_000
            engine.debugNow = { clock }
            engine.interruptionBegan()
            let noticeEpoch = engine.debugEpoch
            XCTAssertEqual(engine.debugResumeNotices.last?.epoch, noticeEpoch)
            engine.debugActivationError = CaptureError.io("injected activation failure")
            engine.interruptionEnded()
            XCTAssertTrue(engine.debugRetryPending)
            XCTAssertEqual(engine.debugEpoch, noticeEpoch)
            clock += 0.5
            engine.debugRetryTick()
            XCTAssertTrue(engine.debugRetryPending)
            XCTAssertEqual(engine.debugEpoch, noticeEpoch)
            engine.resumeFromNotification(id: id, epoch: noticeEpoch)
            XCTAssertEqual(engine.status()["state"] as? String, "needs_user")
            engine.debugActivationError = nil
            try engine.pause()
            engine.resumeFromNotification(id: id, epoch: noticeEpoch)
            XCTAssertEqual(engine.status()["state"] as? String, "paused")
            try engine.resume()
            engine.interruptionBegan()
            engine.debugActivationError = CaptureError.io("retry until cap")
            engine.interruptionEnded()
            clock += 600
            engine.debugRetryTick()
            XCTAssertFalse(engine.debugRetryPending)
            XCTAssertEqual(engine.status()["state"] as? String, "needs_user")
            XCTAssertEqual(engine.status()["reason"] as? String, "resume_blocked")
            engine.debugActivationError = nil
            try engine.resume()
            engine.interruptionBegan()
            engine.debugActivationError = CaptureError.io("stop during backoff")
            engine.interruptionEnded()
            XCTAssertTrue(engine.debugRetryPending)
            let stopped = expectation(description: "stop completes")
            engine.stop { _ in stopped.fulfill() }
            XCTAssertFalse(engine.debugGraphActive)
            XCTAssertFalse(engine.debugRetryPending)
            wait(for: [stopped], timeout: 10)
        }
    }

    func testRouteChangeFiltersSameInputAndRebuildsChangedInput() throws {
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            let first = try segmentCount(engine, id)
            engine.routeChanged()
            XCTAssertEqual(try segmentCount(engine, id), first)
            #if targetEnvironment(simulator)
            // Debug simulator captures synthetic silence and follows no host route.
            engine.debugInputRoute = ("changed-input", AVAudioSession.sharedInstance().sampleRate)
            engine.routeChanged()
            XCTAssertEqual(try segmentCount(engine, id), first)
            return
            #endif
            if let active = engine.status()["input"] as? [String: Any], let uid = active["id"] as? String {
                try engine.selectInput(uid)
                XCTAssertEqual(try segmentCount(engine, id), first)
            }
            engine.debugInputRoute = ("changed-input", AVAudioSession.sharedInstance().sampleRate)
            engine.routeChanged()
            XCTAssertEqual(try segmentCount(engine, id), first + 1)
            XCTAssertTrue(try events(engine, id).contains {
                $0["e"] as? String == "span_open" && $0["reason"] as? String == "route_change"
            })
        }
    }

    func testRouteChangePublishesCurrentInputsWhileIdle() throws {
        try withEngine { engine in
            #if targetEnvironment(simulator)
            engine.debugInputEnvironment = ["EXO_SIM_AUDIO_INPUT": "silence"]
            #endif
            var snapshots: [[String: Any]] = []
            let observer = engine.observe { name, data, _ in
                if name == "inputs" { snapshots.append(data) }
            }
            defer { engine.removeObserver(observer) }

            engine.routeChanged()
            XCTAssertEqual(snapshots.count, 1)
            XCTAssertNotNil(snapshots[0]["inputs"] as? [[String: Any]])
            XCTAssertNotNil(snapshots[0]["selectedId"])
            XCTAssertNotNil(snapshots[0]["activeId"])

            #if targetEnvironment(simulator)
            XCTAssertEqual(snapshots[0]["activeId"] as? String, SimulatorSilentInput.inputID)
            engine.debugInputEnvironment = ["EXO_SIM_AUDIO_INPUT": "file:speech"]
            engine.routeChanged()
            XCTAssertEqual(snapshots.count, 2)
            XCTAssertEqual(snapshots[1]["activeId"] as? String, "exo-sim-file-speech")
            let inputs = try XCTUnwrap(snapshots[1]["inputs"] as? [[String: Any]])
            XCTAssertEqual(inputs.first?["id"] as? String, "exo-sim-file-speech")
            #endif
        }
    }

    func testWatchdogRebuildsStoppedGraphAndMediaResetAlerts() throws {
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            let first = try segmentCount(engine, id)
            engine.debugStopEngineWithoutTransition()
            engine.debugAgeLastTap(by: 4)
            engine.debugWatchdogTick()
            XCTAssertEqual(try segmentCount(engine, id), first + 1)
            XCTAssertTrue(try events(engine, id).contains {
                $0["e"] as? String == "span_open" && $0["reason"] as? String == "stalled"
            })
            var alerts: [[String: Any]] = []
            let token = engine.observe { name, data, _ in if name == "captureAlert" { alerts.append(data) } }
            defer { engine.removeObserver(token) }
            engine.mediaServicesReset()
            XCTAssertEqual(try segmentCount(engine, id), first + 2)
            XCTAssertEqual(alerts.last?["reason"] as? String, "media_services_reset")
            XCTAssertEqual(engine.debugResetNotifications, 1)
        }
    }

    func testPersistentStallBacksOffAndBlocksAtTenMinutes() throws {
        try withEngine { engine in
            // Whole seconds only: `clock += 599; clock += 1` is exact for these values, while a
            // fractional uptime start can round to 599.999… and leave the 10-minute cap unreached.
            var clock: TimeInterval = 1_000
            engine.debugNow = { clock }
            suppressLiveTaps(engine)
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            engine.debugDisableWatchdog()
            engine.debugAgeLastTap(by: 4)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["state"] as? String, "recording")
            XCTAssertFalse(engine.debugRetryPending)

            deliverTap(engine)
            engine.debugWatchdogTick() // A delivered buffer starts a fresh stall sequence.
            engine.debugAgeLastTap(by: 4)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["state"] as? String, "recording")
            XCTAssertFalse(engine.debugRetryPending)

            engine.debugConfigurationRebuild() // Must keep the first stall across a config rebuild.

            engine.debugAgeLastTap(by: 4)
            engine.debugWatchdogTick()
            XCTAssertTrue(engine.debugRetryPending)
            XCTAssertEqual((engine.status()["openSpan"] as? [String: Any])?["reason"] as? String,
                           "stalled")
            clock += 599
            engine.debugRetryTick()
            XCTAssertEqual(engine.status()["state"] as? String, "recording")
            engine.debugAgeLastTap(by: 4)
            engine.debugWatchdogTick()
            XCTAssertTrue(engine.debugRetryPending)
            clock += 1
            engine.debugRetryTick()
            engine.debugAgeLastTap(by: 4)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["state"] as? String, "needs_user")
            XCTAssertEqual(engine.status()["reason"] as? String, "stalled")
            XCTAssertFalse(engine.debugRetryPending)
            // Initial capture, two stall rebuilds, one explicit configuration rebuild, two retries.
            XCTAssertLessThanOrEqual(engine.debugSegmentOpenCount, 6)
            XCTAssertTrue(try events(engine, id).contains {
                $0["e"] as? String == "avail" && $0["value"] as? String == "blocked" &&
                $0["reason"] as? String == "stalled"
            })
        }
    }

    func testRecordedLimitExcludesPauseInLiveEngine() throws {
        let clock = TestClock()
        try withEngine(clock: clock) { engine in
            engine.debugSuppressTaps()
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 3_000)["id"] as? String)
            clock.advance(by: 1_400)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["elapsedMs"] as? Int64, 1_400)
            try engine.pause()
            clock.advance(by: 2_100)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["state"] as? String, "paused")
            XCTAssertEqual(engine.status()["elapsedMs"] as? Int64, 1_400)
            XCTAssertEqual(engine.status()["pausedMs"] as? Int64, 2_100)
            let stopped = expectation(description: "recorded time limit")
            var completed: [String: Any]?
            var stoppedAt: Int64?
            let token = engine.observe { name, data, _ in
                if name == "micState", data["state"] as? String == "idle",
                   data["reason"] as? String == "max_duration" {
                    stoppedAt = clock.nowMilliseconds()
                }
                if name == "autoStopped", data["reason"] as? String == "max_duration" {
                    completed = data
                    stopped.fulfill()
                }
            }
            defer { engine.removeObserver(token) }
            try engine.resume()
            clock.advance(by: 1_599)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["state"] as? String, "recording")
            XCTAssertEqual(engine.status()["elapsedMs"] as? Int64, 2_999)
            clock.advance(by: 1)
            engine.debugWatchdogTick()
            XCTAssertEqual(stoppedAt, 1_700_000_005_100)
            XCTAssertEqual(engine.status()["state"] as? String, "idle")
            XCTAssertEqual(engine.status()["reason"] as? String, "max_duration")
            wait(for: [stopped], timeout: 10)
            XCTAssertEqual(completed?["maxDurationMs"] as? Int64, 3_000)
            XCTAssertEqual(completed?["at"] as? Int64, clock.nowMilliseconds())
            XCTAssertTrue(completed?["recording"] is NSNull,
                          "suppressed simulator buffers leave no audio to commit")
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path))
        }
    }

    func testRecordedLimitCommitsRealAudio() throws {
        let clock = TestClock()
        try withEngine(clock: clock) { engine in
            engine.debugSuppressTaps()
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 3_000)["id"] as? String)
            try enqueueTone(engine)
            clock.advance(by: 1_400)
            try engine.pause()
            clock.advance(by: 2_100)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["state"] as? String, "paused")
            let committed = expectation(description: "recording committed")
            let autoStopped = expectation(description: "limit completion")
            var committedNote: [String: Any]?
            var stoppedNote: [String: Any]?
            let token = engine.observe { name, data, _ in
                if name == "committed" {
                    committedNote = data
                    committed.fulfill()
                }
                if name == "autoStopped", data["reason"] as? String == "max_duration" {
                    stoppedNote = data["recording"] as? [String: Any]
                    autoStopped.fulfill()
                }
            }
            defer { engine.removeObserver(token) }
            try engine.resume()
            try enqueueTone(engine)
            clock.advance(by: 1_600)
            engine.debugWatchdogTick()
            wait(for: [committed, autoStopped], timeout: 90)
            XCTAssertEqual(committedNote?["id"] as? String, id)
            XCTAssertEqual(stoppedNote?["id"] as? String, id)
            let sidecar = try engine.library.readSidecar(id)
            let wallMs = try XCTUnwrap(sidecar["wallMs"] as? Int64)
            let pausedMs = try XCTUnwrap(sidecar["pausedMs"] as? Int64)
            XCTAssertGreaterThanOrEqual(wallMs - pausedMs, 3_000)
            XCTAssertEqual(pausedMs, 2_100)
            XCTAssertGreaterThan(sidecar["durationMs"] as? Int64 ?? 0, 0)
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.audioURL(id).path))
        }
    }

    func testReadyWaitTimeoutDoesNotBlockStopAndRecoversAudio() throws {
        let clock = TestClock()
        try withEngine(clock: clock) { engine in
            engine.debugSuppressTaps()
            engine.debugMuxWaitTimeout = 0.05
            let cancelGate = DispatchSemaphore(value: 0)
            defer { cancelGate.signal() }
            let cancelEntered = expectation(description: "detached cancel entered")
            var seam = RecordingFinalizer.WaitSeam()
            seam.isReady = { _ in false }
            seam.cancelWriting = { writer in
                cancelEntered.fulfill()
                cancelGate.wait()
                writer.cancelWriting()
            }
            engine.debugMuxWaitSeam = seam
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 1_000)["id"] as? String)
            try enqueueTone(engine)
            let failed = expectation(description: "Stop reports mux timeout")
            let recovered = expectation(description: "recovery publishes recording")
            let committed = expectation(description: "recovery commits recording")
            var failure: [String: Any]?
            var recoveredNote: [String: Any]?
            var committedNote: [String: Any]?
            let token = engine.observe { name, data, _ in
                if name == "autoStopped", data["reason"] as? String == "max_duration" {
                    failure = data
                    failed.fulfill()
                }
                if name == "recovered", data["id"] as? String == id {
                    recoveredNote = data
                    recovered.fulfill()
                }
                if name == "committed", data["id"] as? String == id {
                    committedNote = data
                    committed.fulfill()
                }
            }
            defer { engine.removeObserver(token) }
            clock.advance(by: 1_000)
            engine.debugWatchdogTick()
            // The cancel hook is deliberately blocked; Stop must still return.
            wait(for: [cancelEntered, failed], timeout: 15)
            XCTAssertEqual(failure?["error"] as? String, CaptureError.finalizationTimedOut("ready_wait").code)
            XCTAssertEqual(failure?["at"] as? Int64, clock.nowMilliseconds())
            XCTAssertTrue(failure?["recording"] is NSNull)
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path))
            XCTAssertGreaterThan(ADTS.fullFrameCount(try Data(contentsOf: engine.library.segmentURL(id, index: 0))), 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sidecarURL(id).path))
            XCTAssertTrue(try events(engine, id).contains {
                $0["e"] as? String == "stop" && $0["reason"] as? String == "max_duration"
            })
            // Recovery runs under the same mux rule as Stop; drop the injected faults so it can succeed.
            engine.debugMuxWaitSeam = nil
            engine.debugMuxWaitTimeout = nil
            cancelGate.signal()
            wait(for: [recovered, committed], timeout: 30)
            XCTAssertEqual(recoveredNote?["id"] as? String, id)
            XCTAssertEqual(committedNote?["id"] as? String, id)
            XCTAssertEqual(try engine.library.readSidecar(id)["recovered"] as? Bool, true)
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.audioURL(id).path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path))
        }
    }

    func testFinishWritingWaitTimesOutAfterRealWait() throws {
        let started = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try RecordingFinalizer.awaitFinishWriting(waitTimeout: 0.05) { _ in
            // The same wait helper used by AVAssetWriter never receives completion.
        }) {
            XCTAssertEqual($0 as? CaptureError, .finalizationTimedOut("finish_writing"))
        }
        XCTAssertGreaterThanOrEqual(ProcessInfo.processInfo.systemUptime - started, 0.05)
    }

    func testSynchronousMuxStallTimesOutAndPreservesAudio() throws {
        let clock = TestClock()
        try withEngine(clock: clock) { engine in
            engine.debugSuppressTaps()
            engine.debugMuxStallTimeout = 0.1
            let muxGate = DispatchSemaphore(value: 0)
            defer { muxGate.signal() }
            let workerEntered = expectation(description: "mux worker entered")
            let workerReleased = expectation(description: "abandoned mux worker released")
            let retryScheduled = expectation(description: "timed-out recording scheduled for recovery")
            engine.debugScheduleTimedOutRetry = { _, _, _ in retryScheduled.fulfill() }
            var seam = RecordingFinalizer.WaitSeam()
            seam.beforeMuxWorker = {
                workerEntered.fulfill()
                muxGate.wait()
                workerReleased.fulfill()
            }
            engine.debugMuxWaitSeam = seam
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 1_000)["id"] as? String)
            try enqueueTone(engine)
            let stopped = expectation(description: "mux deadline reports failure")
            var failure: [String: Any]?
            let token = engine.observe { name, data, _ in
                if name == "autoStopped", data["reason"] as? String == "max_duration" {
                    failure = data
                    stopped.fulfill()
                }
            }
            defer { engine.removeObserver(token) }
            clock.advance(by: 1_000)
            engine.debugWatchdogTick()
            wait(for: [workerEntered, stopped, retryScheduled], timeout: 15)
            XCTAssertEqual(failure?["error"] as? String, "finalization_timed_out")
            XCTAssertGreaterThan(ADTS.fullFrameCount(try Data(contentsOf: engine.library.segmentURL(id, index: 0))), 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sidecarURL(id).path))
            muxGate.signal()
            wait(for: [workerReleased], timeout: 5)
        }
    }

    private final class Locked<Value> {
        private let lock = NSLock()
        private var stored: Value
        init(_ value: Value) { stored = value }
        func update<R>(_ body: (inout Value) -> R) -> R { lock.lock(); defer { lock.unlock() }; return body(&stored) }
        var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    }

    private func stubbedMux(stall: TimeInterval, ceiling: TimeInterval? = nil,
                            worker: @escaping (URL, RecordingFinalizer.MuxProgress) throws -> Void) throws -> URL {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("mux-\(UUID().uuidString).m4a")
        var config = RecordingFinalizer.Config()
        config.stallTimeout = stall
        config.ceilingOverride = ceiling
        config.seam.workerOverride = worker
        try RecordingFinalizer.mux(segments: [URL(fileURLWithPath: "/dev/null")], expectedAudioMs: 1_000,
                                   to: output, config: config)
        return output
    }

    func testSlowButProgressingMuxOutlastsTheStallTimeout() throws {
        let started = ProcessInfo.processInfo.systemUptime
        let output = try stubbedMux(stall: 2) { output, progress in
            for _ in 0..<25 {
                try progress.tick()
                Thread.sleep(forTimeInterval: 0.2)
            }
            try Data("m4a".utf8).write(to: output)
        }
        defer { try? FileManager.default.removeItem(at: output) }
        XCTAssertGreaterThan(ProcessInfo.processInfo.systemUptime - started, 2,
                             "the mux must run longer than the no-progress timeout to prove the rule")
        XCTAssertTrue(FileManager.default.fileExists(atPath: output.path))
    }

    func testMuxThatOnlyGrowsItsOutputCountsAsProgress() throws {
        let started = ProcessInfo.processInfo.systemUptime
        let output = try stubbedMux(stall: 2) { output, _ in
            FileManager.default.createFile(atPath: output.path, contents: nil)
            let handle = try FileHandle(forWritingTo: output)
            defer { try? handle.close() }
            for _ in 0..<25 {
                try handle.write(contentsOf: Data([1]))
                Thread.sleep(forTimeInterval: 0.2)
            }
        }
        defer { try? FileManager.default.removeItem(at: output) }
        XCTAssertGreaterThan(ProcessInfo.processInfo.systemUptime - started, 2)
    }

    func testStalledMuxFailsVisiblyAndTheLateWorkerIsCancelledAndDiscarded() throws {
        let gate = DispatchSemaphore(value: 0)
        let workerEnded = expectation(description: "abandoned worker ended")
        let workerResult = Locked<Error?>(nil)
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("mux-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: output) }
        var config = RecordingFinalizer.Config()
        config.stallTimeout = 0.5
        config.seam.workerOverride = { output, progress in
            defer { workerEnded.fulfill() }
            for _ in 0..<3 { try progress.tick(); Thread.sleep(forTimeInterval: 0.05) }
            gate.wait()
            // A worker that wakes after Stop gave up must be told to stop and must not leave a file.
            try Data("late".utf8).write(to: output)
            do { try progress.tick() } catch { workerResult.update { $0 = error }; throw error }
        }
        let started = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try RecordingFinalizer.mux(segments: [URL(fileURLWithPath: "/dev/null")],
                                                        expectedAudioMs: 1_000, to: output, config: config)) {
            XCTAssertEqual($0 as? CaptureError, .finalizationTimedOut("mux"))
        }
        XCTAssertGreaterThanOrEqual(ProcessInfo.processInfo.systemUptime - started, 0.5)
        gate.signal()
        wait(for: [workerEnded], timeout: 10)
        XCTAssertEqual(workerResult.value as? CaptureError, .cancelled)
        let deadline = ProcessInfo.processInfo.systemUptime + 10
        while FileManager.default.fileExists(atPath: output.path), ProcessInfo.processInfo.systemUptime < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path), "a late worker must never leave output")
    }

    func testAbsoluteCeilingStopsAMuxThatNeverStopsProgressing() throws {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("mux-\(UUID().uuidString).m4a")
        var config = RecordingFinalizer.Config()
        config.stallTimeout = 1
        config.ceilingOverride = 0.6
        config.seam.workerOverride = { _, progress in
            while true { try progress.tick(); Thread.sleep(forTimeInterval: 0.02) }
        }
        XCTAssertThrowsError(try RecordingFinalizer.mux(segments: [URL(fileURLWithPath: "/dev/null")],
                                                        expectedAudioMs: 1_000, to: output, config: config)) {
            XCTAssertEqual($0 as? CaptureError, .finalizationTimedOut("mux_ceiling"))
        }
    }

    func testSlowProgressingStopPublishesTheNoteExactlyOnce() throws {
        let clock = TestClock()
        try withEngine(clock: clock) { engine in
            engine.debugSuppressTaps()
            engine.debugMuxStallTimeout = 2
            let calls = Locked(0)
            var seam = RecordingFinalizer.WaitSeam()
            seam.workerOverride = { output, progress in
                calls.update { $0 += 1 }
                for _ in 0..<25 { try progress.tick(); Thread.sleep(forTimeInterval: 0.2) }
                try Data("m4a".utf8).write(to: output)
            }
            engine.debugMuxWaitSeam = seam
            engine.debugScheduleTimedOutRetry = { _, _, _ in XCTFail("a progressing mux must not time out") }
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 1_000)["id"] as? String)
            try enqueueTone(engine)
            let stopped = expectation(description: "stop reports success")
            let committed = Locked(0)
            var stoppedNote: [String: Any]?
            let token = engine.observe { name, data, _ in
                if name == "committed", data["id"] as? String == id { committed.update { $0 += 1 } }
                if name == "autoStopped", data["reason"] as? String == "max_duration" {
                    stoppedNote = data
                    stopped.fulfill()
                }
            }
            defer { engine.removeObserver(token) }
            clock.advance(by: 1_000)
            engine.debugWatchdogTick()
            wait(for: [stopped], timeout: 60)
            XCTAssertNil(stoppedNote?["error"])
            XCTAssertEqual(stoppedNote?["id"] as? String, id)
            XCTAssertEqual(calls.value, 1)
            XCTAssertEqual(committed.value, 1)
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.audioURL(id).path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.sidecarURL(id).path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path))
        }
    }

    func testTimedOutStopBacksOffRecordsEveryAttemptAndTryAgainStillWorks() throws {
        let clock = TestClock()
        try withEngine(clock: clock) { engine in
            engine.debugSuppressTaps()
            engine.debugMuxStallTimeout = 0.2
            let stallGate = DispatchSemaphore(value: 0)
            defer { for _ in 0..<8 { stallGate.signal() } }
            let calls = Locked(0)
            let succeedFromCall = Locked(Int.max)
            var seam = RecordingFinalizer.WaitSeam()
            seam.workerOverride = { output, progress in
                let call = calls.update { $0 += 1; return $0 }
                if call >= succeedFromCall.value {
                    try progress.tick()
                    try Data("m4a".utf8).write(to: output)
                    return
                }
                stallGate.wait()
            }
            engine.debugMuxWaitSeam = seam
            let scheduled = Locked([(delay: TimeInterval, run: () -> Void)]())
            let firstScheduled = expectation(description: "first automatic retry scheduled")
            engine.debugScheduleTimedOutRetry = { _, delay, run in
                scheduled.update { $0.append((delay, run)) }
                if scheduled.value.count == 1 { firstScheduled.fulfill() }
            }
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 1_000)["id"] as? String)
            try enqueueTone(engine)
            let stopFailed = expectation(description: "stop reports the timeout")
            let givenUp = expectation(description: "recovery reported failed after the last automatic retry")
            let failures = Locked(0)
            let token = engine.observe { name, data, _ in
                if name == "autoStopped", data["reason"] as? String == "max_duration",
                   data["error"] as? String == "finalization_timed_out" { stopFailed.fulfill() }
                if name == "recoveryFailed", data["id"] as? String == id {
                    failures.update { $0 += 1 }
                    givenUp.fulfill()
                }
            }
            defer { engine.removeObserver(token) }
            clock.advance(by: 1_000)
            engine.debugWatchdogTick()
            wait(for: [stopFailed, firstScheduled], timeout: 15)
            XCTAssertEqual(scheduled.value.map(\.delay), [2])
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path))

            // Automatic retry 1 (2 s) fails too: the attempt is recorded and the next one is 30 s out.
            DispatchQueue.global().async { scheduled.value[0].run() }
            let deadline = ProcessInfo.processInfo.systemUptime + 15
            while scheduled.value.count < 2, ProcessInfo.processInfo.systemUptime < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            }
            XCTAssertEqual(scheduled.value.map(\.delay), [2, 30])
            var marker = try XCTUnwrap(engine.library.listRecoveryFailures().first { $0["id"] as? String == id })
            XCTAssertEqual(marker["attempts"] as? Int, 1)
            XCTAssertEqual(marker["inFlight"] as? Bool, false)
            XCTAssertEqual(failures.value, 0, "the user is only told once the automatic retries are exhausted")

            // Automatic retry 2 (30 s) fails: nothing more is scheduled until the next launch.
            DispatchQueue.global().async { scheduled.value[1].run() }
            wait(for: [givenUp], timeout: 15)
            XCTAssertEqual(scheduled.value.count, 2)
            marker = try XCTUnwrap(engine.library.listRecoveryFailures().first { $0["id"] as? String == id })
            XCTAssertEqual(marker["attempts"] as? Int, 2)
            XCTAssertEqual(marker["inFlight"] as? Bool, false)
            XCTAssertEqual(marker["quarantined"] as? Bool, false)
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path),
                          "segments are kept until a commit succeeds")
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sidecarURL(id).path))

            // "Try again" finds the marker and now succeeds under the same rule.
            succeedFromCall.update { $0 = calls.value + 1 }
            try engine.retryRecovery(id)
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.sidecarURL(id).path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.audioURL(id).path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path))
            XCTAssertTrue(try engine.library.listRecoveryFailures().filter { $0["id"] as? String == id }.isEmpty)
        }
    }

    func testFileSizeIsFreshForTheSameURLOnABackgroundThread() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("size-\(UUID().uuidString).bin")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let sizes = Locked([Int64]())
        let done = expectation(description: "sizes read")
        Thread.detachNewThread {
            for _ in 0..<3 {
                sizes.update { $0.append(RecordingFinalizer.fileSize(url)) }
                if let handle = try? FileHandle(forWritingTo: url) {
                    _ = try? handle.seekToEnd()
                    try? handle.write(contentsOf: Data([2]))
                    try? handle.close()
                }
            }
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        XCTAssertEqual(sizes.value, [1, 2, 3], "a repeated poll of one URL must see the file grow")
    }

    func testFinishWritingWaitOutlastsItsTimeoutWhileTheFileKeepsGrowing() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("finish-\(UUID().uuidString).bin")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: url) }
        let started = ProcessInfo.processInfo.systemUptime
        try RecordingFinalizer.awaitFinishWriting(waitTimeout: 0.5, progress: { RecordingFinalizer.fileSize(url) }) { done in
            Thread.detachNewThread {
                for _ in 0..<20 {
                    if let handle = try? FileHandle(forWritingTo: url) {
                        _ = try? handle.seekToEnd()
                        try? handle.write(contentsOf: Data([1]))
                        try? handle.close()
                    }
                    Thread.sleep(forTimeInterval: 0.1)
                }
                done()
            }
        }
        XCTAssertGreaterThan(ProcessInfo.processInfo.systemUptime - started, 1.5,
                             "the wait must run past its own no-progress timeout")
    }

    func testFinishWritingWaitStillTimesOutWhenTheFileStopsGrowing() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("finish-\(UUID().uuidString).bin")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertThrowsError(try RecordingFinalizer.awaitFinishWriting(
            waitTimeout: 0.3, progress: { RecordingFinalizer.fileSize(url) }) { _ in }) {
            XCTAssertEqual($0 as? CaptureError, .finalizationTimedOut("finish_writing"))
        }
    }

    private func spinUntil(_ timeout: TimeInterval, _ condition: () -> Bool) {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while !condition(), ProcessInfo.processInfo.systemUptime < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
    }

    func testDelayedAutomaticRetryNeverOverlapsManualRetryOrDeletesTheCommittedNote() throws {
        let clock = TestClock()
        try withEngine(clock: clock) { engine in
            engine.debugSuppressTaps()
            engine.debugMuxStallTimeout = 0.2
            let stallGate = DispatchSemaphore(value: 0)
            let entered = DispatchSemaphore(value: 0)
            let gate = DispatchSemaphore(value: 0)
            defer { for _ in 0..<8 { stallGate.signal() }; gate.signal() }
            let calls = Locked(0)
            var seam = RecordingFinalizer.WaitSeam()
            seam.workerOverride = { output, progress in
                let call = calls.update { $0 += 1; return $0 }
                if call <= 2 { stallGate.wait(); return }
                try progress.tick()
                entered.signal()
                gate.wait()
                try Data("m4a".utf8).write(to: output)
            }
            engine.debugMuxWaitSeam = seam
            let scheduled = Locked([(delay: TimeInterval, run: () -> Void)]())
            engine.debugScheduleTimedOutRetry = { _, delay, run in scheduled.update { $0.append((delay, run)) } }
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 1_000)["id"] as? String)
            try enqueueTone(engine)
            let stopFailed = expectation(description: "stop reports the timeout")
            let failedEvents = Locked(0)
            let token = engine.observe { name, data, _ in
                if name == "autoStopped", data["error"] as? String == "finalization_timed_out" { stopFailed.fulfill() }
                if name == "recoveryFailed" { failedEvents.update { $0 += 1 } }
            }
            defer { engine.removeObserver(token) }
            clock.advance(by: 1_000)
            engine.debugWatchdogTick()
            wait(for: [stopFailed], timeout: 15)
            spinUntil(15) { scheduled.value.count == 1 }
            DispatchQueue.global().async { scheduled.value[0].run() }
            spinUntil(15) { scheduled.value.count == 2 }
            XCTAssertEqual(scheduled.value.map(\.delay), [2, 30])

            // Manual "Try again" starts during the 30 s wait and holds its mux open.
            engine.debugMuxStallTimeout = 60
            let manualDone = expectation(description: "manual retry finished")
            let manual = Locked<Result<Void, Error>?>(nil)
            DispatchQueue.global().async {
                manual.update { $0 = Result { try engine.retryRecovery(id) } }
                manualDone.fulfill()
            }
            XCTAssertEqual(entered.wait(timeout: .now() + 15), .success)

            // The delayed automatic retry fires now: it must skip, not start a second recovery.
            scheduled.value[1].run()
            XCTAssertEqual(calls.value, 3)
            XCTAssertEqual(try engine.library.listRecoveryFailures().first { $0["id"] as? String == id }?["attempts"] as? Int, 2)

            gate.signal()
            wait(for: [manualDone], timeout: 15)
            XCTAssertNoThrow(try manual.value?.get())
            func assertPublished() {
                XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.audioURL(id).path))
                XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.sidecarURL(id).path))
                XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.url("tombstones/\(id)").path))
                XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path))
            }
            assertPublished()
            // A stale automatic retry after the commit must leave the published note alone.
            scheduled.value[1].run()
            XCTAssertEqual(calls.value, 3)
            assertPublished()
            XCTAssertEqual(failedEvents.value, 0)
        }
    }

    func testManualRetryIsRefusedWhileAnAutomaticRetryHoldsTheNote() throws {
        let clock = TestClock()
        try withEngine(clock: clock) { engine in
            engine.debugSuppressTaps()
            engine.debugMuxStallTimeout = 0.2
            let stallGate = DispatchSemaphore(value: 0)
            let entered = DispatchSemaphore(value: 0)
            let gate = DispatchSemaphore(value: 0)
            defer { for _ in 0..<8 { stallGate.signal() }; gate.signal() }
            let calls = Locked(0)
            var seam = RecordingFinalizer.WaitSeam()
            seam.workerOverride = { output, progress in
                let call = calls.update { $0 += 1; return $0 }
                if call == 1 { stallGate.wait(); return }
                try progress.tick()
                entered.signal()
                gate.wait()
                try Data("m4a".utf8).write(to: output)
            }
            engine.debugMuxWaitSeam = seam
            let scheduled = Locked([(delay: TimeInterval, run: () -> Void)]())
            engine.debugScheduleTimedOutRetry = { _, delay, run in scheduled.update { $0.append((delay, run)) } }
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 1_000)["id"] as? String)
            try enqueueTone(engine)
            let stopFailed = expectation(description: "stop reports the timeout")
            let token = engine.observe { name, data, _ in
                if name == "autoStopped", data["error"] as? String == "finalization_timed_out" { stopFailed.fulfill() }
            }
            defer { engine.removeObserver(token) }
            clock.advance(by: 1_000)
            engine.debugWatchdogTick()
            wait(for: [stopFailed], timeout: 15)
            spinUntil(15) { scheduled.value.count == 1 }
            engine.debugMuxStallTimeout = 60
            DispatchQueue.global().async { scheduled.value[0].run() }
            XCTAssertEqual(entered.wait(timeout: .now() + 15), .success)
            XCTAssertThrowsError(try engine.retryRecovery(id)) {
                XCTAssertEqual($0 as? CaptureError, .recordingInProgress)
            }
            gate.signal()
            spinUntil(15) { FileManager.default.fileExists(atPath: engine.library.sidecarURL(id).path) }
            XCTAssertTrue(FileManager.default.fileExists(atPath: engine.library.audioURL(id).path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.url("tombstones/\(id)").path))
        }
    }

    func testStartBeforeAttachPauseStopAndDiscardLeaveNoSegment() throws {
        for action in ["pause", "stop", "discard"] {
            try withEngine { engine in
                var id: String?
                let stopped = action == "stop" ? expectation(description: "stop after beforeAttach") : nil
                engine.debugBeforeAttach = {
                    id = engine.status()["id"] as? String
                    if action == "pause" { try? engine.pause() }
                    else if action == "stop" { engine.stop { _ in stopped?.fulfill() } }
                    else { _ = try? engine.discard() }
                }
                XCTAssertThrowsError(try engine.start()) {
                    XCTAssertEqual($0 as? CaptureError, .cancelled)
                }
                XCTAssertFalse(engine.debugGraphActive)
                XCTAssertEqual(engine.debugSegmentOpenCount, 0)
                if let id, action == "pause" {
                    XCTAssertEqual(engine.status()["state"] as? String, "paused")
                    XCTAssertEqual(try segmentCount(engine, id), 0)
                    XCTAssertTrue(engine.debugLimitTimerArmed,
                                  "the timer also drives the stall watchdog and disk check")
                    engine.debugBeforeAttach = nil
                    try engine.resume()
                    XCTAssertTrue(engine.debugLimitTimerArmed)
                }
                if let stopped { wait(for: [stopped], timeout: 10) }
            }
        }
    }

    func testResumeAndAutomaticRestartBeforeAttachAreInvalidated() throws {
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            try engine.pause()
            let first = try segmentCount(engine, id)
            engine.debugBeforeAttach = { try? engine.pause() }
            XCTAssertThrowsError(try engine.resume()) {
                XCTAssertEqual($0 as? CaptureError, .cancelled)
            }
            XCTAssertEqual(engine.status()["state"] as? String, "paused")
            XCTAssertFalse(engine.debugGraphActive)
            XCTAssertEqual(try segmentCount(engine, id), first)
            engine.debugBeforeAttach = nil
            try engine.resume()
            engine.interruptionBegan()
            let before = engine.debugSegmentOpenCount
            engine.debugBeforeAttach = { _ = try? engine.discard() }
            engine.interruptionEnded()
            XCTAssertEqual(engine.status()["state"] as? String, "idle")
            XCTAssertFalse(engine.debugGraphActive)
            XCTAssertEqual(engine.debugSegmentOpenCount, before)
        }
    }
}
