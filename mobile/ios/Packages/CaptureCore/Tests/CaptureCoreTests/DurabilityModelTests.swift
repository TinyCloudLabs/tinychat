import XCTest
@testable import CaptureCore

/// FileOps model: write reaches the OS cache, barrier sync persists it for process death,
/// and full sync persists it across a simulated power cut. crash() discards unsynced bytes.
private final class InMemoryFileOps {
    private var live: [String: Data] = [:]
    private var disk: [String: Data] = [:]

    func append(_ bytes: Data, to path: String) { live[path, default: Data()].append(bytes) }
    func sync(_ path: String, full: Bool) {
        if full { disk[path] = live[path, default: Data()] }
    }
    func crash(powerLoss: Bool) {
        if powerLoss { live = disk }
        // Process death retains the kernel's completed writes in live.
    }
    func read(_ path: String) -> Data { live[path, default: Data()] }
}

final class DurabilityModelTests: XCTestCase {
    func testPowerCutLosesAtMostOneFullSyncWindowAndJournalNeverLeadsAudio() throws {
        let frame = Data(try ADTS.header(payloadBytes: 100)) + Data(repeating: 0, count: 100)
        // Crash at every quarter-second of a 21-second capture, including on a full-sync boundary.
        for cut in 1...84 {
            let files = InMemoryFileOps()
            let segment = "seg-00000.aac", journal = "journal.jsonl"
            var total = 0
            for tick in 1...cut {
                // Twelve complete AAC frames per 250 ms batch (a little over real-time).
                for _ in 0..<12 { files.append(frame, to: segment); total += 1 }
                if tick % 8 == 0 {
                    files.sync(segment, full: tick % 40 == 0)
                    files.append(Data("hb:\(total)\n".utf8), to: journal)
                    files.sync(journal, full: tick % 40 == 0)
                }
            }
            files.crash(powerLoss: true)
            let durableFrames = ADTS.fullFrameCount(files.read(segment))
            let lostMs = (total - durableFrames) * 1024 * 1000 / 48_000
            XCTAssertLessThanOrEqual(lostMs, 10_100, "cut tick \(cut)")
            let lines = String(decoding: files.read(journal), as: UTF8.self).split(separator: "\n")
            if let last = lines.last, let journalFrames = Int(last.dropFirst(3)) {
                XCTAssertLessThanOrEqual(journalFrames, durableFrames, "journal leads audio at tick \(cut)")
            }
        }
    }

    func testProcessDeathRetainsCompletedWritesButTornLastJournalLineIsIgnored() throws {
        let files = InMemoryFileOps()
        let frame = Data(try ADTS.header(payloadBytes: 100)) + Data(repeating: 0, count: 100)
        files.append(frame, to: "seg")
        files.append(Data("{\"a\":0,\"e\":\"session\",\"t\":1}\n".utf8), to: "journal")
        files.append(Data("{\"e\":\"hb\"".utf8), to: "journal")
        files.crash(powerLoss: false)
        XCTAssertEqual(ADTS.fullFrameCount(files.read("seg")), 1)
        XCTAssertEqual(try JournalCodec.read(files.read("journal")).count, 1)
    }
}
