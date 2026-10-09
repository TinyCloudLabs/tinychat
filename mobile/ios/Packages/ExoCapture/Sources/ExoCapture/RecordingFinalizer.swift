import AVFoundation
import CaptureCore
import Foundation
import OSLog

public enum RecordingFinalizer {
    private static let log = Logger(subsystem: "xyz.tinycloud.exo", category: "capture.finalizer")
    private final class MuxOutcome {
        private let lock = NSLock()
        private var result: Result<Void, Error>?
        private var abandoned = false

        func complete(_ value: Result<Void, Error>) -> Bool {
            lock.lock(); defer { lock.unlock() }
            result = value
            return abandoned
        }

        func abandon() {
            lock.lock(); abandoned = true; lock.unlock()
        }

        func value() -> Result<Void, Error>? {
            lock.lock(); defer { lock.unlock() }
            return result
        }
    }
    // The real AVFoundation objects remain in use. Tests can hold either wait open
    // and make cancellation block, without relying on a simulator's encoder timing.
    struct WaitSeam {
        var beforeMuxWorker: (() -> Void)?
        var isReady: (AVAssetWriterInput) -> Bool = { $0.isReadyForMoreMediaData }
        var cancelWriting: (AVAssetWriter) -> Void = { $0.cancelWriting() }
    }

    static func awaitFinishWriting(waitTimeout: TimeInterval,
                                   finish: (@escaping () -> Void) -> Void) throws {
        let done = DispatchSemaphore(value: 0)
        finish { done.signal() }
        guard done.wait(timeout: .now() + waitTimeout) == .success else {
            log.error("mux stage=finish_writing outcome=timeout")
            throw CaptureError.finalizationTimedOut("finish_writing")
        }
    }
    /// AVFoundation understands ADTS AAC as an asset. Export to MPEG-4 is performed outside
    /// RecordingLibrary's lock; the library publishes the resulting file only after revalidation.
    public static func mux(segments: [URL], expectedAudioMs: Int64, to output: URL,
                           waitTimeout: TimeInterval = 30) throws {
        try mux(segments: segments, expectedAudioMs: expectedAudioMs, to: output,
                waitTimeout: waitTimeout, seam: WaitSeam())
    }

    static func mux(segments: [URL], expectedAudioMs: Int64, to output: URL,
                    waitTimeout: TimeInterval, seam: WaitSeam,
                    operationTimeout overrideTimeout: TimeInterval? = nil) throws {
        guard !segments.isEmpty else { throw CaptureError.noAudio }
        guard waitTimeout > 0 else { throw CaptureError.invalidArgument }
        // AVFoundation can also block synchronously in track lookup, startWriting,
        // sample copying or append. Keep the whole mux off Stop's worker, with time
        // scaled for long notes. A late worker may finish only to discard its staged
        // output; RecordingLibrary never publishes it after this call throws.
        let operationTimeout = overrideTimeout ?? max(60, min(600, Double(expectedAudioMs) / 30_000))
        guard operationTimeout > 0 else { throw CaptureError.invalidArgument }
        let finished = DispatchSemaphore(value: 0)
        let outcome = MuxOutcome()
        DispatchQueue.global(qos: .userInitiated).async {
            seam.beforeMuxWorker?()
            let result = Result {
                try muxWorker(segments: segments, expectedAudioMs: expectedAudioMs,
                              to: output, waitTimeout: waitTimeout, seam: seam)
            }
            if outcome.complete(result) { try? FileManager.default.removeItem(at: output) }
            finished.signal()
        }
        guard finished.wait(timeout: .now() + operationTimeout) == .success else {
            outcome.abandon()
            log.error("mux stage=operation outcome=timeout timeoutSeconds=\(operationTimeout)")
            throw CaptureError.finalizationTimedOut("mux")
        }
        guard let result = outcome.value() else { throw CaptureError.io("mux finished without result") }
        try result.get()
    }

