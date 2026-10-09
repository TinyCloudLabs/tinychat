import XCTest
@testable import CaptureCore

final class RecordingLibraryTests: XCTestCase {
    private func fixture() throws -> (RecordingLibrary, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        return (try RecordingLibrary(root: root), root)
    }

    private func sidecar(_ id: String) -> [String: Any] {
        ["id": id, "version": 2, "rev": 0, "owner": "did:test",
         "ledger": ["remote": [["provider": "assemblyai", "mode": "hosted", "jobId": "job-1", "cleanup": "pending"]]]]
    }

    func testADTSHeaderAndTornJournal() throws {
        let header = try ADTS.header(payloadBytes: 100)
        XCTAssertEqual(header.count, 7)
        XCTAssertEqual(header, [0xff, 0xf1, 0x4c, 0x40, 0x0d, 0x7f, 0xfc])
        XCTAssertEqual(ADTS.payloadLength(header), 100)
        var frame = Data(header); frame.append(Data(repeating: 0, count: 100))
        XCTAssertEqual(ADTS.fullFrameCount(frame + frame + Data([0xff, 0xf1])), 2)
        XCTAssertEqual(ADTS.completePrefix(frame + frame + Data([0xff, 0xf1])).bytes, 214)
        let log = try JournalCodec.line(["e": "session", "t": 1, "a": 0]) + Data("{\"e\":\"hb\"".utf8)
        XCTAssertEqual(try JournalCodec.read(log).count, 1)
        XCTAssertThrowsError(try JournalCodec.read(Data("bad\n".utf8)))
        XCTAssertEqual(String(decoding: try CanonicalJSON.file(["z": "a/b", "a": NSNull()]), as: UTF8.self),
                       "{\"a\":null,\"z\":\"a/b\"}\n")
        XCTAssertEqual(String(decoding: try CanonicalJSON.file(["b": ["a9": "x\ny", "a10": "é/", "B": true]]), as: UTF8.self),
                       "{\"b\":{\"B\":true,\"a10\":\"é/\",\"a9\":\"x\\ny\"}}\n")
    }

    func testStaleTransitionGenerationIsRejected() throws {
        let current = CaptureDefaults(accountDid: "did:a", transitionGen: 7)
        XCTAssertThrowsError(try CaptureDefaults(accountDid: "did:b", transitionGen: 6)
            .validateTransition(from: current)) { error in
                XCTAssertEqual(error as? CaptureError, .staleTransition)
            }
        XCTAssertNoThrow(try CaptureDefaults(accountDid: "did:a", transitionGen: 7)
            .validateTransition(from: current))
    }

