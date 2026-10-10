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

    func testFileModeSelectsBundledClipsAndRejectsUnknownNames() throws {
        XCTAssertEqual(try SimulatorSilentInput.mode(environment: ["EXO_SIM_AUDIO_INPUT": "file:speech"]), .file(.speech))
        XCTAssertEqual(try SimulatorSilentInput.mode(environment: ["EXO_SIM_AUDIO_INPUT": "file:sweep"]), .file(.sweep))
        for bad in ["file", "file:", "file:Speech", "file:/tmp/x.wav", "file:speech.wav"] {
            XCTAssertThrowsError(try SimulatorSilentInput.mode(environment: ["EXO_SIM_AUDIO_INPUT": bad]), bad)
        }
    }

    func testSpeechClipDecodesTo48kMonoWithRealSignal() throws {
        let samples = try SimulatorSilentInput.samples(for: .speech)
        let seconds = Double(samples.count) / 48_000
        XCTAssertGreaterThan(seconds, 2)
        XCTAssertLessThan(seconds, 8)
        let peak = samples.map { abs($0) }.max() ?? 0
        XCTAssertGreaterThan(peak, 0.1)
        XCTAssertLessThanOrEqual(peak, 1)
        // Speech has pauses and loud words, not a constant tone.
        let windows = stride(from: 0, to: samples.count - 4_800, by: 4_800).map { start in
            samples[start..<start + 4_800].map { abs($0) }.max() ?? 0
        }
        XCTAssertGreaterThan(windows.max()! / max(windows.min()!, 1e-6), 10)
    }

    func testSweepClipKeepsItsSteppedLevelsAfterConversion() throws {
        let samples = try SimulatorSilentInput.samples(for: .sweep)
        XCTAssertEqual(samples.count, 7 * 48_000, accuracy: 2_000)
        let levels = [-40.0, -34, -28, -22, -16, -10, -6]
        for (step, db) in levels.enumerated() {
            let from = step * 48_000 + 4_800, to = (step + 1) * 48_000 - 4_800
            let peak = Double(samples[from..<to].map { abs($0) }.max() ?? 0)
            XCTAssertEqual(20 * log10(peak), db, accuracy: 1.0, "step \(step)")
        }
    }

    func testManualSourceLoopsClipSamplesContiguously() {
        let clip: [Float] = (0..<1_500).map { Float($0 + 1) / 2_000 }
        let lock = NSLock()
        var heard: [Float] = []
        let source = SimulatorSilentInput(manual: true, samples: clip) { buffer, _ in
            lock.lock()
            heard += UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
            lock.unlock()
        }
        source.start()
        source.deliver(buffers: 4) // 4096 frames wraps the 1500-sample clip almost three times
        source.stop()
        lock.lock(); defer { lock.unlock() }
        XCTAssertEqual(heard.count, 4_096)
        XCTAssertEqual(heard, (0..<4_096).map { clip[$0 % 1_500] })
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

    func testManualSourceDeliversOnlyWhenDrivenAndNothingAfterStop() {
        let lock = NSLock()
        var starts: [AVAudioFramePosition] = []
        let source = SimulatorSilentInput(manual: true) { _, when in
            lock.lock(); starts.append(when.sampleTime); lock.unlock()
        }
        source.deliver(buffers: 2) // Not started: nothing.
        source.start()
        XCTAssertTrue(source.isRunning)
        Thread.sleep(forTimeInterval: 0.2) // A manual source never ticks on its own.
        lock.lock(); XCTAssertTrue(starts.isEmpty); lock.unlock()
        source.deliver(buffers: 3)
        source.stop()
        XCTAssertFalse(source.isRunning)
        source.deliver(buffers: 3)
        lock.lock(); XCTAssertEqual(starts, [0, 1024, 2048]); lock.unlock()
    }

    @MainActor func testTestRootEngineUsesManualSourceThatNeverTicksOnItsOwn() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-sim-manual-\(UUID().uuidString)")
        let engine = try CaptureEngine(testRoot: root)
        engine.debugForeground = true
        defer {
            _ = try? engine.discard()
            try? FileManager.default.removeItem(at: root)
        }
        _ = try engine.start()
        XCTAssertTrue(engine.debugSilentInputRunning)
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(engine.status()["audioMs"] as? Int64 ?? 0, 0)
        engine.debugDeliverSilentTaps(10)
        XCTAssertTrue(engine.debugSilentInputRunning)
    }

    @MainActor func testEngineRecordsSyntheticSilenceThroughPauseResumeAndStop() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-sim-silence-\(UUID().uuidString)")
        let engine = try CaptureEngine(testRoot: root)
        engine.debugForeground = true
        engine.debugRealTimeSilentInput = true
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

    @MainActor private func startCountingAcquisition(environment: [String: String],
                                                     inspect: ((CaptureEngine) throws -> Void)? = nil) throws -> (acquisitions: Int, error: Error?) {
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
        try inspect?(engine)
        return (acquisitions, nil)
    }

    @MainActor func testSilenceNeverAcquiresHardwareSession() throws {
        for environment in [[:], ["EXO_SIM_AUDIO_INPUT": "silence"]] as [[String: String]] {
            let result = try startCountingAcquisition(environment: environment)
            XCTAssertEqual(result.acquisitions, 0)
            XCTAssertNil(result.error)
        }
    }

    @MainActor func testFileModeNeverAcquiresHardwareAndNamesTheClip() throws {
        for clip in SimulatorSilentInput.Clip.allCases {
            let result = try startCountingAcquisition(environment: ["EXO_SIM_AUDIO_INPUT": "file:\(clip.rawValue)"]) { engine in
                XCTAssertTrue(engine.debugSilentInputRunning)
                let input = engine.status()["input"] as? [String: Any]
                XCTAssertEqual(input?["name"] as? String, "Simulator file: \(clip.rawValue) (debug)")
                XCTAssertEqual(input?["id"] as? String, "exo-sim-file-\(clip.rawValue)")
                engine.debugDeliverSilentTaps(5)
                XCTAssertEqual(engine.status()["state"] as? String, "recording")
            }
            XCTAssertEqual(result.acquisitions, 0)
            XCTAssertNil(result.error)
        }
    }

    @MainActor func testUnknownClipIsRejectedBeforeAnyAcquisition() throws {
        let result = try startCountingAcquisition(environment: ["EXO_SIM_AUDIO_INPUT": "file:nope"])
        XCTAssertEqual(result.acquisitions, 0)
        XCTAssertNotNil(result.error)
        XCTAssertFalse(result.error is AcquisitionAttempted)
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
