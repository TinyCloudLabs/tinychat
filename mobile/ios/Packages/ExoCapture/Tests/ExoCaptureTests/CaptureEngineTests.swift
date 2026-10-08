import AVFoundation
import CaptureCore
import XCTest
@testable import ExoCapture

@MainActor final class CaptureEngineTests: XCTestCase {
    private func withEngine(_ body: (CaptureEngine) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-engine-\(UUID().uuidString)")
        let engine = try CaptureEngine(testRoot: root)
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
        try withEngine { engine in
            let id = try XCTUnwrap(engine.start(requestedLimitMs: 3_000)["id"] as? String)
            RunLoop.current.run(until: Date().addingTimeInterval(1.4))
            try engine.pause()
            RunLoop.current.run(until: Date().addingTimeInterval(2.1))
            XCTAssertEqual(engine.status()["state"] as? String, "paused")
            let stopped = expectation(description: "recorded time limit")
            var completed: [String: Any]?
            var stateStoppedAt: Date?
            let token = engine.observe { name, data, _ in
                if name == "micState", data["state"] as? String == "idle",
                   data["reason"] as? String == "max_duration" {
                    stateStoppedAt = Date()
                }
                if name == "autoStopped", data["reason"] as? String == "max_duration" {
                    completed = data
                    stopped.fulfill()
                }
            }
            defer { engine.removeObserver(token) }
            try engine.resume()
            let resumedAt = Date()
            wait(for: [stopped], timeout: 20)
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(stateStoppedAt).timeIntervalSince(resumedAt), 1.2)
            let recording = try XCTUnwrap(completed?["recording"] as? [String: Any])
            XCTAssertEqual(recording["id"] as? String, id)
            let sidecar = try engine.library.readSidecar(id)
            XCTAssertEqual((sidecar["spans"] as? [[String: Any]])?.count, 0)
            XCTAssertGreaterThan(sidecar["pausedMs"] as? Int64 ?? 0, 1_500)
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
