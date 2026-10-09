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
            XCTAssertTrue(completed?["recording"] is NSNull,
                          "suppressed simulator buffers leave no audio to commit")
            XCTAssertFalse(FileManager.default.fileExists(atPath: engine.library.sessionURL(id).path))
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
