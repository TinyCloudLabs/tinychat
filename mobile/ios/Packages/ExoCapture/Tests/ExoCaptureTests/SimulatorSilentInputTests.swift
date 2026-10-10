#if DEBUG && targetEnvironment(simulator)
import AVFoundation
import CaptureCore
import XCTest
@testable import ExoCapture

final class SimulatorSilentInputTests: XCTestCase {
    func testModeDefaultsToSilenceAndRejectsUnknownValues() throws {
        XCTAssertEqual(try SimulatorSilentInput.mode(environment: [:]), .silence)
        XCTAssertEqual(try SimulatorSilentInput.mode(environment: ["EXO_SIM_AUDIO_INPUT": "silence"]), .silence)
        XCTAssertEqual(try SimulatorSilentInput.mode(environment: ["EXO_SIM_AUDIO_INPUT": "host"]), .host)
        XCTAssertThrowsError(try SimulatorSilentInput.mode(environment: ["EXO_SIM_AUDIO_INPUT": "Host"]))
        XCTAssertThrowsError(try SimulatorSilentInput.mode(environment: ["EXO_SIM_AUDIO_INPUT": "file:/tmp/x.wav"]))
    }

    func testSourceDeliversContiguousSilentBuffersInRealTimeAndStopsCleanly() throws {
        let lock = NSLock()
        var starts: [AVAudioFramePosition] = []
        var allZero = true
        var shape = true
        let source = SimulatorSilentInput { buffer, when in
            let samples = UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
            lock.lock()
            starts.append(when.sampleTime)
            if samples.contains(where: { $0 != 0 }) { allZero = false }
            if buffer.frameLength != 1024 || buffer.format.sampleRate != 48_000 || buffer.format.channelCount != 1 {
                shape = false
            }
            lock.unlock()
        }
        let began = ProcessInfo.processInfo.systemUptime
        source.start()
        XCTAssertTrue(source.isRunning)
        Thread.sleep(forTimeInterval: 0.5)
        source.stop()
        let elapsed = ProcessInfo.processInfo.systemUptime - began
        XCTAssertFalse(source.isRunning)
        lock.lock()
        let delivered = starts
        let zero = allZero, shaped = shape
        lock.unlock()
        let expected = Int(elapsed * 48_000 / 1024)
        XCTAssertTrue(zero)
        XCTAssertTrue(shaped)
        XCTAssertEqual(delivered, (0..<delivered.count).map { AVAudioFramePosition($0 * 1024) })
        XCTAssertGreaterThanOrEqual(delivered.count, expected - 3)
        XCTAssertLessThanOrEqual(delivered.count, expected + 1)
        Thread.sleep(forTimeInterval: 0.1)
        lock.lock(); XCTAssertEqual(starts.count, delivered.count); lock.unlock()
    }

    @MainActor func testEngineRecordsSyntheticSilenceThroughPauseResumeAndStop() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-sim-silence-\(UUID().uuidString)")
        let engine = try CaptureEngine(testRoot: root)
        engine.debugForeground = true
        defer {
            _ = try? engine.discard()
            try? FileManager.default.removeItem(at: root)
        }
        let id = try XCTUnwrap(engine.start()["id"] as? String)
        XCTAssertTrue(engine.debugSilentInputRunning)
        XCTAssertEqual((engine.status()["input"] as? [String: Any])?["name"] as? String, "Simulator silence (debug)")
        Thread.sleep(forTimeInterval: 0.6)
        try engine.pause()
        XCTAssertFalse(engine.debugSilentInputRunning)
        XCTAssertEqual(engine.status()["state"] as? String, "paused")
        let pausedAudio = try XCTUnwrap(engine.status()["audioMs"] as? Int64)
        XCTAssertGreaterThan(pausedAudio, 300)
        try engine.resume()
        XCTAssertTrue(engine.debugSilentInputRunning)
        XCTAssertEqual(engine.status()["state"] as? String, "recording")
        Thread.sleep(forTimeInterval: 0.6)
        // The session directory is removed at commit, so read the journal while still recording.
        let journal = try engine.library.readJournal(id)
        let stopped = expectation(description: "stop committed")
        var committed: [String: Any]?
        engine.stop { result in
            if case .success(let note) = result { committed = note } else { XCTFail("Stop failed: \(result)") }
            stopped.fulfill()
        }
        XCTAssertFalse(engine.debugSilentInputRunning)
        wait(for: [stopped], timeout: 30)
        XCTAssertEqual(committed?["id"] as? String, id)
        XCTAssertGreaterThan(committed?["durationMs"] as? Int64 ?? 0, pausedAudio)
        XCTAssertGreaterThanOrEqual(journal.filter { $0["e"] as? String == "segment" }.count, 2)
        XCTAssertTrue(journal.contains { $0["e"] as? String == "hb" || $0["e"] as? String == "first_audio" })
    }

    private struct AcquisitionAttempted: Error {}

    @MainActor private func startCountingAcquisition(environment: [String: String]) throws -> (acquisitions: Int, error: Error?) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-sim-mode-\(UUID().uuidString)")
        let engine = try CaptureEngine(testRoot: root)
        engine.debugForeground = true
        engine.debugInputEnvironment = environment
        var acquisitions = 0
        // Host acquisition is replaced by a sentinel throw so this test never opens the Mac mic.
        engine.debugHardwareAcquisition = { acquisitions += 1; throw AcquisitionAttempted() }
        defer {
            _ = try? engine.discard()
            try? FileManager.default.removeItem(at: root)
        }
        do { _ = try engine.start() } catch { return (acquisitions, error) }
        return (acquisitions, nil)
    }

    @MainActor func testSilenceNeverAcquiresHardwareSession() throws {
        for environment in [[:], ["EXO_SIM_AUDIO_INPUT": "silence"]] as [[String: String]] {
            let result = try startCountingAcquisition(environment: environment)
            XCTAssertEqual(result.acquisitions, 0)
            XCTAssertNil(result.error)
        }
    }

    @MainActor func testInvalidModeIsRejectedBeforeAnyAcquisition() throws {
        let result = try startCountingAcquisition(environment: ["EXO_SIM_AUDIO_INPUT": "mic"])
        XCTAssertEqual(result.acquisitions, 0)
        XCTAssertNotNil(result.error)
        XCTAssertFalse(result.error is AcquisitionAttempted)
    }

    @MainActor func testHostModeAcquiresHardwareSession() throws {
        let result = try startCountingAcquisition(environment: ["EXO_SIM_AUDIO_INPUT": "host"])
        XCTAssertEqual(result.acquisitions, 1)
        XCTAssertTrue(result.error is AcquisitionAttempted)
    }
}
#endif
