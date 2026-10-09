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

    func testParkedPauseIsAdoptedThenTimesOutOnNextLaunch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-parked-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = TestClock()
        let first = try CaptureEngine(testRoot: root, clock: clock)
        first.debugForeground = true
        let id = try XCTUnwrap(first.start()["id"] as? String)
        try enqueueTone(first)
        try first.pause()
        let resumed = try CaptureEngine(testRoot: root, clock: clock)
        resumed.debugForeground = true
        resumed.recoverOnce()
        let adopted = expectation(description: "parked session adopted")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            XCTAssertEqual(resumed.status()["id"] as? String, id)
            XCTAssertEqual(resumed.status()["state"] as? String, "paused")
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
            var clock = ProcessInfo.processInfo.systemUptime
            engine.debugNow = { clock }
            engine.debugSuppressTaps()
            let id = try XCTUnwrap(engine.start()["id"] as? String)
            engine.debugAgeLastTap(by: 4)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["state"] as? String, "recording")
            XCTAssertFalse(engine.debugRetryPending)

            engine.debugRecordDeliveredTap()
            engine.debugWatchdogTick() // A delivered buffer starts a fresh stall sequence.
            engine.debugAgeLastTap(by: 4)
            engine.debugWatchdogTick()
            XCTAssertEqual(engine.status()["state"] as? String, "recording")
            XCTAssertFalse(engine.debugRetryPending)

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
            XCTAssertLessThanOrEqual(engine.debugSegmentOpenCount, 5)
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
            engine.debugMuxOperationTimeout = 0.1
            let muxGate = DispatchSemaphore(value: 0)
            defer { muxGate.signal() }
            let workerEntered = expectation(description: "mux worker entered")
            let workerReleased = expectation(description: "abandoned mux worker released")
            let retryScheduled = expectation(description: "timed-out recording scheduled for recovery")
            engine.debugScheduleTimedOutRetry = { _ in retryScheduled.fulfill() }
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