    private static func muxWorker(segments: [URL], expectedAudioMs: Int64, to output: URL,
                                  waitTimeout: TimeInterval, seam: WaitSeam) throws {
        // A single ADTS stream avoids charging a separate decoder priming gap to every
        // segment after Pause or an interruption.
        let combined = output.deletingPathExtension().appendingPathExtension("combined.aac")
        guard FileManager.default.createFile(atPath: combined.path, contents: nil) else {
            throw CaptureError.io("create combined AAC stream")
        }
        defer { try? FileManager.default.removeItem(at: combined) }
        let combinedHandle = try FileHandle(forWritingTo: combined)
        var completeFrames = 0
        for segment in segments {
            let data = try Data(contentsOf: segment)
            let prefix = ADTS.completePrefix(data)
            guard prefix.frames > 0 else { continue }
            try combinedHandle.write(contentsOf: data.prefix(prefix.bytes))
            completeFrames += prefix.frames
        }
        try combinedHandle.close()
        guard completeFrames > 0 else { throw CaptureError.noAudio }
        let source = AVURLAsset(url: combined)
        log.notice("mux stage=track_lookup outcome=start frames=\(completeFrames)")
        guard let track = source.tracks(withMediaType: .audio).first else { throw CaptureError.noAudio }
        log.notice("mux stage=track_lookup outcome=completed")
        let reader = try AVAssetReader(asset: source)
        let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ])
        guard reader.canAdd(readerOutput) else { throw CaptureError.io("AAC reader cannot read composition") }
        reader.add(readerOutput)
        let writer = try AVAssetWriter(outputURL: output, fileType: .m4a)
        let writerInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
        ])
        writerInput.expectsMediaDataInRealTime = false
        guard writer.canAdd(writerInput) else { throw CaptureError.io("MPEG-4 writer cannot accept AAC") }
        writer.add(writerInput)
        log.notice("mux stage=reader_start outcome=start")
        guard reader.startReading() else { throw reader.error ?? CaptureError.io("start AAC reader") }
        log.notice("mux stage=reader_start outcome=completed")
        log.notice("mux stage=writer_start outcome=start")
        guard writer.startWriting() else {
            throw reader.error ?? writer.error ?? CaptureError.io("start AAC remux")
        }
        log.notice("mux stage=writer_start outcome=completed")
        var completed = false
        defer {
            if !completed {
                // AVAssetWriter.cancelWriting may itself block forever. Neither Stop nor
                // recovery waits for this best-effort cleanup; the staged path is removed
                // by RecordingLibrary.commit on failure, while segments remain intact.
                DispatchQueue.global(qos: .utility).async {
                    seam.cancelWriting(writer)
                    reader.cancelReading()
                }
            }
        }
        writer.startSession(atSourceTime: .zero)
        log.notice("mux stage=append_start frames=\(completeFrames) segments=\(segments.count)")
        // A stalled AVAssetWriter must release Stop; RecordingLibrary keeps the source segments.
        var samples = 0
        var readyWaits = 0
        while let sample = readerOutput.copyNextSampleBuffer() {
            let waitStarted = ProcessInfo.processInfo.systemUptime
            var loggedWait = false
            while !seam.isReady(writerInput) {
                readyWaits += 1
                if !loggedWait && ProcessInfo.processInfo.systemUptime - waitStarted >= 1 {
                    log.notice("mux stage=ready_wait sample=\(samples) elapsedMs=\(Int((ProcessInfo.processInfo.systemUptime - waitStarted) * 1000))")
                    loggedWait = true
                }
                guard writer.status == .writing else { throw writer.error ?? CaptureError.io("AAC remux stopped") }
                guard ProcessInfo.processInfo.systemUptime - waitStarted < waitTimeout else {
                    log.error("mux stage=ready_wait outcome=timeout sample=\(samples)")
                    throw CaptureError.finalizationTimedOut("ready_wait")
                }
                Thread.sleep(forTimeInterval: 0.005)
            }
            guard writerInput.append(sample) else { throw writer.error ?? CaptureError.io("append AAC packet") }
            samples += 1
        }
        guard reader.status == .completed else { throw reader.error ?? CaptureError.io("read AAC packets") }
        writer.endSession(atSourceTime: CMTime(value: expectedAudioMs, timescale: 1000))
        log.notice("mux stage=mark_finished samples=\(samples) readyWaits=\(readyWaits)")
        writerInput.markAsFinished()
        log.notice("mux stage=finish_writing outcome=start")
        try awaitFinishWriting(waitTimeout: waitTimeout) { writer.finishWriting(completionHandler: $0) }
        guard writer.status == .completed else { throw writer.error ?? CaptureError.io("finish MPEG-4") }
        completed = true
        log.notice("mux stage=finish_writing outcome=completed samples=\(samples)")
    }

    public static func segments(in folder: URL) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "aac" && $0.lastPathComponent.hasPrefix("seg-") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}
