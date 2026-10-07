import AVFoundation
import CaptureCore
import XCTest
@testable import ExoCapture

final class AacAdtsWriterTests: XCTestCase {
    private func pcm(_ frames: AVAudioFrameCount = 4096) throws -> AVAudioPCMBuffer {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        if let samples = buffer.floatChannelData?[0] {
            for i in 0..<Int(frames) { samples[i] = Float(sin(Double(i) * 2 * .pi * 440 / 48_000)) * 0.1 }
        }
        return buffer
    }

    func testLateTapBufferCannotCrossPauseResumeBoundary() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try RecordingLibrary(root: root)
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        let openedAt = wallMilliseconds()
        try library.openFirstSegment(id, at: openedAt)
        let writer = try AacAdtsWriter(library: library, id: id, segmentOpenedAt: openedAt)
        writer.setGeneration(1)
        writer.enqueue(try pcm(), generation: 1)
        let first = try writer.closeForPause()
        writer.enqueue(try pcm(), generation: 1) // callback scheduled before engine.stop, delivered afterwards
        try writer.reopen()
        writer.setGeneration(2)
        writer.enqueue(try pcm(), generation: 1) // stale callback after Resume
        writer.enqueue(try pcm(), generation: 2)
        let second = try writer.finish(at: wallMilliseconds())
        XCTAssertGreaterThan(first.audioMs, 0)
        XCTAssertGreaterThan(second.audioMs, first.audioMs)
        XCTAssertEqual(writer.rejectedStaleFrames, 8192)
        XCTAssertGreaterThan(ADTS.fullFrameCount(try Data(contentsOf: library.segmentURL(id, index: 0))), 0)
        XCTAssertGreaterThan(ADTS.fullFrameCount(try Data(contentsOf: library.segmentURL(id, index: 1))), 0)
    }

    func testOversizedBufferIsDroppedWithoutFailingWriter() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try RecordingLibrary(root: root)
        let id = UUID().uuidString.lowercased()
        try library.startSession(SessionInfo(id: id, source: "in_app", owner: nil,
                                             transitionGen: 0, options: CaptureOptions(), startedAt: 1))
        let openedAt = wallMilliseconds()
        try library.openFirstSegment(id, at: openedAt)
        let writer = try AacAdtsWriter(library: library, id: id, segmentOpenedAt: openedAt)
        writer.setGeneration(1)
        var failed = false
        var stallStates: [Bool] = []
        writer.onFailure = { _ in failed = true }
        writer.onStall = { active, _ in stallStates.append(active) }
        writer.enqueue(try pcm(500_000), generation: 1)
        XCTAssertEqual(writer.droppedStallFrames, 500_000)
        writer.enqueue(try pcm(), generation: 1)
        XCTAssertGreaterThan(try writer.finish(at: wallMilliseconds()).audioMs, 0)
        XCTAssertFalse(failed)
        XCTAssertEqual(stallStates, [true, false])
    }
}
