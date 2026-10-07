import XCTest
@testable import CaptureCore

final class CaptureTransitionTests: XCTestCase {
    private let id = "11111111-1111-4111-8111-111111111111"
    private let origin: Int64 = 1_759_800_000_000

    private func fixtures() -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../fixtures/capture").standardizedFileURL
    }

    func testLiveTransitionJournalAndSidecarMatchIOSGoldenBytes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try RecordingLibrary(root: root)
        let session = SessionInfo(id: id, source: "in_app", owner: nil, transitionGen: 12,
                                  options: CaptureOptions(), startedAt: origin)
        var machine = CaptureTransitionMachine()
        func append(_ events: [[String: Any]], finalSync: Bool = false) throws {
            for (index, event) in events.enumerated() {
                try library.appendJournal(id, event, fullSync: finalSync && index == events.count - 1)
            }
        }
        func audio(_ frames: Int64) -> Int64 { frames * 1024 * 1000 / 48_000 }
        try library.startSession(session)
        let input = (id: "built-in", name: "iPhone Microphone", kind: "built_in")
        try append(machine.acquired(at: origin, audioMs: 0, generation: 1, input: input))
        try library.openFirstSegment(id, at: origin)

        // Deliver 93 and then 23 more complete AAC access units; interruption closes segment 0.
        try library.checkpoint(id, segment: 0, bytes: 93 * 107, audioMs: audio(93),
                               intent: "recording", availability: "available", at: origin + 2_000)
        try library.checkpoint(id, segment: 0, bytes: 116 * 107, audioMs: audio(116),
                               intent: "recording", availability: "available", fullSync: true,
                               at: origin + 2_500)
        try append(machine.interrupted(at: origin + 2_500, audioMs: audio(116),
                                       generation: 2, reason: "call"))

        try append(machine.acquired(at: origin + 4_500, audioMs: audio(116), generation: 3, input: input))
        _ = try library.rollSegment(id, next: 1, audioMs: audio(116), at: origin + 4_500)
        try library.checkpoint(id, segment: 1, bytes: 23 * 107, audioMs: audio(139),
                               intent: "recording", availability: "available", fullSync: true,
                               at: origin + 5_000)
        try append(machine.paused(at: origin + 5_000, audioMs: audio(139), inputStopped: true), finalSync: true)

        try append(machine.resumed(at: origin + 10_000, audioMs: audio(139)))
        try append(machine.acquired(at: origin + 10_000, audioMs: audio(139), generation: 5, input: input))
        _ = try library.rollSegment(id, next: 2, audioMs: audio(139), at: origin + 10_000)
        try library.checkpoint(id, segment: 2, bytes: 46 * 107, audioMs: audio(185),
                               intent: "recording", availability: "available", fullSync: true,
                               at: origin + 11_000)
        try append(machine.stopped(at: origin + 11_000, audioMs: audio(185), reason: "user"), finalSync: true)

        let journal = try Data(contentsOf: library.journalURL(id))
        XCTAssertEqual(journal, try Data(contentsOf: fixtures().appendingPathComponent("journal-ios.jsonl")))
        let parsed = try JournalRecovery(events: library.readJournal(id))
        XCTAssertEqual(parsed.wallMs, 11_000)
        XCTAssertEqual(parsed.pausedMs, 5_000)
        XCTAssertEqual(try JournalRecovery(events: library.readJournal(id)).pausedMs, 5_000)
        var span = MissingAudioSpan(kind: "omitted", reason: "interruption",
                                    startedAt: origin + 2_500, atAudioMs: audio(116))
        span.endedAt = origin + 4_500
        var sidecar = SidecarFactory.v2(session: session, durationMs: audio(185), wallMs: 11_000,
                                        pausedMs: 5_000, spans: [span],
                                        input: ["id": input.id, "name": input.name, "kind": input.kind],
                                        recovered: false, endedUnexpectedly: false,
                                        lastHeartbeatAt: origin + 11_000)
        sidecar["sizeBytes"] = 20_000
        XCTAssertEqual(try CanonicalJSON.file(sidecar),
                       try Data(contentsOf: fixtures().appendingPathComponent("sidecar-v2-ios.json")))
    }

    func testPauseFailureLeavesRecordingAndWritesNoTransition() throws {
        var machine = CaptureTransitionMachine()
        XCTAssertThrowsError(try machine.paused(at: 5_000, audioMs: 123, inputStopped: false)) {
            XCTAssertEqual($0 as? CaptureError, .pauseFailed)
        }
        XCTAssertEqual(machine.intent, "recording")
        XCTAssertNil(machine.openSpan)
    }

    func testPauseInputDrainJournalReleaseOrderAndReleaseFailure() throws {
        struct FixedClock: CaptureClock { func nowMilliseconds() -> Int64 { 5_000 } }
        var order: [String] = []
        var machine = CaptureTransitionMachine()
        let input = ClosureInputControl(stop: { order.append("stop input"); return true },
                                        release: { order.append("release input"); throw CaptureError.io("release") })
        let frames = ClosureFrameSink(close: { order.append("drain + full sync segment + final hb");
            return (audioMs: 1_000, at: 5_000) })
        let journal = ClosureJournalSink(write: { event, fullSync in
            order.append("journal \(event["e"] as? String ?? "unknown") \(fullSync ? "full" : "barrier")")
        })
        let result = try machine.pause(input: input, frames: frames, journal: journal,
                                       clock: FixedClock(), currentAudioMs: 900) { _ in order.append("release error logged") }
        XCTAssertEqual(result.audioMs, 1_000)
        XCTAssertEqual(machine.intent, "paused")
        XCTAssertEqual(order, ["stop input", "drain + full sync segment + final hb",
                               "journal intent full", "release input", "release error logged"])
        order.removeAll()
        machine = CaptureTransitionMachine()
        let failedInput = ClosureInputControl(stop: { order.append("stop failed"); return false },
                                              release: { XCTFail("released after failed stop") })
        XCTAssertThrowsError(try machine.pause(input: failedInput, frames: frames, journal: journal,
                                               clock: FixedClock(), currentAudioMs: 900) { _ in })
        XCTAssertEqual(order, ["stop failed"])
        XCTAssertEqual(machine.intent, "recording")
    }

    func testInterruptionPauseAndStopOrder() throws {
        var machine = CaptureTransitionMachine()
        let interruption = machine.interrupted(at: 2_000, audioMs: 900, generation: 2, reason: "interruption")
        XCTAssertEqual(interruption.compactMap { $0["e"] as? String }, ["span_open", "avail"])
        let pause = try machine.paused(at: 3_000, audioMs: 900, inputStopped: true)
        XCTAssertEqual(pause.compactMap { $0["e"] as? String }, ["span_close", "intent"])
        XCTAssertEqual(machine.intent, "paused")
        XCTAssertEqual(machine.stopped(at: 4_000, audioMs: 900, reason: "user")
            .compactMap { $0["e"] as? String }, ["intent", "stop"])
    }

    func testBlockedResumeAndThreeHourWallLimitExcludesOnlyPause() throws {
        var machine = CaptureTransitionMachine()
        _ = try machine.paused(at: 1_000, audioMs: 0, inputStopped: true)
        _ = machine.resumed(at: 1_801_000, audioMs: 0)
        let blocked = machine.blocked(at: 1_801_001, audioMs: 0, generation: 3)
        XCTAssertEqual(blocked.first?["reason"] as? String, "resume_blocked")
        XCTAssertEqual(CaptureTiming.elapsedMilliseconds(startedAt: 0, closedPaused: 1_800_000,
            pausedSince: nil, now: 12_600_000), 10_800_000)
        XCTAssertEqual(CaptureTiming.elapsedMilliseconds(startedAt: 0, closedPaused: 0,
            pausedSince: 1_000, now: 3_601_000), 1_000)
    }

    func testHeartbeatGridRestartsAtSegmentAndCloseSuppressesDueTick() {
        var timer = HeartbeatSchedule(segmentOpenedAt: 1_000)
        XCTAssertFalse(timer.periodicDue(at: 2_999, closing: false))
        XCTAssertTrue(timer.periodicDue(at: 3_100, closing: false))
        XCTAssertEqual(timer.nextDueAt, 5_000)
        XCTAssertFalse(timer.periodicDue(at: 5_000, closing: true))
        timer = HeartbeatSchedule(segmentOpenedAt: 5_000)
        XCTAssertEqual(timer.nextDueAt, 7_000)
    }

    func testRecoveryFailureIsScopedToOneSession() {
        var recovered: [String] = []
        var failures: [String] = []
        CaptureRecoverySweep.run(ids: ["broken", "healthy", "another"], recover: { id in
            if id == "broken" { throw CaptureError.io("invalid complete journal line") }
            recovered.append(id)
        }, failed: { id, _ in failures.append(id) })
        XCTAssertEqual(failures, ["broken"])
        XCTAssertEqual(recovered, ["healthy", "another"])
    }
}