    func testFailedSegmentRollCanRetryWithoutDuplicateJournalEvent() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        try library.openFirstSegment(id)
        library.failpoint = { if $0 == "roll.create" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.rollSegment(id, next: 1, audioMs: 1000))
        library.failpoint = nil
        _ = try library.rollSegment(id, next: 1, audioMs: 1000)
        XCTAssertEqual(try library.readJournal(id).filter { $0["e"] as? String == "segment" }.count, 2)
    }

    func testStartAndSegmentFailpointsPreserveDurableJournal() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        let info = SessionInfo(id: id, source: "in_app", owner: nil,
                               transitionGen: 0, options: CaptureOptions(), startedAt: 1)
        library.failpoint = { if $0 == "start.mkdir" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.startSession(info))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sessionURL(id).path))
        let journalFailure = UUID().uuidString.lowercased()
        library.failpoint = { if $0 == "start.journal" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.startSession(SessionInfo(id: journalFailure, source: "in_app",
            owner: nil, transitionGen: 0, options: CaptureOptions(), startedAt: 1)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sidecarURL(journalFailure).path))
        library.failpoint = nil
        try library.startSession(info)
        try library.openFirstSegment(id)
        let handle = try FileHandle(forWritingTo: library.segmentURL(id, index: 0))
        defer { try? handle.close() }
        library.failpoint = { if $0 == "seg.write" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.appendSegment(Data("frame".utf8), to: handle))
        XCTAssertEqual(try Data(contentsOf: library.segmentURL(id, index: 0)).count, 0)
        library.failpoint = { if $0 == "seg.sync" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.checkpoint(id, segment: 0, bytes: 0, audioMs: 0,
                                                    intent: "recording", availability: "available"))
        XCTAssertEqual(try library.readJournal(id).filter { $0["e"] as? String == "hb" }.count, 0)
        library.failpoint = { if $0 == "stop.journal" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.appendJournal(id, ["e": "stop", "t": 2, "a": 0, "reason": "user"]))
    }

    func testMutationImportAndRetirementFailpoints() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        var unowned = sidecar(id); unowned["owner"] = NSNull()
        _ = try library.commit(id, sidecar: unowned) { try Data("audio".utf8).write(to: $0) }
        library.failpoint = { if $0 == "claim.write" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.claim(id, did: "did:a", evidence: "signed_out_v2"))
        XCTAssertEqual(try library.readSidecar(id)["rev"] as? Int, 0)
        library.failpoint = nil
        _ = try library.claim(id, did: "did:a", evidence: "signed_out_v2")
        library.failpoint = { if $0 == "ledger.write" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.updateLedger(id, did: "did:a", rev: 1, patch: [:]))
        XCTAssertEqual(try library.readSidecar(id)["rev"] as? Int, 1)
        library.failpoint = { if $0 == "delete.tombstone" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.delete(id))
        XCTAssertEqual(try library.listCommitted().count, 1)
        library.failpoint = nil
        try library.delete(id)

        let orphan = UUID().uuidString.lowercased()
        try Data("old".utf8).write(to: library.audioURL(orphan))
        library.failpoint = { if $0 == "import.sidecar" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.probeLegacy(orphan) { ["id": orphan, "legacyImport": true] })
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sidecarURL(orphan).path))
        library.failpoint = nil
        try library.probeLegacy(orphan) { ["id": orphan, "legacyImport": true] }
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.sidecarURL(orphan).path))

        let relaunched = try RecordingLibrary(root: root)
        relaunched.failpoint = { if $0 == "tombstone.retire" { throw CaptureError.io("injected") } }
        _ = try relaunched.recoverableSessions()
        XCTAssertTrue(FileManager.default.fileExists(atPath: relaunched.url("tombstones/\(id)").path))
        let retried = try RecordingLibrary(root: root)
        _ = try retried.recoverableSessions()
        XCTAssertFalse(FileManager.default.fileExists(atPath: retried.url("tombstones/\(id)").path))
    }

    func testRevisedT1CanonicalFixturesRequired() throws {
        let fixtures = ProcessInfo.processInfo.environment["EXO_T1_FIXTURES"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                .appendingPathComponent("../../../../../fixtures/capture").standardizedFileURL
        guard FileManager.default.fileExists(atPath: fixtures.appendingPathComponent("sidecar-v2-ios.json").path) else {
            XCTFail("T1 golden fixtures are required at \(fixtures.path)")
            return
        }
        let started: Int64 = 1_759_800_000_000
        let journal = try JournalCodec.read(Data(contentsOf: fixtures.appendingPathComponent("journal-ios.jsonl")))
        let finalAudioMs = try XCTUnwrap(journal.last?["a"] as? Int64)
        let recovery = try JournalRecovery(events: journal)
        XCTAssertEqual(recovery.wallMs, 11_000)
        XCTAssertEqual(recovery.pausedMs, 5_000)
        XCTAssertEqual(recovery.spans.count, 1)
        let info = SessionInfo(id: "11111111-1111-4111-8111-111111111111", source: "in_app",
                               owner: nil, transitionGen: 12, options: CaptureOptions(), startedAt: started)
        var span = MissingAudioSpan(kind: "omitted", reason: "interruption",
                                    startedAt: started + 2500, atAudioMs: 2474)
        span.endedAt = started + 4500
        var sidecar = SidecarFactory.v2(session: info, durationMs: finalAudioMs, wallMs: 11_000,
                                        pausedMs: 5000, spans: [span],
                                        input: ["id": "built-in", "kind": "built_in", "name": "iPhone Microphone"],
                                        recovered: false, endedUnexpectedly: false,
                                        lastHeartbeatAt: started + 11_000)
        sidecar["sizeBytes"] = 20_000
        let actual = try CanonicalJSON.file(sidecar)
        let expected = try Data(contentsOf: fixtures.appendingPathComponent("sidecar-v2-ios.json"))
        if actual != expected {
            let left = [UInt8](actual), right = [UInt8](expected)
            let difference = (0..<min(left.count, right.count)).first { left[$0] != right[$0] } ?? min(left.count, right.count)
            let start = max(0, difference - 70), end = min(left.count, difference + 70)
            XCTFail("sidecar byte \(difference): actual \(String(decoding: left[start..<end], as: UTF8.self)); expected \(String(decoding: right[start..<min(right.count, difference + 70)], as: UTF8.self))")
        }
        for file in ["journal-ios.jsonl", "outbox-entry.json", "quarantine-record.json"] {
            let data = try Data(contentsOf: fixtures.appendingPathComponent(file))
            if file.hasPrefix("journal") {
                var encoded = Data()
                for event in try JournalCodec.read(data) { encoded.append(try JournalCodec.line(event)) }
                XCTAssertEqual(encoded, data)
            } else {
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                XCTAssertEqual(try CanonicalJSON.file(object), data)
            }
        }
    }

    func testCommitPublicationAndRepeatedRecovery() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        try library.appendJournal(id, ["e": "avail", "t": 2, "a": 0,
                                       "value": "available", "reason": NSNull(), "gen": 1])
        try library.openFirstSegment(id)
        XCTAssertEqual(try library.readJournal(id).map { $0["e"] as? String }, ["session", "avail", "segment"])
        let committed = try library.commit(id, sidecar: sidecar(id)) { staged in
            try Data("audio".utf8).write(to: staged)
        }
        XCTAssertEqual(committed["sizeBytes"] as? Int, 5)
        XCTAssertEqual(try library.listCommitted().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sessionURL(id).path))
        XCTAssertEqual(try library.recoverableSessions().count, 0)
        XCTAssertEqual(try library.recoverableSessions().count, 0)
    }

    func testColdQuickActionCanStartDuringRecoveryAndOldStagingIsCollected() throws {
        let (oldProcess, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let crashed = UUID().uuidString.lowercased()
        try oldProcess.startSession(SessionInfo(id: crashed, source: "in_app", owner: nil,
                                                transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        let newProcess = try RecordingLibrary(root: root)
        let live = UUID().uuidString.lowercased()
        try newProcess.startSession(SessionInfo(id: live, source: "quick_action", owner: nil,
                                                transitionGen: 0, options: CaptureOptions(), startedAt: 2))
        let abandoned = newProcess.url("staging/\(crashed).0.partial.m4a")
        let liveStage = newProcess.url("staging/\(live).0.live.m4a")
        try Data(repeating: 1, count: 4096).write(to: abandoned)
        try Data("live".utf8).write(to: liveStage)
        XCTAssertEqual(try newProcess.recoverableSessions(), [crashed])
        XCTAssertFalse(FileManager.default.fileExists(atPath: abandoned.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: liveStage.path))
        XCTAssertTrue(try newProcess.recoverableSessions().isEmpty)
    }

    func testRepeatedRecoveryNeverSelectsLiveCaptureAfterOldSessionFails() throws {
        let (previousProcess, root) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let broken = UUID().uuidString.lowercased()
        try previousProcess.startSession(SessionInfo(id: broken, source: "in_app", owner: nil,
                                                     transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        // A complete but invalid journal line leaves this old session for a later recovery attempt.
        let corruptJournal = try FileHandle(forWritingTo: previousProcess.journalURL(broken))
        try corruptJournal.seekToEnd()
        try corruptJournal.write(contentsOf: Data("not-json\n".utf8))
        try corruptJournal.close()

        let library = try RecordingLibrary(root: root)
        let live = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: live, source: "quick_action", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 2))
        try library.openFirstSegment(live, at: 2)
        let liveJournal = try Data(contentsOf: library.journalURL(live))

        // Launch recovery sees only the broken prior id; failed recovery leaves it in place.
        XCTAssertEqual(try library.recoverableSessions(), [broken])
        XCTAssertThrowsError(try library.readJournal(broken))
        XCTAssertTrue(library.isLiveCapture(live))

        // listPending and plugin reload may ask again while the microphone is still running.
        XCTAssertTrue(try library.recoverableSessions().isEmpty)
        XCTAssertTrue(try library.recoverableSessions(excluding: live).isEmpty)
        XCTAssertEqual(try Data(contentsOf: library.journalURL(live)), liveJournal)
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.segmentURL(live, index: 0).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sidecarURL(live).path))
        XCTAssertTrue(library.isLiveCapture(live))
    }

    func testLaunchRecoverySkipsSessionStartedHereAfterStop() throws {
        let (previousProcess, root) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let old = UUID().uuidString.lowercased()
        try previousProcess.startSession(SessionInfo(id: old, source: "in_app", owner: nil,
                                                     transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        let currentProcess = try RecordingLibrary(root: root)
        let current = UUID().uuidString.lowercased()
        try currentProcess.startSession(SessionInfo(id: current, source: "in_app", owner: nil,
                                                   transitionGen: 0, options: CaptureOptions(), startedAt: 2))
        currentProcess.endLiveCapture(current)

        XCTAssertEqual(try currentProcess.recoverableSessions(), [old])
        XCTAssertTrue(FileManager.default.fileExists(atPath: currentProcess.sessionURL(current).path))
    }

    func testDeleteDuringGatedCommitCannotRepublishAndPreservesOutbox() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        _ = try library.commit(id, sidecar: sidecar(id)) { try Data("audio".utf8).write(to: $0) }
        let entered = DispatchSemaphore(value: 0), continueStage = DispatchSemaphore(value: 0)
        library.gate = { point in if point == "stage.afterMux" { entered.signal(); continueStage.wait() } }
        let worker = DispatchQueue(label: "test.commit")
        let finished = expectation(description: "commit finished")
        worker.async {
            defer { finished.fulfill() }
            do {
                _ = try library.commit(id, sidecar: self.sidecar(id)) {
                    try Data("new".utf8).write(to: $0)
                }
                XCTFail("gated commit published after delete")
            } catch { XCTAssertEqual(error as? CaptureError, .tombstoned) }
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        try library.delete(id)
        continueStage.signal()
        wait(for: [finished], timeout: 5)
        XCTAssertTrue(try library.listCommitted().isEmpty)
        XCTAssertEqual(try library.listOutbox(did: "did:test").count, 1)
        let relaunched = try RecordingLibrary(root: root)
        XCTAssertTrue(try relaunched.recoverableSessions().isEmpty)
        XCTAssertTrue(try relaunched.listCommitted().isEmpty)
    }

    func testDeleteAtStageBeginPreventsAnyPublication() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        let entered = DispatchSemaphore(value: 0), resume = DispatchSemaphore(value: 0)
        library.gate = { point in if point == "stage.begin" { entered.signal(); resume.wait() } }
        let finished = expectation(description: "stage begin finished")
        DispatchQueue.global().async {
            defer { finished.fulfill() }
            do {
                _ = try library.commit(id, sidecar: ["id": id, "version": 2]) {
                    try Data("audio".utf8).write(to: $0)
                }
                XCTFail("commit published after delete")
            } catch { XCTAssertEqual(error as? CaptureError, .tombstoned) }
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        try library.delete(id)
        resume.signal()
        wait(for: [finished], timeout: 5)
        XCTAssertTrue(try library.listCommitted().isEmpty)
    }

    func testFailedUnlinkRetainsTombstoneAcrossClockJumpAndRelaunch() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        _ = try library.commit(id, sidecar: sidecar(id)) { try Data("audio".utf8).write(to: $0) }
        library.failpoint = { if $0 == "delete.unlink" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.delete(id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.url("tombstones/\(id)").path))
        XCTAssertThrowsError(try library.localAudioURL(id))
        // The marker survives regardless of elapsed wall time; recovery retries the unlink.
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -8 * 24 * 3600)],
                                              ofItemAtPath: library.url("tombstones/\(id)").path)
        let relaunched = try RecordingLibrary(root: root)
        _ = try relaunched.recoverableSessions()
        XCTAssertTrue(try relaunched.listCommitted().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: relaunched.audioURL(id).path))
    }

    func testClaimEvidenceAndLedgerCAS() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        var unsigned = sidecar(id); unsigned["owner"] = NSNull()
        _ = try library.commit(id, sidecar: unsigned) { try Data("audio".utf8).write(to: $0) }
        XCTAssertEqual(try library.claim(id, did: "did:alice", evidence: "signed_out_v2"), "did:alice")
        XCTAssertThrowsError(try library.claim(id, did: "did:alice", evidence: "space_row", rowId: "wrong-row"))
        XCTAssertEqual((try library.readSidecar(id))["rev"] as? Int, 1)
        XCTAssertThrowsError(try library.updateLedger(id, did: "did:bob", rev: 1, patch: [:]))
        XCTAssertThrowsError(try library.updateLedger(id, did: "did:alice", rev: 0, patch: [:]))
        XCTAssertEqual(try library.updateLedger(id, did: "did:alice", rev: 1,
                                                patch: ["audio": ["state": "saved"]]), 2)
        XCTAssertEqual((try library.readSidecar(id))["rev"] as? Int, 2)
    }

    func testLegacyNotesNeverAutoClaim() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        _ = try library.commit(id, sidecar: ["id": id, "durationMs": 1000]) {
            try Data("audio".utf8).write(to: $0)
        }
        XCTAssertEqual(try library.listCommitted().first?["ownerUnknown"] as? Bool, true)
        XCTAssertThrowsError(try library.claim(id, did: "did:alice", evidence: "signed_out_v2"))
        XCTAssertThrowsError(try library.claim(id, did: "did:alice", evidence: "space_row"))
        XCTAssertEqual(try library.claim(id, did: "did:alice", evidence: "space_row", rowId: "existing-row"), "did:alice")
        XCTAssertEqual(try library.listCommitted().first?["ownerUnknown"] as? Bool, false)
        let nextRow = "second-row"
        XCTAssertEqual(try library.claim(id, did: "did:alice", evidence: "space_row", rowId: nextRow), "did:alice")
        let ledger = try XCTUnwrap((library.readSidecar(id)["ledger"] as? [String: Any])?["audio"] as? [String: Any])
        XCTAssertEqual(ledger["rowId"] as? String, nextRow)
        XCTAssertEqual(ledger["state"] as? String, "saved")
        XCTAssertEqual((try library.readSidecar(id))["rev"] as? Int, 2)
    }

    func testClaimEvidenceErrorCodes() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let legacy = UUID().uuidString.lowercased()
        _ = try library.commit(legacy, sidecar: ["id": legacy, "durationMs": 1000]) {
            try Data("audio".utf8).write(to: $0)
        }
        XCTAssertThrowsError(try library.claim(legacy, did: "did:a", evidence: "space_row")) {
            XCTAssertEqual(($0 as? CaptureError)?.code, "row_id_required")
        }
        XCTAssertThrowsError(try library.claim(legacy, did: "did:a", evidence: "signed_out_v2")) {
            XCTAssertEqual(($0 as? CaptureError)?.code, "claim_evidence_required")
        }
        let modern = UUID().uuidString.lowercased()
        _ = try library.commit(modern, sidecar: sidecar(modern)) {
            try Data("audio".utf8).write(to: $0)
        }
        XCTAssertThrowsError(try library.claim(modern, did: "did:test", evidence: "space_row", rowId: "row")) {
            XCTAssertEqual(($0 as? CaptureError)?.code, "claim_evidence_invalid")
        }
        XCTAssertThrowsError(try library.claim(modern, did: "did:test", evidence: "unknown")) {
            XCTAssertEqual(($0 as? CaptureError)?.code, "claim_evidence_invalid")
        }
    }

    func testDeleteDuringGatedLegacyProbeCannotImport() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try Data("legacy".utf8).write(to: library.audioURL(id))
        let entered = DispatchSemaphore(value: 0), resume = DispatchSemaphore(value: 0)
        library.gate = { point in if point == "probe.afterLoad" { entered.signal(); resume.wait() } }
        let finished = expectation(description: "probe finished")
        DispatchQueue.global().async {
            defer { finished.fulfill() }
            do {
                try library.probeLegacy(id, load: { ["id": id, "legacyImport": true] })
                XCTFail("probe published after delete")
            } catch { XCTAssertEqual(error as? CaptureError, .tombstoned) }
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        try library.delete(id)
        resume.signal()
        wait(for: [finished], timeout: 5)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.audioURL(id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sidecarURL(id).path))
    }

    func testMalformedLegacySidecarIsQuarantinedBeforeImport() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try Data("legacy".utf8).write(to: library.audioURL(id))
        try Data("broken".utf8).write(to: library.sidecarURL(id))
        try library.probeLegacy(id) { ["id": id, "legacyImport": true, "ownerUnknown": true] }
        XCTAssertEqual(try library.readSidecar(id)["legacyImport"] as? Bool, true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.url("quarantine/\(id).sidecar.json").path))
    }

    func testRecoveryReplacesAudioLeftBeforeSidecarCommit() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        library.failpoint = { if $0 == "publish.sidecarRename" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.commit(id, sidecar: sidecar(id)) {
            try Data("unpublished".utf8).write(to: $0)
        })
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.audioURL(id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sidecarURL(id).path))
        let recovered = try RecordingLibrary(root: root)
        XCTAssertEqual(try recovered.recoverableSessions(), [id])
        _ = try recovered.commit(id, sidecar: sidecar(id)) {
            try Data("recovered".utf8).write(to: $0)
        }
        XCTAssertEqual(try Data(contentsOf: recovered.audioURL(id)), Data("recovered".utf8))
        XCTAssertEqual(try recovered.listCommitted().count, 1)
        XCTAssertTrue(try recovered.recoverableSessions().isEmpty)
    }

    func testCommitFailpointsRemainRecoverableOrCommitted() throws {
        for point in ["stage.write", "publish.m4aRename", "publish.sidecarTmp",
                      "publish.sidecarRename", "publish.gc"] {
            let (library, root) = try fixture()
            defer { try? FileManager.default.removeItem(at: root) }
            let id = UUID().uuidString.lowercased()
            try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                                 transitionGen: 0, options: CaptureOptions(), startedAt: 1))
            library.failpoint = { if $0 == point { throw CaptureError.io("injected \(point)") } }
            XCTAssertThrowsError(try library.commit(id, sidecar: sidecar(id)) {
                try Data("audio".utf8).write(to: $0)
            }, point)
            let relaunched = try RecordingLibrary(root: root)
            let sessions = try relaunched.recoverableSessions()
            if point == "publish.gc" {
                XCTAssertEqual(try relaunched.listCommitted().count, 1, point)
                XCTAssertEqual(sessions, [id], point)
                let existing = try relaunched.readSidecar(id)
                _ = try relaunched.commit(id, sidecar: sidecar(id)) {
                    try Data("new".utf8).write(to: $0)
                }
                XCTAssertEqual(try relaunched.readSidecar(id)["rev"] as? Int,
                               existing["rev"] as? Int, point)
            } else {
                XCTAssertEqual(sessions, [id], point)
                _ = try relaunched.commit(id, sidecar: sidecar(id)) {
                    try Data("recovered".utf8).write(to: $0)
                }
                XCTAssertEqual(try relaunched.listCommitted().count, 1, point)
            }
        }
    }

    func testDeleteDuringGatedTranscriptPublishCannotResurrect() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        _ = try library.commit(id, sidecar: sidecar(id)) { try Data("audio".utf8).write(to: $0) }
        let entered = DispatchSemaphore(value: 0), resume = DispatchSemaphore(value: 0)
        library.gate = { point in if point == "stt.beforePublish" { entered.signal(); resume.wait() } }
        let finished = expectation(description: "transcript finished")
        DispatchQueue.global().async {
            defer { finished.fulfill() }
            do {
                try library.putTranscript(id, object: ["text": "stale"])
                XCTFail("transcript published after delete")
            } catch { XCTAssertEqual(error as? CaptureError, .tombstoned) }
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        try library.delete(id)
        resume.signal()
        wait(for: [finished], timeout: 5)
        XCTAssertNil(try library.transcript(id))
    }

    func testOutboxFailureRetainsLedgerUntilRecoveryEnqueuesCleanup() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        var record = sidecar(id)
        record["ledger"] = ["remote": [["provider": "assemblyai", "mode": "hosted",
                                         "jobId": "job-1", "uploadId": "upload-1", "cleanup": "pending"]]]
        _ = try library.commit(id, sidecar: record) { try Data("audio".utf8).write(to: $0) }
        library.failpoint = { if $0 == "delete.outbox" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.delete(id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.sidecarURL(id).path))
        let relaunched = try RecordingLibrary(root: root)
        _ = try relaunched.recoverableSessions()
        let entries = try relaunched.listOutbox(did: "did:test")
        let kinds = entries.compactMap { $0["kind"] as? String }.sorted()
        XCTAssertEqual(kinds, ["hosted_upload", "transcript"])
        XCTAssertTrue(entries.allSatisfy { $0["receiptKind"] is NSNull })
        XCTAssertTrue(try relaunched.listCommitted().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: relaunched.audioURL(id).path))
    }

    func testLegacyUpgradeFixturesRemainHeldOrQuarantined() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let valid = UUID().uuidString.lowercased()
        try Data("old audio".utf8).write(to: library.audioURL(valid))
        try library.probeLegacy(valid) { ["id": valid, "version": 2, "rev": 1,
                                          "legacyImport": true, "ownerUnknown": true, "owner": NSNull()] }
        XCTAssertEqual(try library.readSidecar(valid)["ownerUnknown"] as? Bool, true)

        let invalid = UUID().uuidString.lowercased()
        try Data("no moov".utf8).write(to: library.audioURL(invalid))
        try library.probeLegacy(invalid) { nil }
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.audioURL(invalid).path))
        XCTAssertEqual(try library.listQuarantine().first?["reason"] as? String, "no_audio_track")

        let oldPair = UUID().uuidString.lowercased()
        _ = try library.commit(oldPair, sidecar: ["id": oldPair, "durationMs": 1000]) {
            try Data("old pair".utf8).write(to: $0)
        }
        XCTAssertEqual(try library.listCommitted().first(where: { $0["id"] as? String == oldPair })?["ownerUnknown"] as? Bool, true)
        XCTAssertThrowsError(try library.claim(oldPair, did: "did:b", evidence: "signed_out_v2"))
        XCTAssertEqual(try library.claim(oldPair, did: "did:a", evidence: "space_row", rowId: "a-existing-row"), "did:a")
        XCTAssertThrowsError(try library.claim(oldPair, did: "did:b", evidence: "space_row", rowId: "b-row"))
        XCTAssertEqual(try library.listCommitted().first(where: { $0["id"] as? String == oldPair })?["owner"] as? String, "did:a")

        let lostStorage = UUID().uuidString.lowercased()
        _ = try library.commit(lostStorage, sidecar: ["id": lostStorage, "durationMs": 1000]) {
            try Data("old".utf8).write(to: $0)
        }
        XCTAssertEqual(try library.listCommitted().first(where: { $0["id"] as? String == lostStorage })?["ownerUnknown"] as? Bool, true)

        let discarded = UUID().uuidString.lowercased()
        _ = try library.commit(discarded, sidecar: ["id": discarded, "durationMs": 1000]) {
            try Data("discarded".utf8).write(to: $0)
        }
        try library.delete(discarded)
        let relaunched = try RecordingLibrary(root: root)
        _ = try relaunched.recoverableSessions()
        XCTAssertFalse(try relaunched.listCommitted().contains { $0["id"] as? String == discarded })
    }
    func testAccountStateFailsClosedAndSurvivesRelaunch() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        try library.migrateLegacyAccount(CaptureDefaults(accountDid: "did:old", transitionGen: 4))
        XCTAssertEqual(try library.accountState().status, "transitioning")
        XCTAssertNil(try library.accountState().defaults.accountDid)
        library.failpoint = { if $0 == "account.tmp" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.setAccountState(CaptureAccountState(status: "signed_out", transitionGen: 5)))
        XCTAssertEqual(try RecordingLibrary(root: root).accountState().status, "transitioning")
        library.failpoint = { if $0 == "account.rename" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.setAccountState(CaptureAccountState(status: "signed_out", transitionGen: 5)))
        XCTAssertEqual(try RecordingLibrary(root: root).accountState().status, "transitioning")
        library.failpoint = nil
        try library.setAccountState(CaptureAccountState(status: "signed_out", transitionGen: 5))
        XCTAssertEqual(try RecordingLibrary(root: root).accountState().transitionGen, 5)
        XCTAssertThrowsError(try library.setAccountState(CaptureAccountState(status: "signed_in",
            accountDid: "did:old", transitionGen: 4)))
    }

    func testLateRemoteResultAfterDeleteKeepsDeterministicOutboxEntry() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased(), opId = "submit-1"
        try library.setAccountState(CaptureAccountState(status: "signed_in", accountDid: "did:test",
                                                        transitionGen: 1))
        _ = try library.commit(id, sidecar: sidecar(id)) { try Data("audio".utf8).write(to: $0) }
        let receipt: [String: Any] = ["id": id, "did": "did:test", "opId": opId,
            "provider": "assemblyai", "mode": "hosted", "kind": "hosted_submit",
            "fingerprint": "one", "startedAt": 100]
        library.failpoint = { if $0 == "receipt.begin" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.beginRemoteOp(receipt))
        let before = ((try library.readSidecar(id))["ledger"] as? [String: Any])?["remote"] as? [[String: Any]] ?? []
        XCTAssertFalse(before.contains { $0["opId"] as? String == opId })
        library.failpoint = nil
        try library.beginRemoteOp(receipt)
        library.failpoint = { if $0 == "delete.outbox" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.delete(id))
        library.failpoint = nil
        _ = try RecordingLibrary(root: root).recoverableSessions()
        library.failpoint = { if $0 == "receipt.result" { throw CaptureError.io("injected") } }
        XCTAssertThrowsError(try library.recordRemoteResult(id: id, did: "did:test", opId: opId,
            result: ["outcome": "created", "jobId": "job-late"]))
        library.failpoint = nil
        XCTAssertEqual(try library.recordRemoteResult(id: id, did: "did:test", opId: opId,
            result: ["outcome": "created", "jobId": "job-late"]), "outbox")
        let reloaded = try RecordingLibrary(root: root)
        let entry = try XCTUnwrap(reloaded.listOutbox(did: "did:test")
            .first(where: { $0["entryId"] as? String == "\(id):\(opId)" }))
        XCTAssertEqual(entry["handle"] as? String, "job-late")
        try reloaded.completeOutbox("\(id):\(opId)", result: "authority_expired")
        XCTAssertEqual(try reloaded.listOutbox(did: "did:test")
            .first(where: { $0["entryId"] as? String == "\(id):\(opId)" })?["state"] as? String,
            "authority_expired")
    }

    func testRepeatedRecoveryFailureQuarantinesUntilExplicitRetryOrDiscard() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        library.endLiveCapture(id)
        for _ in 0..<3 {
            let launch = try RecordingLibrary(root: root)
            XCTAssertTrue(try launch.recoverableSessions().contains(id))
            try launch.beginRecoveryAttempt(id)
            try launch.noteRecoveryFailure(id, reason: "corrupt journal")
        }
        XCTAssertFalse(try RecordingLibrary(root: root).recoverableSessions().contains(id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.url("quarantine/\(id).session").path))
        XCTAssertEqual(try library.listRecoveryFailures().first?["attempts"] as? Int, 3)
        XCTAssertFalse(try library.listQuarantine().contains { $0["id"] as? String == id })
        try library.prepareRecoveryRetry(id)
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.sessionURL(id).path))
        try library.discardFailedRecording(id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sessionURL(id).path))
    }

    func testDiscardRequiresFailedRecoveryAndDeletesOrphanAudio() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        XCTAssertThrowsError(try library.discardFailedRecording(id))
        library.endLiveCapture(id)
        XCTAssertThrowsError(try library.discardFailedRecording(id)) {
            XCTAssertEqual($0 as? CaptureError, .notFailedRecording)
        }
        try library.beginRecoveryAttempt(id)
        XCTAssertThrowsError(try library.discardFailedRecording(id))
        try library.noteRecoveryFailure(id, reason: "bad segment")
        try Data("partial audio".utf8).write(to: library.url("\(id).m4a"))
        try library.discardFailedRecording(id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.url("\(id).m4a").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sessionURL(id).path))
    }

    func testCrashDuringRecoveryCountsAcrossThreeLaunches() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        for attempt in 1...3 {
            let launch = try RecordingLibrary(root: root)
            XCTAssertTrue(try launch.recoverableSessions().contains(id))
            try launch.beginRecoveryAttempt(id)
            // Drop this library without reporting success or a thrown error: process death.
            let next = try RecordingLibrary(root: root)
            XCTAssertEqual(try next.listRecoveryFailures().first?["attempts"] as? Int, attempt)
        }
        let next = try RecordingLibrary(root: root)
        XCTAssertFalse(try next.recoverableSessions().contains(id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: next.url("quarantine/\(id).session").path))
        XCTAssertEqual(try next.listRecoveryFailures().first?["quarantined"] as? Bool, true)
    }

    func testRemoteReceiptsChooseLedgerOrOutboxAndAdvanceStages() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.setAccountState(CaptureAccountState(status: "signed_in", accountDid: "did:test", transitionGen: 1))
        _ = try library.commit(id, sidecar: sidecar(id)) { try Data("audio".utf8).write(to: $0) }
        func receipt(_ op: String, _ did: String = "did:test") -> [String: Any] {
            ["id": id, "did": did, "opId": op, "provider": "assemblyai", "mode": "hosted",
             "kind": "hosted_submit", "fingerprint": op, "startedAt": 100]
        }
        try library.beginRemoteOp(receipt("live"))
        var remote = ((try library.readSidecar(id))["ledger"] as? [String: Any])?["remote"] as? [[String: Any]] ?? []
        XCTAssertEqual(remote.first { $0["opId"] as? String == "live" }?["stage"] as? String, "submit_unknown")
        XCTAssertEqual(try library.recordRemoteResult(id: id, did: "did:test", opId: "live",
            result: ["outcome": "created", "jobId": "job-live"]), "ledger")
        remote = ((try library.readSidecar(id))["ledger"] as? [String: Any])?["remote"] as? [[String: Any]] ?? []
        XCTAssertEqual(remote.first { $0["opId"] as? String == "live" }?["stage"] as? String, "submitted")

        try library.setAccountState(CaptureAccountState(status: "transitioning", accountDid: "did:test", transitionGen: 2))
        try library.beginRemoteOp(receipt("transition"))
        try library.beginRemoteOp(receipt("wrong-owner", "did:other"))
        XCTAssertEqual(try library.recordRemoteResult(id: id, did: "did:other", opId: "wrong-owner",
            result: ["outcome": "created", "jobId": "job-other"]), "outbox")
        try library.setAccountState(CaptureAccountState(status: "signed_out", transitionGen: 3))
        try library.beginRemoteOp(receipt("signedout"))
        try library.delete(id)
        try library.beginRemoteOp(receipt("deleted"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.sidecarURL(id).path))
        _ = try RecordingLibrary(root: root).recoverableSessions()
        _ = try RecordingLibrary(root: root).recoverableSessions()
        let entries = try library.listOutbox(did: "did:test")
        for op in ["live", "transition", "signedout", "deleted"] {
            XCTAssertEqual(entries.filter { $0["entryId"] as? String == "\(id):\(op)" }.count, 1)
        }
        XCTAssertEqual(entries.first { $0["entryId"] as? String == "\(id):live" }?["kind"] as? String, "transcript")
        XCTAssertEqual(entries.first { $0["entryId"] as? String == "\(id):live" }?["state"] as? String, "pending")
        XCTAssertEqual(entries.first { $0["entryId"] as? String == "\(id):transition" }?["state"] as? String, "unknown")
        XCTAssertEqual(try library.listOutbox(did: "did:other").first?["handle"] as? String, "job-other")
        XCTAssertEqual(try library.recordRemoteResult(id: id, did: "did:test", opId: "deleted",
            result: ["outcome": "failed"]), "outbox")
        XCTAssertFalse(try library.listOutbox(did: "did:test").contains { $0["entryId"] as? String == "\(id):deleted" })
    }

    func testReceiptKindStageAndOutboxTable() throws {
        let cases: [(String, String, [String: Any], String, String)] = [
            ("hosted_create", "uploading", ["uploadId": "up"], "hosted_upload", "pending"),
            ("hosted_submit", "submitted", ["jobId": "job"], "transcript", "pending"),
            ("own_upload", "uploaded", ["uploadUrl": "https://example.test/a"], "own_upload_lookup", "lookup"),
            ("own_create", "submitted", ["jobId": "job"], "transcript", "pending"),
            ("ptx_create", "submitted", ["jobId": "job"], "ptx_job", "pending")]
        for (kind, stage, fields, outboxKind, state) in cases {
            let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
            let id = UUID().uuidString.lowercased()
            try library.setAccountState(CaptureAccountState(status: "signed_in", accountDid: "did:test", transitionGen: 1))
            _ = try library.commit(id, sidecar: sidecar(id)) { try Data("audio".utf8).write(to: $0) }
            try library.beginRemoteOp(["id": id, "did": "did:test", "opId": "op",
                "provider": kind == "ptx_create" ? "ptx" : "assemblyai",
                "mode": kind == "ptx_create" ? NSNull() as Any : (kind.hasPrefix("own") ? "own" : "hosted") as Any,
                "kind": kind, "fingerprint": "one", "startedAt": 100])
            var result = fields; result["outcome"] = "created"
            XCTAssertEqual(try library.recordRemoteResult(id: id, did: "did:test", opId: "op", result: result), "ledger")
            let remote = ((try library.readSidecar(id))["ledger"] as? [String: Any])?["remote"] as? [[String: Any]] ?? []
            XCTAssertEqual(remote.first { $0["opId"] as? String == "op" }?["stage"] as? String, stage)
            try library.delete(id)
            let entry = try XCTUnwrap(library.listOutbox(did: "did:test").first { $0["entryId"] as? String == "\(id):op" })
            XCTAssertEqual(entry["kind"] as? String, outboxKind)
            XCTAssertEqual(entry["receiptKind"] as? String, kind)
            XCTAssertEqual(entry["state"] as? String, state)
            XCTAssertEqual(entry["handle"] as? String, fields.values.first as? String)
            XCTAssertNil(entry["opKind"])
        }
    }

    func testOutboxResultsUseOriginalReceiptKindForGenericHandle() throws {
        let cases: [(kind: String, mode: String?, expectedKind: String, state: String)] = [
            ("hosted_create", "hosted", "hosted_upload", "pending"),
            ("hosted_submit", "hosted", "transcript", "pending"),
            ("own_upload", "own", "own_upload_lookup", "lookup"),
            ("own_create", "own", "transcript", "pending"),
            ("ptx_create", nil, "ptx_job", "pending")]
        for item in cases {
            let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
            let id = UUID().uuidString.lowercased()
            try library.beginRemoteOp(["id": id, "did": "did:test", "opId": "op",
                "provider": item.kind == "ptx_create" ? "ptx" : "assemblyai",
                "mode": item.mode as Any? ?? NSNull(), "kind": item.kind,
                "fingerprint": "one", "startedAt": 100])
            _ = try library.recordRemoteResult(id: id, did: "did:test", opId: "op",
                result: ["outcome": "created", "handle": "generic-handle"])
            let after = try XCTUnwrap(library.listOutbox(did: "did:test").first)
            XCTAssertEqual(after["kind"] as? String, item.expectedKind)
            XCTAssertEqual(after["receiptKind"] as? String, item.kind)
            XCTAssertEqual(after["state"] as? String, item.state)
            XCTAssertEqual(after["handle"] as? String, "generic-handle")
        }
    }

    func testRepeatedBeginRemoteOpPreservesResultAlreadyInOutbox() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        let receipt: [String: Any] = ["id": id, "did": "did:test", "opId": "create",
            "provider": "assemblyai", "mode": "own", "kind": "own_create",
            "fingerprint": "one", "startedAt": 100]
        try library.setAccountState(CaptureAccountState(status: "signed_in", accountDid: "did:test", transitionGen: 1))
        _ = try library.commit(id, sidecar: sidecar(id)) { try Data("audio".utf8).write(to: $0) }
        try library.setAccountState(CaptureAccountState(status: "transitioning", accountDid: "did:test", transitionGen: 2))
        try library.beginRemoteOp(receipt)
        XCTAssertEqual(try library.recordRemoteResult(id: id, did: "did:test", opId: "create",
            result: ["outcome": "created", "jobId": "job-42"]), "outbox")
        let path = library.url("outbox/\(id):create.json")
        let before = try Data(contentsOf: path)

        // This account can use the sidecar again, but the result still belongs to the outbox.
        try library.setAccountState(CaptureAccountState(status: "signed_in", accountDid: "did:test", transitionGen: 3))
        try library.beginRemoteOp(receipt)

        XCTAssertEqual(try Data(contentsOf: path), before)
        let entry = try XCTUnwrap(library.listOutbox(did: "did:test").first)
        XCTAssertEqual(entry["kind"] as? String, "transcript")
        XCTAssertEqual(entry["handle"] as? String, "job-42")
        let remote = ((try library.readSidecar(id))["ledger"] as? [String: Any])?["remote"] as? [[String: Any]] ?? []
        XCTAssertFalse(remote.contains { $0["opId"] as? String == "create" })
    }

    func testJournalRecoveryCarriesCaptureIntervalMarkers() throws {
        let recovered = try JournalRecovery(events: [
            ["e": "session", "t": Int64(100), "a": Int64(0)],
            ["e": "first_audio", "t": Int64(120), "a": Int64(0)],
            ["e": "capture_stopped", "t": Int64(400), "a": Int64(200)],
            ["e": "stop", "t": Int64(410), "a": Int64(200)]])
        XCTAssertEqual(recovered.firstAudioAt, 120)
        XCTAssertEqual(recovered.captureStoppedAt, 400)
    }

    func testOwnCreateURLLookupKeepsOriginalKindForLateJobHandle() throws {
        let (library, root) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased()
        try library.beginRemoteOp(["id": id, "did": "did:test", "opId": "create",
            "provider": "assemblyai", "mode": "own", "kind": "own_create",
            "fingerprint": "one", "startedAt": 100])
        _ = try library.recordRemoteResult(id: id, did: "did:test", opId: "create",
            result: ["outcome": "unknown", "uploadUrl": "https://example.test/audio"])
        let lookup = try XCTUnwrap(library.listOutbox(did: "did:test").first)
        XCTAssertEqual(lookup["kind"] as? String, "own_upload_lookup")
        XCTAssertEqual(lookup["receiptKind"] as? String, "own_create")
        _ = try library.recordRemoteResult(id: id, did: "did:test", opId: "create",
            result: ["outcome": "unknown"])
        XCTAssertEqual(try library.listOutbox(did: "did:test").first?["kind"] as? String,
                       "own_upload_lookup")
        _ = try library.recordRemoteResult(id: id, did: "did:test", opId: "create",
            result: ["outcome": "created", "handle": "job-42"])
        let job = try XCTUnwrap(library.listOutbox(did: "did:test").first)
        XCTAssertEqual(job["kind"] as? String, "transcript")
        XCTAssertEqual(job["receiptKind"] as? String, "own_create")
        XCTAssertEqual(job["handle"] as? String, "job-42")
        XCTAssertEqual(job["state"] as? String, "pending")
    }
}
